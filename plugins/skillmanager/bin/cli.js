#!/usr/bin/env node
import { spawn, spawnSync } from 'child_process'
import fsSync from 'fs'
import fs from 'fs/promises'
import { fileURLToPath, pathToFileURL } from 'url'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import net from 'net'

const cliFile = fileURLToPath(import.meta.url)
const binDirectory = path.dirname(cliFile)
const packageRoot = path.resolve(binDirectory, '..')
const packagedServerEntry = path.join(packageRoot, 'dist', 'server', 'index.js')
const serverEntry = process.env.SKILLMANAGER_SERVER_ENTRY
  ? path.resolve(process.env.SKILLMANAGER_SERVER_ENTRY)
  : packagedServerEntry
const serverNodeArgs = process.env.SKILLMANAGER_SERVER_NODE_ARGS
  ? JSON.parse(process.env.SKILLMANAGER_SERVER_NODE_ARGS)
  : []
if (!Array.isArray(serverNodeArgs) || serverNodeArgs.some((value) => typeof value !== 'string')) {
  throw new Error('SKILLMANAGER_SERVER_NODE_ARGS must be a JSON string array')
}
const packageJson = JSON.parse(fsSync.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const version = packageJson.version
const capabilities = ['scan', 'diagnose', 'versions', 'trash', 'sync']

function optionalAbsolutePath(name) {
  const value = process.env[name]?.trim()
  if (!value) return null
  if (!path.isAbsolute(value)) throw new CliError('INVALID_ENV_PATH', `${name} must be absolute`)
  return path.resolve(value)
}

const fixtureRoot = optionalAbsolutePath('SKILLMANAGER_FIXTURE_ROOT')
const userHome = fixtureRoot || os.homedir()

function defaultDataDirectory() {
  if (fixtureRoot) return path.join(fixtureRoot, 'data')
  if (process.platform === 'darwin') {
    return path.join(userHome, 'Library', 'Application Support', 'SkillManager')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim()
    return path.join(appData || path.join(userHome, 'AppData', 'Roaming'), 'SkillManager')
  }
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim()
  return path.join(xdgDataHome || path.join(userHome, '.local', 'share'), 'skillmanager')
}

const dataDirectory = optionalAbsolutePath('SKILLMANAGER_DATA_DIR') || defaultDataDirectory()
const runtimeDirectory = path.join(dataDirectory, 'runtime')
const statePath = path.join(runtimeDirectory, 'state.json')
const lockPath = path.join(runtimeDirectory, 'start.lock')
const logPath = path.join(runtimeDirectory, 'server.log')

class CliError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'CliError'
    this.code = code
    this.details = details
  }
}

function parseArguments(argv) {
  const commands = new Set(['start', 'status', 'open', 'stop', 'doctor', 'serve', 'version', 'help'])
  let command = argv[0]
  let index = 1
  if (!command) {
    command = 'open'
    index = 0
  } else if (command === '--help' || command === '-h') {
    command = 'help'
  } else if (command === '--version' || command === '-v') {
    command = 'version'
  } else if (!commands.has(command)) {
    throw new CliError('UNKNOWN_COMMAND', `Unknown command: ${command}`)
  }

  const configuredPort = Number(process.env.SKILLMANAGER_PORT || 3456)
  const options = {
    json: false,
    noOpen: false,
    project: null,
    target: null,
    port: Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort <= 65535
      ? configuredPort
      : 3456,
    foreground: false,
  }
  for (; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--no-open') options.noOpen = true
    else if (arg === '--foreground') options.foreground = true
    else if (arg === '--project') {
      const value = argv[++index]
      if (!value) throw new CliError('MISSING_PROJECT', '--project requires a path')
      options.project = value
    } else if (arg === '--target') {
      const value = argv[++index]
      if (
        !value ||
        !value.startsWith('/') ||
        value.startsWith('//') ||
        /[\r\n\0\\]/.test(value) ||
        value.length > 2048
      ) {
        throw new CliError('INVALID_TARGET', '--target must be a local relative dashboard path')
      }
      options.target = value
    } else if (arg === '--port') {
      const value = Number(argv[++index])
      if (!Number.isInteger(value) || value < 1 || value > 65535) {
        throw new CliError('INVALID_PORT', '--port must be between 1 and 65535')
      }
      options.port = value
    } else if (arg === '--help' || arg === '-h') {
      command = 'help'
    } else {
      throw new CliError('UNKNOWN_OPTION', `Unknown option: ${arg}`)
    }
  }
  return { command, options }
}

