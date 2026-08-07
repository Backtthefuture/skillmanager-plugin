// skill-scope policy engine (standalone, two-layer: global + thread)
// Manages policy records and managed symlinks. Never rewrites SKILL.md content.
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import os from 'os'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const POLICY_SCHEMA_VERSION = 1
const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const THREAD_ID_RE = /^[A-Za-z0-9._:=-]{1,256}$/

export class PolicyError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'PolicyError'
    this.code = code
    this.details = details
  }
}

function optionalAbsolutePath(name) {
  const value = process.env[name]?.trim()
  if (!value) return null
  if (!path.isAbsolute(value)) throw new PolicyError('INVALID_ENV_PATH', `${name} must be an absolute path`)
  return path.resolve(value)
}

function defaultDataDirectory(home) {
  if (process.platform === 'darwin') {
    return path.join(home, 'Library', 'Application Support', 'SkillManager')
  }
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA?.trim()
    return path.join(appData || path.join(home, 'AppData', 'Roaming'), 'SkillManager')
  }
  const xdgDataHome = process.env.XDG_DATA_HOME?.trim()
  return path.join(xdgDataHome || path.join(home, '.local', 'share'), 'skillmanager')
}

function parseTrustedProjectsEnv() {
  // Kept for compatibility with old tests; standalone plugin no longer uses project trust.
  const raw = process.env.SKILLMANAGER_TRUSTED_PROJECTS?.trim()
  if (!raw) return null
  try {
    const parsed = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.map((value) => path.resolve(String(value))) : null
  } catch {
    return null
  }
}

export function resolveContext(overrides = {}) {
  const fixtureRoot = overrides.fixtureRoot ?? optionalAbsolutePath('SKILLMANAGER_FIXTURE_ROOT')
  const home = overrides.home ?? (fixtureRoot || os.homedir())
  const codexHome = overrides.codexHome
    ? path.resolve(overrides.codexHome)
    : (process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(home, '.codex'))
  const dataDir = overrides.dataDir
    ? path.resolve(overrides.dataDir)
    : optionalAbsolutePath('SKILL_SCOPE_DATA_DIR')
      ?? optionalAbsolutePath('SKILLMANAGER_DATA_DIR')
      ?? (fixtureRoot ? path.join(fixtureRoot, 'data') : defaultDataDirectory(home))
  return {
    fixtureRoot,
    home,
    codexHome,
    dataDir,
    pluginRoot: overrides.pluginRoot ? path.resolve(overrides.pluginRoot) : PLUGIN_ROOT,
    globalRoot: overrides.globalRoot ? path.resolve(overrides.globalRoot) : path.join(codexHome, 'skills'),
    trustedProjects: overrides.trustedProjects ?? parseTrustedProjectsEnv()
  }
}

