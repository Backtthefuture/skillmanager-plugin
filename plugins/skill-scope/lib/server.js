// skill-scope local Dashboard server (dependency-free, 127.0.0.1 only).
import http from 'http'
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { fileURLToPath } from 'url'
import { spawn } from 'child_process'
import * as policy from './policy.js'
import * as skills from './skills.js'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = JSON.parse(fsSync.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'))
const VERSION = PACKAGE.version
const STATIC_ROOT = path.join(PLUGIN_ROOT, 'web')
const DEFAULT_PORT = 3838
const LAUNCH_TTL_MS = 60 * 1000
const SESSION_TTL_MS = 2 * 60 * 60 * 1000
const SESSION_COOKIE = 'skill-scope-session'

function stateFile(ctx) {
  return path.join(ctx.dataDir, 'runtime', 'dashboard-state.json')
}

function defaultPort() {
  const parsed = Number(process.env.SKILL_SCOPE_DASHBOARD_PORT || DEFAULT_PORT)
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : DEFAULT_PORT
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

async function readState(ctx) {
  try {
    return JSON.parse(await fs.readFile(stateFile(ctx), 'utf8'))
  } catch {
    return null
  }
}

function processAlive(pid) {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

export async function dashboardStatus(ctx = policy.resolveContext()) {
  const state = await readState(ctx)
  if (!state || !state.pid || !processAlive(state.pid)) {
    return { schemaVersion: 1, status: 'stopped', reason: 'no_runtime_state' }
  }
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/api/health`)
    if (response.ok) {
      const health = await response.json()
      return { schemaVersion: 1, status: 'running', pid: state.pid, port: state.port, baseUrl: state.baseUrl, startedAt: state.startedAt, version: state.version, health }
    }
  } catch {
  }
  return { schemaVersion: 1, status: 'stale', pid: state.pid, port: state.port, reason: 'process_alive_but_unhealthy' }
}

async function startServerProcess({ port, controlToken, ctx }) {
  const entry = path.join(PLUGIN_ROOT, 'bin', 'skill-scope-dashboard.js')
  const child = spawn(process.execPath, [entry], {
    detached: true,
    stdio: 'ignore',
    env: {
      ...process.env,
      SKILL_SCOPE_DASHBOARD_PORT: String(port),
      SKILL_SCOPE_CONTROL_TOKEN: controlToken,
      SKILL_SCOPE_DATA_DIR: ctx.dataDir,
      CODEX_HOME: ctx.codexHome
    }
  })
  child.unref()
  return child
}

async function waitForHealth(baseUrl, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${baseUrl}/api/health`)
      if (response.ok) return true
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return false
}

export async function openDashboard({ port = null, openBrowser = true, ctx = policy.resolveContext() } = {}) {
  const status = await dashboardStatus(ctx)
  let state
  if (status.status === 'running') {
    state = await readState(ctx)
  } else {
    const actualPort = port || defaultPort()
    const controlToken = crypto.randomBytes(32).toString('base64url')
    await startServerProcess({ port: actualPort, controlToken, ctx })
    state = await readState(ctx)
    if (!state) {
      for (let attempt = 0; attempt < 40 && !state; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, 250))
        state = await readState(ctx)
      }
    }
    if (!state) throw new policy.PolicyError('DASHBOARD_START_FAILED', 'Dashboard server did not write runtime state')
    const healthy = await waitForHealth(state.baseUrl)
    if (!healthy) throw new policy.PolicyError('DASHBOARD_UNHEALTHY', 'Dashboard server started but /api/health did not respond')
  }
  const launchResponse = await fetch(`${state.baseUrl}/api/session/launch`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${state.controlToken}`
    },
    body: JSON.stringify({ target: '/' })
  })
  if (!launchResponse.ok) {
    throw new policy.PolicyError('LAUNCH_FAILED', `Dashboard launch failed: ${launchResponse.status}`)
  }
  const launch = await launchResponse.json()
  if (openBrowser && process.env.SKILL_SCOPE_NO_OPEN !== '1') {
    const command = process.platform === 'darwin' ? 'open'
      : process.platform === 'win32' ? 'cmd'
        : 'xdg-open'
    const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'start', '', launch.launchUrl] : [launch.launchUrl]
    spawn(command, args, { detached: true, stdio: 'ignore' }).unref()
  }
  return {
    schemaVersion: 1,
    ok: true,
    launchUrl: launch.launchUrl,
    expiresInSeconds: launch.expiresInSeconds,
    port: state.port,
    reused: status.status === 'running',
    opened: Boolean(openBrowser && process.env.SKILL_SCOPE_NO_OPEN !== '1')
  }
}

export async function stopDashboard(ctx = policy.resolveContext()) {
  const status = await dashboardStatus(ctx)
  if (status.status === 'stopped') {
    return { schemaVersion: 1, ok: true, stopped: false, reason: 'already_stopped' }
  }
  const state = await readState(ctx)
  if (state?.pid && processAlive(state.pid)) {
    try {
      process.kill(state.pid, 'SIGTERM')
    } catch {
    }
  }
  for (let attempt = 0; attempt < 40; attempt++) {
    if (!fsSync.existsSync(stateFile(ctx))) break
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  return { schemaVersion: 1, ok: true, stopped: true, port: state?.port || null }
}

function sendJson(response, statusCode, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  })
  response.end(body)
}

function sendError(response, statusCode, code, error) {
  sendJson(response, statusCode, { ok: false, code, error })
}

async function readBody(request) {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString('utf8')
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch {
    throw new policy.PolicyError('INVALID_JSON', 'Request body must be valid JSON')
  }
}

function parseCookies(request) {
  const header = request.headers.cookie || ''
  const cookies = {}
  for (const part of header.split(';')) {
    const index = part.indexOf('=')
    if (index === -1) continue
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim())
  }
  return cookies
}

function isLoopbackHost(host) {
  const value = String(host || '').split(':')[0]
  return value === '127.0.0.1' || value === 'localhost' || value === '::1'
}

function originMatchesHost(request) {
  const origin = request.headers.origin
  if (!origin) return true
  try {
    const url = new URL(origin)
    return isLoopbackHost(url.hostname) && url.port === String(request.socket.localPort)
  } catch {
    return false
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
}

async function serveStatic(request, response, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const filePath = path.resolve(STATIC_ROOT, relative)
  if (!filePath.startsWith(path.resolve(STATIC_ROOT) + path.sep) && filePath !== path.resolve(STATIC_ROOT)) {
    sendError(response, 403, 'FORBIDDEN', 'Path outside static root')
    return
  }
  try {
    const stat = await fs.stat(filePath)
    if (!stat.isFile()) throw new Error('not a file')
    const contents = await fs.readFile(filePath)
    response.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-cache'
    })
    response.end(contents)
  } catch {
    sendError(response, 404, 'NOT_FOUND', 'Not found')
  }
}

async function normalizeThreadId(args) {
  return args?.thread_id || process.env.CODEX_THREAD_ID || null
}

async function handleApi(request, response, pathname, query, body, sessions, ctx, controlToken) {
  if (pathname === '/api/health') {
    return sendJson(response, 200, { ok: true, schemaVersion: 1, product: 'skill-scope-dashboard', version: VERSION, threadId: process.env.CODEX_THREAD_ID || null })
  }
  if (pathname === '/api/session/context') {
    return sendJson(response, 200, { ok: true, threadId: process.env.CODEX_THREAD_ID || null })
  }
  if (pathname === '/api/session/launch') {
    const authorization = request.headers.authorization || ''
    const candidate = authorization.startsWith('Bearer ') ? authorization.slice(7) : ''
    if (!candidate || candidate.length !== controlToken.length || !crypto.timingSafeEqual(Buffer.from(candidate), Buffer.from(controlToken))) {
      return sendError(response, 401, 'CONTROL_AUTH_REQUIRED', 'Valid local control authorization required')
    }
    const nonce = crypto.randomBytes(24).toString('base64url')
    sessions.launchNonces.set(nonce, { expiresAt: Date.now() + LAUNCH_TTL_MS, used: false })
    return sendJson(response, 200, {
      ok: true,
      launchUrl: `http://127.0.0.1:${request.socket.localPort}/launch/${nonce}`,
      expiresInSeconds: 60
    })
  }
  const cookies = parseCookies(request)
  const sessionToken = cookies[SESSION_COOKIE]
  const sessionValid = sessionToken && sessions.tokens.get(sessionToken) > Date.now()
  const isMutation = request.method !== 'GET' && request.method !== 'HEAD'
  if (!sessionValid) {
    return sendError(response, 401, 'SESSION_REQUIRED', 'Open the Dashboard through a fresh launch link')
  }
  if (isMutation && !originMatchesHost(request)) {
    return sendError(response, 403, 'ORIGIN_MISMATCH', 'Cross-origin write rejected')
  }

  if (pathname === '/api/skills' && request.method === 'GET') {
    const threadId = query.thread_id || process.env.CODEX_THREAD_ID || null
    const selectedScope = query.scope === 'thread' ? 'thread' : 'global'
    const scan = await skills.scanSkills(ctx, { threadId })
    const policies = await policy.listScopes(ctx)
    const trash = await skills.listTrash(ctx)
    const threadPolicy = threadId ? await policy.loadScopePolicy(ctx, 'thread', threadId) : null
    const globalPolicy = await policy.loadScopePolicy(ctx, 'global', null)
    const protectedSkills = []
    for (const name of scan.skills.map((skill) => skill.name)) {
      if (await skills.isProtectedSkill(ctx, name)) protectedSkills.push(name)
    }
    const skillsWithScope = scan.skills.map((skill) => {
      const globalState = globalPolicy?.enabled?.[skill.name] ? 'enabled'
        : globalPolicy?.disabled?.[skill.name] ? 'disabled'
          : 'inherit'
      const threadState = threadPolicy?.enabled?.[skill.name] ? 'enabled'
        : threadPolicy?.disabled?.[skill.name] ? 'disabled'
          : 'inherit'
      return {
        ...skill,
        globalState,
        threadState,
        scopeState: { state: selectedScope === 'thread' ? threadState : globalState },
        canDelete: Boolean(skill.managed) && !protectedSkills.includes(skill.name)
      }
    })
    return sendJson(response, 200, {
      ok: true,
      schemaVersion: 1,
      threadId,
      scope: selectedScope,
      stats: scan.stats,
      trashCount: trash.length,
      policies,
      skills: skillsWithScope
    })
  }
  if (pathname === '/api/skills/delete-plan' && request.method === 'POST') {
    if (!body.name) return sendError(response, 400, 'MISSING_NAME', 'name is required')
    const plan = await skills.deleteSkillPlan(ctx, body.name, { source: 'dashboard' })
    return sendJson(response, 200, { ok: true, plan })
  }
  if (pathname === '/api/skills/delete' && request.method === 'POST') {
    if (!body.name) return sendError(response, 400, 'MISSING_NAME', 'name is required')
    const result = await skills.deleteSkill(ctx, body.name, { preview: false, source: 'dashboard' })
    return sendJson(response, 200, { ok: true, result })
  }
  if (pathname === '/api/policy' && request.method === 'GET') {
    const threadId = query.thread_id || process.env.CODEX_THREAD_ID || null
    const policies = await policy.listScopes(ctx)
    return sendJson(response, 200, { ok: true, schemaVersion: 1, threadId, policies })
  }
  if (pathname === '/api/policy/plan' && request.method === 'POST') {
    const operations = body.operations
    if (!Array.isArray(operations) || operations.length === 0) {
      return sendError(response, 400, 'EMPTY_OPERATIONS', 'operations is required')
    }
    const normalized = []
    const warnings = []
    for (const op of operations) {
      let scope = op.scope || 'thread'
      let target = op.target || null
      if (scope === 'thread' && !target) {
        target = body.thread_id || process.env.CODEX_THREAD_ID || null
        if (!target) {
          warnings.push({ code: 'THREAD_ID_MISSING', message: 'No thread id; fell back to global policy' })
          scope = 'global'
          target = null
        }
      }
      normalized.push({ ...op, scope, target })
    }
    const plan = await policy.createPlan(ctx, normalized, null, { source: 'dashboard' })
    return sendJson(response, 200, { ok: true, warnings, plan })
  }
  if (pathname === '/api/policy/apply' && request.method === 'POST') {
    if (!body.plan_id) return sendError(response, 400, 'MISSING_PLAN', 'plan_id is required')
    const transaction = await policy.applyPlan(ctx, body.plan_id, { source: 'dashboard' })
    return sendJson(response, 200, { ok: true, transaction })
  }
  if (pathname === '/api/policy/rollback' && request.method === 'POST') {
    if (!body.transaction_id) return sendError(response, 400, 'MISSING_TRANSACTION', 'transaction_id is required')
    const transaction = await policy.rollbackTransaction(ctx, body.transaction_id, { source: 'dashboard' })
    return sendJson(response, 200, { ok: true, transaction })
  }
  if (pathname === '/api/transactions' && request.method === 'GET') {
    return sendJson(response, 200, { ok: true, transactions: await policy.listTransactions(ctx) })
  }
  if (pathname === '/api/trash' && request.method === 'GET') {
    return sendJson(response, 200, { ok: true, entries: await skills.listTrash(ctx) })
  }
  if (pathname === '/api/trash/restore' && request.method === 'POST') {
    if (!body.name) return sendError(response, 400, 'MISSING_NAME', 'name is required')
    const result = await skills.restoreSkill(ctx, body.name, { source: 'dashboard' })
    return sendJson(response, 200, { ok: true, result })
  }
  if (pathname === '/api/trash/purge' && request.method === 'POST') {
    if (!body.trash_id) return sendError(response, 400, 'MISSING_TRASH_ID', 'trash_id is required')
    const result = await skills.purgeTrash(ctx, body.trash_id)
    return sendJson(response, 200, { ok: true, result })
  }
  if (pathname === '/api/market/install' && request.method === 'POST') {
    if (!body.source) return sendError(response, 400, 'MISSING_SOURCE', 'source is required')
    const result = await skills.installFromSource(ctx, body.source, { name: body.skill_name || null, sourceLabel: 'dashboard' })
    return sendJson(response, 200, { ok: true, result })
  }
  if (pathname === '/api/audit' && request.method === 'GET') {
    return sendJson(response, 200, { ok: true, entries: await policy.listAudit(ctx, 300) })
  }
  if (pathname === '/api/doctor' && request.method === 'GET') {
    return sendJson(response, 200, { ok: true, ...(await policy.doctor(ctx)) })
  }
  return sendError(response, 404, 'NOT_FOUND', 'Not found')
}