function helpText() {
  return `SkillManager ${version}

Usage:
  skillmanager start [--json] [--project <path>] [--no-open]
  skillmanager status [--json]
  skillmanager open [--json] [--project <path>]
  skillmanager stop [--json]
  skillmanager doctor [--json]
  skillmanager serve [--port <port>] [--foreground]
  skillmanager version [--json]

With no command, SkillManager behaves like \`skillmanager open\`.
JSON mode never opens an external system browser.`
}

function outputJson(value) {
  process.stdout.write(JSON.stringify(value) + '\n')
}

function isRuntimeState(value) {
  return value?.schemaVersion === 1 &&
    value.product === 'SkillManager' &&
    typeof value.version === 'string' &&
    Number.isInteger(value.pid) && value.pid > 0 &&
    value.host === '127.0.0.1' &&
    Number.isInteger(value.port) && value.port > 0 && value.port <= 65535 &&
    value.baseUrl === `http://127.0.0.1:${value.port}` &&
    typeof value.startedAt === 'string' &&
    /^instance_[A-Za-z0-9_-]{12,}$/.test(value.instanceId) &&
    typeof value.processIdentity === 'string' &&
    typeof value.controlToken === 'string' && value.controlToken.length >= 32 &&
    typeof value.managed === 'boolean' &&
    (value.projectRoot === undefined || value.projectRoot === null || typeof value.projectRoot === 'string') &&
    Array.isArray(value.capabilities)
}

async function readState() {
  try {
    const parsed = JSON.parse(await fs.readFile(statePath, 'utf8'))
    return isRuntimeState(parsed)
      ? { kind: 'valid', state: parsed }
      : { kind: 'invalid', state: null }
  } catch (error) {
    if (error?.code === 'ENOENT') return { kind: 'missing', state: null }
    return { kind: 'invalid', state: null }
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

async function fetchJson(url, options = {}, timeoutMs = 1500) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const response = await fetch(url, { ...options, signal: controller.signal })
    const body = await response.json().catch(() => null)
    return { response, body }
  } finally {
    clearTimeout(timer)
  }
}

async function inspectRuntime() {
  const loaded = await readState()
  if (loaded.kind === 'missing') return { kind: 'stopped', reason: 'no_state' }
  if (loaded.kind === 'invalid') return { kind: 'blocked', reason: 'invalid_state' }
  const state = loaded.state
  if (!processAlive(state.pid)) return { kind: 'stopped', reason: 'stale_pid', state }
  try {
    const { response, body } = await fetchJson(`${state.baseUrl}/api/v1/health`)
    if (
      response.ok &&
      body?.product === 'SkillManager' &&
      body.instanceId === state.instanceId &&
      body.processIdentity === state.processIdentity
    ) {
      return { kind: 'running', state, health: body }
    }
    return { kind: 'blocked', reason: 'identity_mismatch', state }
  } catch {
    return { kind: 'blocked', reason: 'unreachable_process', state }
  }
}

function publicRunning(state, reused = false, health = null) {
  return {
    schemaVersion: 1,
    status: 'running',
    version: state.version,
    pid: state.pid,
    host: state.host,
    port: state.port,
    baseUrl: state.baseUrl,
    startedAt: state.startedAt,
    processIdentity: state.processIdentity,
    managed: state.managed,
    projectConfigured: state.projectConfigured,
    reused,
    capabilities: Array.isArray(state.capabilities) ? state.capabilities : capabilities,
    ...(health?.scanner ? { scanner: health.scanner } : {}),
  }
}