function nowIso() {
  return new Date().toISOString()
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

export function normalizeScope(scope) {
  const value = String(scope || 'global').trim().toLowerCase()
  if (value === 'global' || value === 'thread') return value
  throw new PolicyError('INVALID_SCOPE', 'Scope must be one of: global, thread (project scope was removed)')
}

export function normalizeSkillName(skill) {
  const value = String(skill || '').trim()
  if (!SKILL_NAME_RE.test(value)) {
    throw new PolicyError('INVALID_SKILL_NAME', 'Skill name must be 1-128 chars of letters, digits, `._-` and not start with `.`')
  }
  return value
}

export function sanitizeThreadId(threadId) {
  if (typeof threadId !== 'string' || !threadId.trim()) {
    throw new PolicyError('MISSING_THREAD', 'A thread id is required for thread scope')
  }
  const value = threadId.trim()
  if (!THREAD_ID_RE.test(value)) {
    throw new PolicyError('INVALID_THREAD_ID', 'Thread id may only contain letters, digits, `._:-=` (max 256 chars)')
  }
  return value
}

export function policyRoot(ctx) {
  return path.join(ctx.dataDir, 'policy')
}

function scopePolicyPath(ctx, scope, target) {
  const normalized = normalizeScope(scope)
  const root = policyRoot(ctx)
  if (normalized === 'global') return path.join(root, 'global.json')
  const threadId = sanitizeThreadId(target)
  return path.join(root, 'threads', `${threadId}.json`)
}

async function readJson(file, fallback) {
  try {
    const raw = await fs.readFile(file, 'utf8')
    const parsed = JSON.parse(raw)
    if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object')
    return parsed
  } catch (error) {
    if (error?.code === 'ENOENT') return fallback
    throw new PolicyError('INVALID_POLICY_FILE', `Policy file is not readable JSON: ${file}`, error?.message)
  }
}

async function writeJsonAtomic(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const tmp = path.join(path.dirname(file), `.tmp-${process.pid}-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`)
  await fs.writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
  await fs.rename(tmp, file)
}

function emptyPolicy(scope, target) {
  const policy = {
    schemaVersion: POLICY_SCHEMA_VERSION,
    scope: normalizeScope(scope),
    updatedAt: nowIso(),
    enabled: {},
    disabled: {}
  }
  if (scope === 'thread' && target) policy.target = { threadId: sanitizeThreadId(target) }
  return policy
}

export async function loadScopePolicy(ctx, scope, target) {
  const normalized = normalizeScope(scope)
  const file = scopePolicyPath(ctx, normalized, target)
  const parsed = await readJson(file, null)
  if (parsed === null) return emptyPolicy(normalized, target)
  return {
    ...parsed,
    schemaVersion: POLICY_SCHEMA_VERSION,
    scope: normalized,
    enabled: parsed.enabled && typeof parsed.enabled === 'object' ? parsed.enabled : {},
    disabled: parsed.disabled && typeof parsed.disabled === 'object' ? parsed.disabled : {}
  }
}

export async function saveScopePolicy(ctx, policy) {
  if (!policy || typeof policy !== 'object') throw new PolicyError('INVALID_POLICY', 'Cannot save an empty policy')
  const scope = normalizeScope(policy.scope)
  const target = scope === 'thread' ? policy.target?.threadId : null
  policy.schemaVersion = POLICY_SCHEMA_VERSION
  policy.scope = scope
  policy.updatedAt = nowIso()
  policy.enabled = policy.enabled || {}
  policy.disabled = policy.disabled || {}
  await writeJsonAtomic(scopePolicyPath(ctx, scope, target), policy)
  return policy
}

function entryFromPolicy(policy, skill) {
  const name = normalizeSkillName(skill)
  if (policy?.disabled?.[name]) return { state: 'disabled', meta: policy.disabled[name] }
  if (policy?.enabled?.[name]) return { state: 'enabled', meta: policy.enabled[name] }
  return null
}

export async function setSkillPolicy(ctx, { scope, target, skill, state, reason, source = 'cli' }) {
  const normalizedScope = normalizeScope(scope)
  const name = normalizeSkillName(skill)
  const enabled = Boolean(state)
  const policy = await loadScopePolicy(ctx, normalizedScope, target)
  const previous = entryFromPolicy(policy, name)
  const fromSet = enabled ? 'disabled' : 'enabled'
  const toSet = enabled ? 'enabled' : 'disabled'
  delete policy[fromSet][name]
  policy[toSet][name] = {
    updatedAt: nowIso(),
    reason: typeof reason === 'string' && reason.trim() ? reason.trim().slice(0, 500) : null,
    source: typeof source === 'string' && source.trim() ? source.trim().slice(0, 40) : 'cli'
  }
  await saveScopePolicy(ctx, policy)
  return { policy, previous, changed: true, file: scopePolicyPath(ctx, normalizedScope, target) }
}

export async function resetScopePolicy(ctx, { scope, target, skill, all = false, source = 'cli' }) {
  const normalizedScope = normalizeScope(scope)
  const policy = await loadScopePolicy(ctx, normalizedScope, target)
  const removed = []
  if (all) {
    for (const name of [...Object.keys(policy.enabled), ...Object.keys(policy.disabled)]) {
      removed.push({ skill: name, previous: entryFromPolicy(policy, name) })
    }
    policy.enabled = {}
    policy.disabled = {}
  } else {
    const name = normalizeSkillName(skill)
    const previous = entryFromPolicy(policy, name)
    if (previous) {
      removed.push({ skill: name, previous })
      delete policy.enabled[name]
      delete policy.disabled[name]
    }
  }
  await saveScopePolicy(ctx, policy)
  return { policy, removed, file: scopePolicyPath(ctx, normalizedScope, target) }
}

export async function resolveEffective(ctx, { skill, threadId = null, policies = null }) {
  const name = normalizeSkillName(skill)
  const threadPolicy = policies?.thread ?? (threadId ? await loadScopePolicy(ctx, 'thread', threadId) : null)
  const globalPolicy = policies?.global ?? await loadScopePolicy(ctx, 'global', null)
  for (const { layer, policy } of [
    { layer: 'thread', policy: threadPolicy },
    { layer: 'global', policy: globalPolicy }
  ]) {
    if (!policy) continue
    const entry = entryFromPolicy(policy, name)
    if (entry) {
      return {
        enabled: entry.state === 'enabled',
        source: layer,
        reason: entry.meta?.reason || null,
        updatedAt: entry.meta?.updatedAt || null,
        policySource: entry.meta?.source || null
      }
    }
  }
  return { enabled: true, source: 'default', reason: 'no explicit policy', updatedAt: null, policySource: null }
}

export async function resolveAllEffective(ctx, { threadId = null, skillNames = [] }) {
  const globalPolicy = await loadScopePolicy(ctx, 'global', null)
  const threadPolicy = threadId ? await loadScopePolicy(ctx, 'thread', threadId) : null
  const policies = { global: globalPolicy, thread: threadPolicy }
  const names = new Set(skillNames.map((value) => normalizeSkillName(value)))
  for (const policy of [globalPolicy, threadPolicy]) {
    if (!policy) continue
    for (const name of Object.keys(policy.enabled)) names.add(name)
    for (const name of Object.keys(policy.disabled)) names.add(name)
  }
  const skills = {}
  for (const name of names) {
    skills[name] = await resolveEffective(ctx, { skill: name, threadId, policies })
  }
  return { skills, policies }
}

export async function getActiveSkills(ctx, { threadId = null, skillNames = [], includeAllDiscovered = true }) {
  const resolved = await resolveAllEffective(ctx, { threadId, skillNames })
  const entries = Object.entries(resolved.skills)
  const warnings = []
  if (!threadId) warnings.push({ code: 'THREAD_ID_MISSING', message: 'Thread id unavailable; fell back to global policy. Provide thread_id or CODEX_THREAD_ID when available.' })
  return {
    schemaVersion: 1,
    thread_id: threadId,
    managed_skills: entries.map(([name]) => name),
    skills: Object.fromEntries(entries.map(([name, value]) => [name, {
      enabled: value.enabled,
      source: value.source,
      reason: value.reason,
      updatedAt: value.updatedAt
    }])),
    enabled: entries.filter(([, value]) => value.enabled).map(([name]) => name),
    disabled: entries.filter(([, value]) => !value.enabled).map(([name]) => name),
    warnings
  }
}

export async function listScopes(ctx) {
  const global = await loadScopePolicy(ctx, 'global', null)
  const threads = []
  const threadsDir = path.join(policyRoot(ctx), 'threads')
  try {
    const entries = await fs.readdir(threadsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const parsed = await readJson(path.join(threadsDir, entry.name), null)
      if (!parsed) continue
      threads.push({
        id: entry.name.replace(/\.json$/, ''),
        enabled: Object.keys(parsed.enabled || {}),
        disabled: Object.keys(parsed.disabled || {})
      })
    }
  } catch {
  }
  threads.sort((a, b) => a.id.localeCompare(b.id))
  return {
    schemaVersion: 1,
    updatedAt: nowIso(),
    global: {
      enabled: Object.keys(global.enabled),
      disabled: Object.keys(global.disabled)
    },
    threads
  }
}

export async function migrateProjectPolicies(ctx) {
  const root = policyRoot(ctx)
  const projectsDir = path.join(root, 'projects')
  const markerFile = path.join(root, 'migration-project-archive.json')
  const marker = await readJson(markerFile, null)
  if (marker?.archivedAt) {
    return { archived: false, alreadyArchived: true, movedTo: marker.movedTo || null, count: marker.count || 0 }
  }
  let entries = []
  try {
    entries = (await fs.readdir(projectsDir, { withFileTypes: true })).filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
  } catch (error) {
    if (error?.code === 'ENOENT') return { archived: false, alreadyArchived: false, movedTo: null, count: 0 }
    throw error
  }
  if (entries.length === 0) {
    try { await fs.rmdir(projectsDir) } catch {}
    return { archived: false, alreadyArchived: false, movedTo: null, count: 0 }
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const archiveRoot = path.join(ctx.dataDir, 'archive')
  const movedTo = path.join(archiveRoot, `project-policy-${stamp}`)
  await fs.mkdir(archiveRoot, { recursive: true })
  await fs.rename(projectsDir, movedTo)
  await writeJsonAtomic(markerFile, {
    schemaVersion: 1,
    archivedAt: nowIso(),
    movedTo,
    count: entries.length,
    note: 'Legacy project-level policies were archived. skill-scope now uses global + thread only; merge manually if needed.'
  })
  await appendAudit(ctx, { source: 'migration', action: 'project-policies-archived', details: { movedTo, count: entries.length } })
  return { archived: true, alreadyArchived: false, movedTo, count: entries.length }
}

export async function getMigrationInfo(ctx) {
  const marker = await readJson(path.join(policyRoot(ctx), 'migration-project-archive.json'), null)
  return {
    schemaVersion: 1,
    archived: Boolean(marker?.archivedAt),
    movedTo: marker?.movedTo || null,
    count: marker?.count || 0,
    note: marker?.note || null
  }
}

async function loadLinks(ctx) {
  const parsed = await readJson(path.join(policyRoot(ctx), 'links.json'), null)
  if (parsed === null) return { schemaVersion: POLICY_SCHEMA_VERSION, updatedAt: nowIso(), links: {} }
  return { schemaVersion: POLICY_SCHEMA_VERSION, updatedAt: parsed.updatedAt || nowIso(), links: parsed.links || {} }
}

async function saveLinks(ctx, links) {
  links.schemaVersion = POLICY_SCHEMA_VERSION
  links.updatedAt = nowIso()
  await writeJsonAtomic(path.join(policyRoot(ctx), 'links.json'), links)
}

export async function removeLinkLedgerEntry(ctx, linkPath) {
  const links = await loadLinks(ctx)
  delete links.links[path.resolve(linkPath)]
  await saveLinks(ctx, links)
}

export async function addLinkLedgerEntry(ctx, linkPath, record) {
  const links = await loadLinks(ctx)
  links.links[path.resolve(linkPath)] = {
    scope: 'global',
    skill: record.skill,
    sourcePath: record.sourcePath,
    createdAt: nowIso(),
    source: record.source || 'cli'
  }
  await saveLinks(ctx, links)
}

async function loadPlans(ctx) {
  const parsed = await readJson(path.join(policyRoot(ctx), 'plans.json'), null)
  return parsed?.plans && typeof parsed.plans === 'object' ? parsed.plans : {}
}

async function savePlans(ctx, plans) {
  await writeJsonAtomic(path.join(policyRoot(ctx), 'plans.json'), { schemaVersion: POLICY_SCHEMA_VERSION, updatedAt: nowIso(), plans })
}

async function loadTransactions(ctx) {
  const parsed = await readJson(path.join(policyRoot(ctx), 'transactions.json'), null)
  return parsed?.transactions && typeof parsed.transactions === 'object' ? parsed.transactions : {}
}

async function saveTransactions(ctx, transactions) {
  await writeJsonAtomic(path.join(policyRoot(ctx), 'transactions.json'), { schemaVersion: POLICY_SCHEMA_VERSION, updatedAt: nowIso(), transactions })
}

export async function listTransactions(ctx) {
  const transactions = await loadTransactions(ctx)
  return Object.values(transactions).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)))
}