export async function startServer({ port = defaultPort() } = {}) {
  const ctx = policy.resolveContext()
  const controlToken = process.env.SKILL_SCOPE_CONTROL_TOKEN || crypto.randomBytes(32).toString('base64url')
  const sessions = {
    launchNonces: new Map(),
    tokens: new Map()
  }
  let actualPort = null
  let owned = false

  const server = http.createServer(async (request, response) => {
    try {
      if (!isLoopbackHost(request.headers.host)) {
        return sendError(response, 421, 'INVALID_HOST', 'skill-scope Dashboard only accepts loopback Host headers')
      }
      const url = new URL(request.url, 'http://127.0.0.1')
      const pathname = url.pathname
      const query = Object.fromEntries(url.searchParams.entries())
      if (pathname === '/launch/') {
        return sendError(response, 400, 'MISSING_NONCE', 'Missing launch nonce')
      }
      const launchMatch = pathname.match(/^\/launch\/([A-Za-z0-9_-]+)$/)
      if (launchMatch) {
        const nonce = launchMatch[1]
        const launch = sessions.launchNonces.get(nonce)
        if (!launch || launch.used || launch.expiresAt < Date.now()) {
          return sendError(response, 410, 'LAUNCH_INVALID', 'Launch link is invalid, expired, or already used')
        }
        launch.used = true
        const token = crypto.randomBytes(32).toString('base64url')
        sessions.tokens.set(token, Date.now() + SESSION_TTL_MS)
        response.writeHead(302, {
          Location: '/',
          'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly; Path=/; SameSite=Strict; Max-Age=${SESSION_TTL_MS / 1000}`
        })
        return response.end()
      }
      if (pathname.startsWith('/api/')) {
        const body = ['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method) ? await readBody(request) : {}
        return await handleApi(request, response, pathname, query, body, sessions, ctx, controlToken)
      }
      if (request.method === 'GET' || request.method === 'HEAD') {
        return await serveStatic(request, response, pathname)
      }
      return sendError(response, 405, 'METHOD_NOT_ALLOWED', 'Method not allowed')
    } catch (error) {
      const code = error?.code || 'INTERNAL_ERROR'
      const message = error?.message || String(error)
      return sendError(response, 500, code, message)
    }
  })

  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = port + attempt
    try {
      await new Promise((resolve, reject) => {
        server.once('error', reject)
        server.listen(candidate, '127.0.0.1', () => {
          server.removeListener('error', reject)
          resolve()
        })
      })
      actualPort = candidate
      break
    } catch (error) {
      if (error?.code === 'EADDRINUSE' && attempt < 4) continue
      throw error
    }
  }
  const baseUrl = `http://127.0.0.1:${actualPort}`
  await writeJsonAtomic(stateFile(ctx), {
    schemaVersion: 1,
    product: 'skill-scope-dashboard',
    version: VERSION,
    pid: process.pid,
    host: '127.0.0.1',
    port: actualPort,
    baseUrl,
    controlToken,
    startedAt: new Date().toISOString()
  })
  owned = true
  console.log(`🚀 skill-scope Dashboard running at ${baseUrl}`)

  const shutdown = async () => {
    if (owned) {
      await fs.rm(stateFile(ctx), { force: true }).catch(() => {})
      owned = false
    }
    server.close(() => process.exit(0))
    setTimeout(() => process.exit(0), 2000).unref()
  }
  process.once('SIGINT', () => void shutdown())
  process.once('SIGTERM', () => void shutdown())
}