function publicStopped(reason = 'not_running') {
  return {
    schemaVersion: 1,
    status: 'stopped',
    version,
    reason,
    capabilities,
  }
}

async function removeStateIfOwned(expectedInstanceId) {
  const loaded = await readState()
  if (loaded.kind !== 'valid' || loaded.state.instanceId !== expectedInstanceId) return false
  await fs.unlink(statePath).catch(() => {})
  return true
}

async function acquireStartLock(timeoutMs = 15_000) {
  await fs.mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
  if (process.platform !== 'win32') await fs.chmod(runtimeDirectory, 0o700)
  const deadline = Date.now() + timeoutMs
  const lockId = crypto.randomBytes(16).toString('hex')
  while (Date.now() < deadline) {
    try {
      const handle = await fs.open(lockPath, 'wx', 0o600)
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: Date.now(), lockId }))
      await handle.close()
      return async () => {
        try {
          const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'))
          if (lock.pid === process.pid && lock.lockId === lockId) {
            await fs.unlink(lockPath)
          }
        } catch {}
      }
    } catch (error) {
      if (error?.code !== 'EEXIST') throw error
      try {
        const lock = JSON.parse(await fs.readFile(lockPath, 'utf8'))
        const stale = !Number.isInteger(lock.pid) ||
          !processAlive(lock.pid) ||
          Date.now() - Number(lock.createdAt || 0) > 30_000
        if (stale) {
          await fs.unlink(lockPath).catch(() => {})
          continue
        }
      } catch {
        // Another starter may have created the lock but not finished writing
        // its JSON yet. Only reap an invalid lock after a grace period.
        try {
          const stat = await fs.stat(lockPath)
          if (Date.now() - stat.mtimeMs > 5_000) {
            await fs.unlink(lockPath).catch(() => {})
            continue
          }
        } catch {}
      }
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new CliError('START_LOCK_TIMEOUT', 'Timed out waiting for another SkillManager start operation')
}

async function resolveProject(projectValue) {
  if (!projectValue) return null
  const candidate = path.resolve(projectValue)
  let real
  try {
    real = await fs.realpath(candidate)
    const stat = await fs.stat(real)
    if (!stat.isDirectory()) throw new Error('not a directory')
  } catch {
    throw new CliError('INVALID_PROJECT', 'The supplied project path is not an existing directory')
  }
  return real
}

function ensureBuild() {
  if (!fsSync.existsSync(serverEntry)) {
    throw new CliError('BUILD_MISSING', 'Packaged server files are missing; reinstall SkillManager')
  }
}