export async function appendAudit(ctx, entry) {
  const file = path.join(policyRoot(ctx), 'audit.jsonl')
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, JSON.stringify({
    ts: nowIso(),
    source: entry.source || 'unknown',
    action: entry.action || 'unknown',
    details: entry.details || {}
  }) + '\n', 'utf8')
}

export async function listAudit(ctx, limit = 300) {
  const file = path.join(policyRoot(ctx), 'audit.jsonl')
  try {
    const raw = await fs.readFile(file, 'utf8')
    return raw.split(/\r?\n/).filter(Boolean).map((line) => {
      try { return JSON.parse(line) } catch { return null }
    }).filter(Boolean).slice(-limit).reverse()
  } catch {
    return []
  }
}

function linkTargetFor(ctx, skill) {
  return path.join(ctx.globalRoot, normalizeSkillName(skill))
}

async function pathState(target) {
  try {
    const stat = await fs.lstat(target)
    let realPath = null
    try { realPath = await fs.realpath(target) } catch {}
    return { exists: true, isSymlink: stat.isSymbolicLink(), isDirectory: stat.isDirectory(), realPath }
  } catch (error) {
    if (error?.code === 'ENOENT') return { exists: false, isSymlink: false, isDirectory: false, realPath: null }
    throw error
  }
}