async function startService(options) {
  ensureBuild()
  const project = await resolveProject(options.project)
  const releaseLock = await acquireStartLock()
  try {
    const current = await inspectRuntime()
    if (current.kind === 'running') {
      if (current.state.version !== version) {
        throw new CliError(
          'INCOMPATIBLE_INSTANCE',
          `A different SkillManager version is already running (${current.state.version})`,
        )
      }
      if (project && current.state.projectRoot !== project) {
        await stopManagedState(current.state)
      } else {
        return { state: current.state, reused: true }
      }
    }
    if (current.kind === 'blocked') {
      throw new CliError(
        'RUNTIME_STATE_BLOCKED',
        `Cannot safely start: ${current.reason}. Run \`skillmanager doctor\` for details.`,
      )
    }
    if (current.state) await removeStateIfOwned(current.state.instanceId)

    const instanceId = `instance_${crypto.randomBytes(18).toString('base64url')}`
    const controlToken = crypto.randomBytes(32).toString('base64url')
    await fs.mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
    const outputFd = fsSync.openSync(logPath, 'a', 0o600)
    const errorFd = fsSync.openSync(logPath, 'a', 0o600)
    let child
    try {
      child = spawn(process.execPath, [...serverNodeArgs, serverEntry], {
        cwd: project || process.cwd(),
        detached: true,
        windowsHide: true,
        stdio: ['ignore', outputFd, errorFd],
        env: {
          ...process.env,
          PORT: String(options.port || 3456),
          SKILLMANAGER_INSTANCE_ID: instanceId,
          SKILLMANAGER_CONTROL_TOKEN: controlToken,
          SKILLMANAGER_MANAGED: '1',
          SKILLMANAGER_NO_OPEN: '1',
          SKILL_HUB_NO_OPEN: '1',
          SKILLMANAGER_VERSION: version,
          ...(project ? { SKILLMANAGER_PROJECT_ROOT: project } : {}),
        },
      })
    } finally {
      fsSync.closeSync(outputFd)
      fsSync.closeSync(errorFd)
    }
    child.unref()

    const deadline = Date.now() + 20_000
    while (Date.now() < deadline) {
      if (!processAlive(child.pid)) {
        throw new CliError('SERVER_EXITED', 'SkillManager server exited before becoming healthy')
      }
      const loaded = await readState()
      if (loaded.kind === 'valid' && loaded.state.instanceId === instanceId) {
        const inspected = await inspectRuntime()
        if (inspected.kind === 'running') return { state: inspected.state, reused: false }
        if (inspected.kind === 'blocked' && inspected.reason === 'identity_mismatch') {
          throw new CliError('IDENTITY_MISMATCH', 'Started process did not match its runtime identity')
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
    throw new CliError('START_TIMEOUT', 'Timed out waiting for SkillManager health check')
  } finally {
    await releaseLock()
  }
}

async function createLaunch(state, target) {
  const { response, body } = await fetchJson(`${state.baseUrl}/api/v1/control/launch`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${state.controlToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ target }),
  })
  if (!response.ok || !body?.ok || typeof body.launchUrl !== 'string') {
    throw new CliError('LAUNCH_FAILED', body?.error || 'Could not create a launch URL')
  }
  return body
}

function openSystemBrowser(url) {
  let child
  if (process.platform === 'darwin') {
    child = spawn('open', [url], { detached: true, stdio: 'ignore' })
  } else if (process.platform === 'win32') {
    child = spawn('cmd.exe', ['/d', '/s', '/c', 'start', '', url], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    })
  } else {
    child = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' })
  }
  child.on('error', () => {})
  child.unref()
}

async function canBind(port) {
  return new Promise((resolve) => {
    const server = net.createServer()
    server.once('error', () => resolve(false))
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true))
    })
  })
}

async function doctorReport() {
  const checks = []
  const nodeMajor = Number(process.versions.node.split('.')[0])
  checks.push({
    id: 'node',
    status: nodeMajor >= 20 ? 'pass' : 'fail',
    detail: `Node ${process.versions.node}`,
  })

  const git = spawnSync('git', ['--version'], { encoding: 'utf8', windowsHide: true })
  checks.push({
    id: 'git',
    status: git.status === 0 ? 'pass' : 'warn',
    detail: git.status === 0 ? git.stdout.trim() : 'Git unavailable; sync is disabled',
  })

  const requiredArtifacts = [
    ['server', packagedServerEntry],
    ['web', path.join(packageRoot, 'dist', 'web', 'index.html')],
    ['manifest', path.join(packageRoot, 'dist', 'build-manifest.json')],
  ]
  const missing = requiredArtifacts.filter(([, target]) => !fsSync.existsSync(target)).map(([label]) => label)
  checks.push({
    id: 'release-files',
    status: missing.length === 0 ? 'pass' : 'fail',
    detail: missing.length === 0 ? 'Packaged server, web, and manifest found' : `Missing: ${missing.join(', ')}`,
  })

  let dataWritable = false
  try {
    await fs.mkdir(runtimeDirectory, { recursive: true, mode: 0o700 })
    const probe = path.join(runtimeDirectory, `.doctor-${crypto.randomBytes(8).toString('hex')}`)
    const handle = await fs.open(probe, 'wx', 0o600)
    await handle.writeFile('ok')
    await handle.close()
    await fs.unlink(probe)
    dataWritable = true
  } catch {}
  checks.push({
    id: 'data-directory',
    status: dataWritable ? 'pass' : 'fail',
    detail: dataWritable ? 'Platform data directory is writable' : 'Platform data directory is not writable',
  })

  const runtime = await inspectRuntime()
  if (runtime.kind === 'running') {
    checks.push({ id: 'runtime', status: 'pass', detail: `Healthy on 127.0.0.1:${runtime.state.port}` })
    checks.push({
      id: 'scanner',
      status: runtime.health.scanner?.status === 'ready' ? 'pass' : 'warn',
      detail: runtime.health.scanner?.status === 'ready'
        ? `Scanner ready (${runtime.health.scanner.totalSkills ?? 0} Skills)`
        : `Scanner ${runtime.health.scanner?.status || 'unknown'}`,
    })
    checks.push({ id: 'port', status: 'pass', detail: `Managed runtime owns port ${runtime.state.port}` })
  } else {
    checks.push({
      id: 'runtime',
      status: runtime.kind === 'blocked' ? 'fail' : 'warn',
      detail: runtime.kind === 'blocked' ? `Runtime blocked: ${runtime.reason}` : 'Runtime is stopped',
    })
    const portFree = await canBind(3456)
    checks.push({
      id: 'port',
      status: portFree ? 'pass' : 'warn',
      detail: portFree ? 'Default port 3456 is available' : 'Default port 3456 is occupied; start will try a bounded fallback',
    })
    checks.push({ id: 'scanner', status: 'warn', detail: 'Scanner not checked because runtime is stopped' })
  }

  return {
    schemaVersion: 1,
    ok: checks.every((check) => check.status !== 'fail'),
    product: 'SkillManager',
    version,
    platform: process.platform,
    checks,
  }
}

async function stopService() {
  const runtime = await inspectRuntime()
  if (runtime.kind === 'stopped') {
    if (runtime.state) await removeStateIfOwned(runtime.state.instanceId)
    return { ...publicStopped(runtime.reason), stopped: false }
  }
  if (runtime.kind === 'blocked') {
    throw new CliError(
      'STOP_IDENTITY_UNVERIFIED',
      `Refusing to stop a process whose identity cannot be verified (${runtime.reason})`,
    )
  }
  if (!runtime.state.managed) {
    throw new CliError('UNMANAGED_INSTANCE', 'Refusing to stop a foreground instance not managed by SkillManager start')
  }
  await stopManagedState(runtime.state)
  return { ...publicStopped('stopped_by_user'), stopped: true }
}