function backupDest(ctx, txnId, targetPath) {
  return path.join(policyRoot(ctx), 'backup', txnId, path.basename(targetPath))
}

async function moveToBackup(targetPath, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true })
  let dest = destination
  let suffix = 1
  while (fsSync.existsSync(dest)) {
    dest = `${destination}.${suffix}`
    suffix += 1
  }
  await fs.rename(targetPath, dest)
  return dest
}

async function createManagedLink(ctx, txnId, change, source) {
  const { linkPath, sourcePath } = change
  if (path.resolve(linkPath) === path.resolve(sourcePath)) {
    return { ...change, action: 'noop', status: 'applied', reason: 'SOURCE_ALREADY_DISCOVERABLE' }
  }
  await fs.mkdir(path.dirname(linkPath), { recursive: true })
  const current = await pathState(linkPath)
  const backupPath = current.exists ? await moveToBackup(linkPath, backupDest(ctx, txnId, linkPath)) : null
  await fs.symlink(sourcePath, linkPath, 'dir')
  const links = await loadLinks(ctx)
  links.links[linkPath] = {
    scope: 'global',
    skill: change.skill,
    sourcePath,
    createdAt: nowIso(),
    source
  }
  await saveLinks(ctx, links)
  return { ...change, action: 'link-create', backupPath, replaced: Boolean(backupPath), status: 'applied' }
}

async function removeManagedLink(ctx, txnId, change, source) {
  const { linkPath } = change
  const current = await pathState(linkPath)
  if (!current.exists) {
    const links = await loadLinks(ctx)
    delete links.links[linkPath]
    await saveLinks(ctx, links)
    return { ...change, action: 'link-remove', backupPath: null, status: 'applied' }
  }
  if (!current.isSymlink) {
    return { ...change, action: 'link-remove', status: 'blocked', reason: 'Target is a real directory; refusing to touch it. Move it manually or reset the policy.' }
  }
  const sourceReal = change.sourcePath ? await fs.realpath(change.sourcePath).catch(() => null) : null
  if (change.sourcePath && current.realPath && sourceReal && path.resolve(current.realPath) !== path.resolve(sourceReal)) {
    return { ...change, action: 'link-remove', status: 'blocked', reason: 'Symlink points to a different target than managed; refusing to remove it.' }
  }
  const backupPath = await moveToBackup(linkPath, backupDest(ctx, txnId, linkPath))
  const links = await loadLinks(ctx)
  delete links.links[linkPath]
  await saveLinks(ctx, links)
  return { ...change, action: 'link-remove', backupPath, status: 'applied' }
}

async function sourcePathFor(ctx, skill, skillSources) {
  const name = normalizeSkillName(skill)
  if (skillSources?.[name]?.path) return skillSources[name].path
  const managed = path.join(ctx.dataDir, 'skills', name)
  if (fsSync.existsSync(path.join(managed, 'SKILL.md'))) return managed
  return null
}