async function stopManagedState(state) {
  if (!state.managed) {
    throw new CliError('UNMANAGED_INSTANCE', 'Refusing to stop a foreground instance not managed by SkillManager start')
  }
  try {
    process.kill(state.pid, 'SIGTERM')
  } catch (error) {
    if (error?.code !== 'ESRCH') throw error
  }
  const deadline = Date.now() + 10_000
  while (Date.now() < deadline && processAlive(state.pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (processAlive(state.pid)) {
    throw new CliError('STOP_TIMEOUT', 'SkillManager did not stop after SIGTERM')
  }
  await removeStateIfOwned(state.instanceId)
}

async function runCommand(command, options) {
  if (command === 'help') {
    process.stdout.write(helpText() + '\n')
    return
  }
  if (command === 'version') {
    if (options.json) outputJson({ schemaVersion: 1, product: 'SkillManager', version })
    else process.stdout.write(`SkillManager ${version}\n`)
    return
  }
  if (command === 'status') {
    const runtime = await inspectRuntime()
    const result = runtime.kind === 'running'
      ? publicRunning(runtime.state, false, runtime.health)
      : runtime.kind === 'stopped'
        ? publicStopped(runtime.reason)
        : {
            schemaVersion: 1,
            status: 'error',
            version,
            code: 'RUNTIME_STATE_BLOCKED',
            reason: runtime.reason,
            capabilities,
          }
    if (options.json) outputJson(result)
    else if (result.status === 'running') process.stdout.write(`SkillManager is running at ${result.baseUrl}\n`)
    else process.stdout.write(`SkillManager is ${result.status}: ${result.reason || result.code}\n`)
    if (result.status === 'error') process.exitCode = 1
    return
  }
  if (command === 'doctor') {
    const report = await doctorReport()
    if (options.json) outputJson(report)
    else {
      process.stdout.write(`SkillManager doctor: ${report.ok ? 'OK' : 'issues found'}\n`)
      for (const check of report.checks) {
        const marker = check.status === 'pass' ? '✓' : check.status === 'warn' ? '!' : '✗'
        process.stdout.write(`  ${marker} ${check.id}: ${check.detail}\n`)
      }
    }
    if (!report.ok) process.exitCode = 1
    return
  }
  if (command === 'serve') {
    ensureBuild()
    const runtime = await inspectRuntime()
    if (runtime.kind === 'running') {
      throw new CliError('INSTANCE_ALREADY_RUNNING', `SkillManager is already running at ${runtime.state.baseUrl}`)
    }
    if (runtime.kind === 'blocked') {
      throw new CliError('RUNTIME_STATE_BLOCKED', `Cannot safely serve: ${runtime.reason}`)
    }
    if (runtime.state) await removeStateIfOwned(runtime.state.instanceId)
    process.env.PORT = String(options.port)
    process.env.SKILLMANAGER_INSTANCE_ID ||= `instance_${crypto.randomBytes(18).toString('base64url')}`
    process.env.SKILLMANAGER_CONTROL_TOKEN ||= crypto.randomBytes(32).toString('base64url')
    process.env.SKILLMANAGER_MANAGED ||= '0'
    process.env.SKILLMANAGER_NO_OPEN = '1'
    await import(pathToFileURL(serverEntry).href)
    return
  }
  if (command === 'stop') {
    const result = await stopService()
    if (options.json) outputJson(result)
    else process.stdout.write(result.stopped ? 'SkillManager stopped.\n' : 'SkillManager was not running.\n')
    return
  }
  if (command === 'start') {
    const started = await startService(options)
    let opened = false
    if (!options.noOpen && !options.json) {
      const launch = await createLaunch(started.state, options.project ? '/?view=current-project' : '/')
      openSystemBrowser(launch.launchUrl)
      opened = true
    }
    const result = { ...publicRunning(started.state, started.reused), opened }
    if (options.json) outputJson(result)
    else process.stdout.write(
      `${started.reused ? 'Reused' : 'Started'} SkillManager at ${started.state.baseUrl}${opened ? ' and opened it' : ''}.\n`,
    )
    return
  }
  if (command === 'open') {
    const started = await startService({ ...options, noOpen: true })
    const launch = await createLaunch(
      started.state,
      options.target || (options.project ? '/?view=current-project' : '/'),
    )
    if (!options.json) openSystemBrowser(launch.launchUrl)
    const result = {
      ...publicRunning(started.state, started.reused),
      launchUrl: launch.launchUrl,
      expiresInSeconds: launch.expiresInSeconds,
      opened: !options.json,
    }
    if (options.json) outputJson(result)
    else process.stdout.write(`Opened SkillManager at ${started.state.baseUrl}.\n`)
  }
}

let parsed
try {
  parsed = parseArguments(process.argv.slice(2))
  await runCommand(parsed.command, parsed.options)
} catch (error) {
  const json = parsed?.options?.json || process.argv.includes('--json')
  const safeError = error instanceof CliError
    ? error
    : new CliError('UNEXPECTED_ERROR', error instanceof Error ? error.message : 'Unexpected error')
  if (json) {
    outputJson({
      schemaVersion: 1,
      ok: false,
      status: 'error',
      code: safeError.code,
      error: safeError.message,
      ...(safeError.details ? { details: safeError.details } : {}),
    })
  } else {
    process.stderr.write(`[SkillManager] ${safeError.message}\n`)
  }
  process.exitCode = 1
}