async function buildChanges(ctx, operations, skillSources, source) {
  const changes = []
  const risks = []
  for (const op of operations) {
    const scope = normalizeScope(op.scope)
    const target = scope === 'thread' ? (op.target || op.threadId || null) : null
    const skill = op.skill ? normalizeSkillName(op.skill) : null
    if (scope === 'thread' && !target) {
      risks.push({ code: 'MISSING_THREAD', message: 'Thread scope requires a thread id' })
      continue
    }
    if (!skill && !op.all) {
      risks.push({ code: 'MISSING_SKILL', message: 'Each operation needs a skill name (or all=true)' })
      continue
    }
    if (op.action === 'set') {
      const policy = await loadScopePolicy(ctx, scope, target)
      const before = {
        enabled: policy.enabled[skill] || null,
        disabled: policy.disabled[skill] || null
      }
      changes.push({
        kind: 'policy',
        action: 'set',
        scope,
        target: scope === 'thread' ? sanitizeThreadId(target) : null,
        skill,
        enabled: Boolean(op.enabled),
        before,
        after: { enabled: op.enabled ? { updatedAt: nowIso(), source } : null, disabled: op.enabled ? null : { updatedAt: nowIso(), source } }
      })
      if (scope === 'global') {
        const linkPath = linkTargetFor(ctx, skill)
        if (op.enabled) {
          const sourcePath = await sourcePathFor(ctx, skill, skillSources)
          if (!sourcePath) {
            risks.push({ code: 'SOURCE_MISSING', skill, message: `No canonical SKILL.md directory found for "${skill}" in the managed library or global skills root` })
            changes.push({ kind: 'link', action: 'blocked', scope, skill, linkPath, reason: 'SOURCE_MISSING' })
            continue
          }
          if (path.resolve(linkPath) === path.resolve(sourcePath)) {
            changes.push({ kind: 'link', action: 'noop', scope, skill, linkPath, sourcePath, reason: 'SOURCE_ALREADY_DISCOVERABLE' })
            continue
          }
          const links = await loadLinks(ctx)
          const current = await pathState(linkPath)
          if (current.exists && !current.isSymlink) {
            risks.push({ code: 'TARGET_EXISTS', skill, message: `${linkPath} already exists as a real directory; it will be backed up before linking` })
          }
          changes.push({ kind: 'link', action: 'create', scope, skill, linkPath, sourcePath, managed: Boolean(links.links[linkPath]) })
        } else {
          const links = await loadLinks(ctx)
          if (links.links[linkPath]) {
            changes.push({ kind: 'link', action: 'remove', scope, skill, linkPath, sourcePath: links.links[linkPath].sourcePath })
          } else if ((await pathState(linkPath)).exists) {
            risks.push({ code: 'UNMANAGED_LINK', skill, message: `${linkPath} exists but is not managed by skill-scope; policy will be recorded but the filesystem entry is left untouched` })
          }
        }
      }
    } else if (op.action === 'reset') {
      const policy = await loadScopePolicy(ctx, scope, target)
      const before = { enabled: {}, disabled: {} }
      if (op.all) {
        before.enabled = { ...policy.enabled }
        before.disabled = { ...policy.disabled }
      } else {
        before.enabled = policy.enabled[skill] ? { [skill]: policy.enabled[skill] } : {}
        before.disabled = policy.disabled[skill] ? { [skill]: policy.disabled[skill] } : {}
      }
      changes.push({
        kind: 'policy',
        action: 'reset',
        scope,
        target: scope === 'thread' ? sanitizeThreadId(target) : null,
        skill,
        all: Boolean(op.all),
        before,
        after: { enabled: {}, disabled: {} }
      })
      if (scope === 'global') {
        const linkPath = linkTargetFor(ctx, skill)
        const links = await loadLinks(ctx)
        const policyBefore = await loadScopePolicy(ctx, 'global', null)
        if ((op.all || Boolean(policyBefore.enabled[skill])) && links.links[linkPath]) {
          changes.push({ kind: 'link', action: 'remove', scope, skill, linkPath, sourcePath: links.links[linkPath].sourcePath })
        }
      }
    }
  }
  return { changes, risks }
}

export async function createPlan(ctx, operations, skillSources = null, { source = 'cli' } = {}) {
  if (!Array.isArray(operations) || operations.length === 0) {
    throw new PolicyError('EMPTY_OPERATIONS', 'At least one operation is required')
  }
  const planId = `plan_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`
  const { changes, risks } = await buildChanges(ctx, operations, skillSources, source)
  const plan = {
    id: planId,
    schemaVersion: POLICY_SCHEMA_VERSION,
    createdAt: nowIso(),
    expiresAt: new Date(Date.now() + 30 * 60 * 1000).toISOString(),
    source,
    operations: operations.map((op) => ({ ...op })),
    changes,
    risks,
    applied: false
  }
  const plans = await loadPlans(ctx)
  plans[planId] = plan
  await savePlans(ctx, plans)
  await appendAudit(ctx, { source, action: 'plan-created', details: { planId, operations: operations.length, changes: changes.length, risks: risks.length } })
  return plan
}

async function applyPolicyChange(ctx, change, source) {
  if (change.kind !== 'policy') return null
  const target = change.target
  const policy = await loadScopePolicy(ctx, change.scope, target)
  if (change.action === 'set') {
    const fromSet = change.enabled ? 'disabled' : 'enabled'
    const toSet = change.enabled ? 'enabled' : 'disabled'
    delete policy[fromSet][change.skill]
    policy[toSet][change.skill] = { updatedAt: nowIso(), reason: null, source }
  } else if (change.action === 'reset') {
    if (change.all) {
      policy.enabled = {}
      policy.disabled = {}
    } else {
      delete policy.enabled[change.skill]
      delete policy.disabled[change.skill]
    }
  }
  await saveScopePolicy(ctx, policy)
  return { ...change, status: 'applied' }
}

export async function applyPlan(ctx, planId, { source = 'cli' } = {}) {
  const plans = await loadPlans(ctx)
  const plan = plans[planId]
  if (!plan) throw new PolicyError('PLAN_NOT_FOUND', `Plan ${planId} was not found`)
  if (plan.applied) throw new PolicyError('PLAN_ALREADY_APPLIED', `Plan ${planId} was already applied`)
  if (new Date(plan.expiresAt).getTime() < Date.now()) {
    throw new PolicyError('PLAN_EXPIRED', `Plan ${planId} expired; create a fresh plan`)
  }
  const txnId = `txn_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`
  const applied = []
  for (const change of plan.changes) {
    if (change.kind === 'policy') {
      applied.push(await applyPolicyChange(ctx, change, source))
    } else if (change.kind === 'link') {
      if (change.action === 'create') applied.push(await createManagedLink(ctx, txnId, change, source))
      else if (change.action === 'remove') applied.push(await removeManagedLink(ctx, txnId, change, source))
      else applied.push({ ...change, status: change.action === 'noop' ? 'applied' : 'blocked' })
    }
  }
  const transactions = await loadTransactions(ctx)
  transactions[txnId] = {
    id: txnId,
    schemaVersion: POLICY_SCHEMA_VERSION,
    planId,
    createdAt: nowIso(),
    source,
    operations: plan.operations,
    changes: applied,
    status: 'applied',
    rolledBackAt: null
  }
  await saveTransactions(ctx, transactions)
  plan.applied = true
  plan.appliedAt = nowIso()
  plan.transactionId = txnId
  await savePlans(ctx, plans)
  await appendAudit(ctx, { source, action: 'plan-applied', details: { planId, txnId, changes: applied.length } })
  return transactions[txnId]
}

export async function applyOperations(ctx, operations, skillSources = null, { source = 'cli' } = {}) {
  const plan = await createPlan(ctx, operations, skillSources, { source })
  return applyPlan(ctx, plan.id, { source })
}

async function restorePolicySnapshot(ctx, change) {
  const target = change.target
  const policy = await loadScopePolicy(ctx, change.scope, target)
  if (change.action === 'set') {
    delete policy.enabled[change.skill]
    delete policy.disabled[change.skill]
    if (change.before.enabled) policy.enabled[change.skill] = change.before.enabled
    if (change.before.disabled) policy.disabled[change.skill] = change.before.disabled
  } else if (change.action === 'reset') {
    policy.enabled = { ...change.before.enabled }
    policy.disabled = { ...change.before.disabled }
  }
  await saveScopePolicy(ctx, policy)
}

export async function rollbackTransaction(ctx, txnId, { source = 'cli' } = {}) {
  const transactions = await loadTransactions(ctx)
  const transaction = transactions[txnId]
  if (!transaction) throw new PolicyError('TRANSACTION_NOT_FOUND', `Transaction ${txnId} was not found`)
  if (transaction.status === 'rolled-back') throw new PolicyError('ALREADY_ROLLED_BACK', `Transaction ${txnId} was already rolled back`)
  const restored = []
  for (const change of [...transaction.changes].reverse()) {
    if (change.kind === 'link' && change.action === 'link-create' && change.status === 'applied') {
      const current = await pathState(change.linkPath)
      const sourceReal = change.sourcePath ? await fs.realpath(change.sourcePath).catch(() => null) : null
      if (current.exists && current.isSymlink && (!change.sourcePath || (current.realPath && sourceReal && path.resolve(current.realPath) === path.resolve(sourceReal)))) {
        await moveToBackup(change.linkPath, backupDest(ctx, `rollback-${txnId}`, change.linkPath))
        const links = await loadLinks(ctx)
        delete links.links[change.linkPath]
        await saveLinks(ctx, links)
      }
      if (change.backupPath && fsSync.existsSync(change.backupPath)) {
        await fs.mkdir(path.dirname(change.linkPath), { recursive: true })
        await fs.rename(change.backupPath, change.linkPath)
      }
      restored.push({ ...change, status: 'restored' })
    } else if (change.kind === 'link' && change.action === 'link-remove' && change.status === 'applied' && change.backupPath) {
      if (fsSync.existsSync(change.backupPath)) {
        await fs.mkdir(path.dirname(change.linkPath), { recursive: true })
        await fs.rename(change.backupPath, change.linkPath)
        const links = await loadLinks(ctx)
        links.links[change.linkPath] = {
          scope: 'global',
          skill: change.skill,
          sourcePath: change.sourcePath,
          createdAt: nowIso(),
          source
        }
        await saveLinks(ctx, links)
      }
      restored.push({ ...change, status: 'restored' })
    } else if (change.kind === 'policy' && change.status === 'applied') {
      await restorePolicySnapshot(ctx, change)
      restored.push({ ...change, status: 'restored' })
    }
  }
  transaction.status = 'rolled-back'
  transaction.rolledBackAt = nowIso()
  transaction.restoredChanges = restored
  await saveTransactions(ctx, transactions)
  await appendAudit(ctx, { source, action: 'transaction-rolled-back', details: { txnId, restored: restored.length } })
  return transaction
}

export async function doctor(ctx) {
  const differences = []
  const links = await loadLinks(ctx)
  const global = await loadScopePolicy(ctx, 'global', null)
  for (const [skill] of Object.entries(global.enabled || {})) {
    const linkPath = linkTargetFor(ctx, skill)
    const state = await pathState(linkPath)
    if (!state.exists) {
      differences.push({ code: 'GLOBAL_LINK_MISSING', severity: 'warn', scope: 'global', skill, message: `Global enabled skill "${skill}" has no symlink at ${linkPath}`, fix: `skill-scope policy enable --scope global --skill ${skill} --apply` })
    }
  }
  for (const [skill] of Object.entries(global.disabled || {})) {
    const linkPath = linkTargetFor(ctx, skill)
    if (links.links[linkPath]) {
      differences.push({ code: 'GLOBAL_LINK_ORPHANED', severity: 'warn', scope: 'global', skill, message: `Global disabled skill "${skill}" still has a managed symlink`, fix: `skill-scope policy disable --scope global --skill ${skill} --apply` })
    }
  }
  for (const [linkPath, record] of Object.entries(links.links || {})) {
    const state = await pathState(linkPath)
    if (!state.exists) {
      differences.push({ code: 'LEDGER_LINK_MISSING', severity: 'info', scope: 'global', skill: record.skill, message: `Managed symlink ${linkPath} is missing from disk`, fix: 'Run the matching policy enable/disable with --apply, or reset the scope' })
    }
  }
  return {
    schemaVersion: 1,
    scannedAt: nowIso(),
    dataDir: ctx.dataDir,
    stats: { differences: differences.length, warn: differences.filter((entry) => entry.severity === 'warn').length, info: differences.filter((entry) => entry.severity === 'info').length },
    differences,
    healthy: differences.length === 0
  }
}

export const engine = {
  PolicyError,
  resolveContext,
  normalizeScope,
  normalizeSkillName,
  sanitizeThreadId,
  loadScopePolicy,
  saveScopePolicy,
  setSkillPolicy,
  resetScopePolicy,
  resolveEffective,
  resolveAllEffective,
  getActiveSkills,
  listScopes,
  migrateProjectPolicies,
  getMigrationInfo,
  createPlan,
  applyPlan,
  applyOperations,
  rollbackTransaction,
  listTransactions,
  listAudit,
  appendAudit,
  removeLinkLedgerEntry,
  addLinkLedgerEntry,
  doctor
}

export default engine
