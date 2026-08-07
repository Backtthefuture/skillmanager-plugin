// skill-scope skill library: scan, delete/restore (trash), SkillsMP/GitHub install.
import fs from 'fs/promises'
import fsSync from 'fs'
import path from 'path'
import os from 'os'
import { execFile } from 'child_process'
import crypto from 'crypto'
import {
  PolicyError,
  normalizeSkillName,
  loadScopePolicy,
  saveScopePolicy,
  resolveEffective,
  applyOperations,
  appendAudit,
  removeLinkLedgerEntry,
  addLinkLedgerEntry
} from './policy.js'

const PROTECTED_SKILLS = new Set(['skill-scope', 'skill-scope-guard'])
const SKILLSMP_URL = 'https://skillsmp.com'

export class SkillLibraryError extends Error {
  constructor(code, message, details = undefined) {
    super(message)
    this.name = 'SkillLibraryError'
    this.code = code
    this.details = details
  }
}

function managedRoot(ctx) {
  return path.join(ctx.dataDir, 'skills')
}

function trashRoot(ctx) {
  return path.join(ctx.dataDir, 'trash')
}

function nowStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export function parseFrontmatter(contents) {
  const match = String(contents).match(/^---\r?\n([\s\S]*?)\r?\n---/)
  if (!match) return { name: null, description: null, agent: null }
  const get = (key) => {
    const line = match[1].match(new RegExp(`^${key}\\s*:\\s*(.+)$`, 'm'))
    if (!line) return null
    const value = line[1].trim()
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      return value.slice(1, -1)
    }
    return value
  }
  return { name: get('name'), description: get('description'), agent: get('agent') }
}

async function readSkillMeta(dirPath) {
  try {
    const contents = await fs.readFile(path.join(dirPath, 'SKILL.md'), 'utf8')
    const fm = parseFrontmatter(contents)
    const name = normalizeSkillName(fm.name || path.basename(dirPath))
    return { name, description: fm.description || '', agent: fm.agent || null }
  } catch {
    return null
  }
}

async function pluginProvidedSkills(ctx) {
  const skillsDir = path.join(ctx.pluginRoot, 'skills')
  try {
    const entries = await fs.readdir(skillsDir, { withFileTypes: true })
    return new Set(entries.filter((entry) => entry.isDirectory()).map((entry) => normalizeSkillName(entry.name)))
  } catch {
    return new Set()
  }
}

export async function isProtectedSkill(ctx, name) {
  const normalized = normalizeSkillName(name)
  if (PROTECTED_SKILLS.has(normalized)) return true
  return (await pluginProvidedSkills(ctx)).has(normalized)
}

async function sourceMarker(ctx, name) {
  try {
    const parsed = JSON.parse(await fs.readFile(path.join(managedRoot(ctx), name, '.skill-scope-source.json'), 'utf8'))
    return parsed || null
  } catch {
    return null
  }
}

export async function scanSkills(ctx, { threadId = null } = {}) {
  const skills = []
  const seen = new Map()
  const managed = managedRoot(ctx)
  const managedEntries = []
  try {
    managedEntries.push(...await fs.readdir(managed, { withFileTypes: true }))
  } catch {
  }
  for (const entry of managedEntries) {
    if (!entry.isDirectory()) continue
    const dirPath = path.join(managed, entry.name)
    const meta = await readSkillMeta(dirPath)
    if (!meta) continue
    const marker = await sourceMarker(ctx, meta.name)
    const record = {
      name: meta.name,
      description: meta.description,
      agent: meta.agent,
      source: marker ? 'skillsmp' : 'managed',
      repo: marker?.repo || null,
      installedAt: marker?.installedAt || null,
      managed: true,
      path: dirPath,
      deleted: false
    }
    skills.push(record)
    seen.set(record.name, record)
  }
  const globalEntries = []
  try {
    globalEntries.push(...await fs.readdir(ctx.globalRoot, { withFileTypes: true }))
  } catch {
  }
  for (const entry of globalEntries) {
    if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
    const entryPath = path.join(ctx.globalRoot, entry.name)
    let realPath = entryPath
    try {
      realPath = await fs.realpath(entryPath)
    } catch {
      continue
    }
    if (path.resolve(realPath).startsWith(path.resolve(managed) + path.sep)) continue
    const meta = await readSkillMeta(realPath)
    if (!meta) continue
    if (seen.has(meta.name)) {
      seen.get(meta.name).conflict = true
      continue
    }
    const record = {
      name: meta.name,
      description: meta.description,
      agent: meta.agent,
      source: 'user',
      repo: null,
      installedAt: null,
      managed: false,
      path: realPath,
      deleted: false
    }
    skills.push(record)
    seen.set(record.name, record)
  }
  for (const skill of skills) {
    const effective = await resolveEffective(ctx, { skill: skill.name, threadId })
    skill.effective = { enabled: effective.enabled, source: effective.source, reason: effective.reason || null }
    const globalPolicy = await loadScopePolicy(ctx, 'global', null)
    if (globalPolicy.disabled?.[skill.name]) skill.scopeState = { state: 'disabled' }
    else if (globalPolicy.enabled?.[skill.name]) skill.scopeState = { state: 'enabled' }
    else skill.scopeState = { state: 'inherit' }
  }
  skills.sort((a, b) => a.name.localeCompare(b.name))
  return {
    schemaVersion: 1,
    scannedAt: new Date().toISOString(),
    threadId,
    stats: {
      total: skills.length,
      managed: skills.filter((skill) => skill.managed).length,
      user: skills.filter((skill) => !skill.managed).length,
      skillsmp: skills.filter((skill) => skill.source === 'skillsmp').length
    },
    skills
  }
}

function sourcePriority(source) {
  if (source === 'managed' || source === 'skillsmp') return 4
  if (source === 'user') return 3
  if (source === 'plugin') return 2
  if (source === 'system') return 1
  return 0
}

async function codexPluginRoots() {
  try {
    const output = await new Promise((resolve, reject) => {
      execFile('codex', ['plugin', 'list', '--json'], { timeout: 10000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      })
    })
    const payload = JSON.parse(output)
    return (payload.installed || [])
      .filter((plugin) => plugin.enabled !== false && plugin.source?.path)
      .map((plugin) => path.resolve(plugin.source.path))
  } catch {
    return []
  }
}

async function cachePluginRoots(home) {
  const cacheRoot = path.join(home, '.codex', 'plugins', 'cache')
  const roots = []
  try {
    const marketplaces = await fs.readdir(cacheRoot, { withFileTypes: true })
    for (const marketplace of marketplaces) {
      if (!marketplace.isDirectory()) continue
      const marketplaceDir = path.join(cacheRoot, marketplace.name)
      const plugins = await fs.readdir(marketplaceDir, { withFileTypes: true }).catch(() => [])
      for (const plugin of plugins) {
        if (!plugin.isDirectory()) continue
        const pluginDir = path.join(marketplaceDir, plugin.name)
        const versions = await fs.readdir(pluginDir, { withFileTypes: true }).catch(() => [])
        for (const version of versions) {
          if (!version.isDirectory()) continue
          const root = path.join(pluginDir, version.name)
          if (fsSync.existsSync(path.join(root, '.codex-plugin', 'plugin.json'))) roots.push(root)
        }
      }
    }
  } catch {
  }
  return roots
}

export async function pluginRootsFor(ctx) {
  const envRoots = process.env.SKILL_SCOPE_PLUGIN_ROOTS?.split(/[:,]/).map((value) => value.trim()).filter(Boolean)
  if (envRoots && envRoots.length > 0) {
    return envRoots.map((value) => path.resolve(value))
  }
  const codexRoots = await codexPluginRoots()
  if (codexRoots.length > 0) return codexRoots
  return cachePluginRoots(ctx.home)
}

async function pluginSkillRoots(pluginRoot) {
  const candidates = []
  try {
    const manifest = JSON.parse(await fs.readFile(path.join(pluginRoot, '.codex-plugin', 'plugin.json'), 'utf8'))
    if (typeof manifest.skills === 'string' && manifest.skills.trim()) {
      candidates.push(path.resolve(pluginRoot, manifest.skills.trim()))
    }
  } catch {
  }
  candidates.push(path.join(pluginRoot, 'skills'))
  const found = []
  for (const candidate of candidates) {
    try {
      const stat = await fs.stat(candidate)
      if (stat.isDirectory() && !found.includes(candidate)) found.push(candidate)
    } catch {
    }
  }
  return found
}

async function scanDirectorySkills(dir, source, records, seen) {
  let entries
  try {
    entries = await fs.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const dirPath = path.join(dir, entry.name)
    const meta = await readSkillMeta(dirPath)
    if (!meta) continue
    const record = {
      name: meta.name,
      description: meta.description,
      agent: meta.agent,
      source,
      path: dirPath,
      managed: source === 'managed' || source === 'skillsmp',
      protected: PROTECTED_SKILLS.has(meta.name),
      broken: false,
      conflict: false
    }
    const priority = sourcePriority(record.source)
    const existing = seen.get(record.name)
    if (!existing) {
      seen.set(record.name, { ...record, priority })
    } else {
      existing.conflict = true
      if (priority > existing.priority) {
        seen.set(record.name, { ...record, priority, conflict: true })
      } else if (priority === existing.priority) {
        record.conflict = true
      }
    }
  }
}

export async function scanAllSkills(ctx, { threadId = null } = {}) {
  const seen = new Map()
  const records = []
  const managed = managedRoot(ctx)

  // 1) managed library + SkillsMP
  await scanDirectorySkills(managed, 'managed', records, seen)
  try {
    const entries = await fs.readdir(managed, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const marker = await sourceMarker(ctx, entry.name)
      if (marker && seen.has(entry.name)) {
        seen.get(entry.name).source = 'skillsmp'
        seen.get(entry.name).managed = true
        seen.get(entry.name).repo = marker.repo || null
        seen.get(entry.name).installedAt = marker.installedAt || null
      }
    }
  } catch {
  }

  // 2) user / system global skills (one level of subdirectories, e.g. .system/)
  try {
    const entries = await fs.readdir(ctx.globalRoot, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(ctx.globalRoot, entry.name)
      let realPath = entryPath
      let broken = false
      if (entry.isSymbolicLink()) {
        try {
          realPath = await fs.realpath(entryPath)
        } catch {
          broken = true
        }
      }
      if (broken) {
        const name = normalizeSkillName(entry.name)
        const record = {
          name,
          description: '(损坏的符号链接)',
          agent: null,
          source: 'user',
          path: entryPath,
          managed: false,
          protected: PROTECTED_SKILLS.has(name),
          broken: true,
          conflict: false
        }
        const priority = 0
        const existing = seen.get(name)
        if (!existing) {
          seen.set(name, { ...record, priority })
        } else {
          existing.conflict = true
        }
        continue
      }
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue
      if (path.resolve(realPath).startsWith(path.resolve(managed) + path.sep)) continue
      const directMeta = await readSkillMeta(realPath)
      if (directMeta) {
        const source = entry.name === '.system' ? 'system' : 'user'
        const record = {
          name: directMeta.name,
          description: directMeta.description,
          agent: directMeta.agent,
          source,
          path: realPath,
          managed: false,
          protected: PROTECTED_SKILLS.has(directMeta.name),
          broken: false,
          conflict: false
        }
        const priority = sourcePriority(source)
        const existing = seen.get(record.name)
        if (!existing) {
          seen.set(record.name, { ...record, priority })
        } else {
          existing.conflict = true
          if (priority > existing.priority) {
            seen.set(record.name, { ...record, priority, conflict: true })
          } else if (priority === existing.priority) {
            record.conflict = true
          }
        }
        continue
      }
      if (entry.isDirectory()) {
        const source = entry.name === '.system' ? 'system' : 'user'
        await scanDirectorySkills(entryPath, source, records, seen)
      }
    }
  } catch {
  }

  // 3) plugin skills (codex plugin list + cache fallback)
  const pluginRoots = await pluginRootsFor(ctx)
  for (const pluginRoot of pluginRoots) {
    if (!fsSync.existsSync(path.join(pluginRoot, '.codex-plugin', 'plugin.json'))) continue
    const skillDirs = await pluginSkillRoots(pluginRoot)
    for (const skillDir of skillDirs) {
      await scanDirectorySkills(skillDir, 'plugin', records, seen)
    }
  }

  const skillsList = []
  for (const [name, record] of seen) {
    const effective = await resolveEffective(ctx, { skill: name, threadId })
    const globalPolicy = await loadScopePolicy(ctx, 'global', null)
    const threadPolicy = threadId ? await loadScopePolicy(ctx, 'thread', threadId) : null
    const globalState = globalPolicy?.enabled?.[name] ? 'enabled'
      : globalPolicy?.disabled?.[name] ? 'disabled'
        : 'inherit'
    const threadState = threadPolicy?.enabled?.[name] ? 'enabled'
      : threadPolicy?.disabled?.[name] ? 'disabled'
        : 'inherit'
    skillsList.push({
      name,
      description: record.description,
      agent: record.agent || null,
      source: record.source,
      path: record.path,
      managed: Boolean(record.managed),
      protected: Boolean(record.protected),
      canDelete: Boolean(record.managed) && !record.protected,
      broken: Boolean(record.broken),
      conflict: Boolean(record.conflict),
      repo: record.repo || null,
      installedAt: record.installedAt || null,
      globalState,
      threadState,
      effective: { enabled: effective.enabled, source: effective.source, reason: effective.reason || null }
    })
  }
  skillsList.sort((a, b) => a.name.localeCompare(b.name))
  const bySource = {
    system: skillsList.filter((skill) => skill.source === 'system' && !skill.broken).length,
    plugin: skillsList.filter((skill) => skill.source === 'plugin' && !skill.broken).length,
    user: skillsList.filter((skill) => skill.source === 'user' && !skill.broken).length,
    managed: skillsList.filter((skill) => skill.source === 'managed' && !skill.broken).length,
    skillsmp: skillsList.filter((skill) => skill.source === 'skillsmp' && !skill.broken).length
  }
  return {
    schemaVersion: 1,
    scannedAt: new Date().toISOString(),
    threadId,
    stats: {
      total: skillsList.length,
      bySource,
      broken: skillsList.filter((skill) => skill.broken).length,
      protected: skillsList.filter((skill) => skill.protected).length
    },
    skills: skillsList
  }
}

async function collectPolicyReferences(ctx, name) {
  const refs = []
  const global = await loadScopePolicy(ctx, 'global', null)
  if (global.enabled?.[name] || global.disabled?.[name]) refs.push({ scope: 'global', state: global.enabled?.[name] ? 'enabled' : 'disabled' })
  const threadsDir = path.join(ctx.dataDir, 'policy', 'threads')
  try {
    const entries = await fs.readdir(threadsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const threadId = entry.name.replace(/\.json$/, '')
      const thread = await loadScopePolicy(ctx, 'thread', threadId)
      if (thread.enabled?.[name] || thread.disabled?.[name]) {
        refs.push({ scope: 'thread', threadId, state: thread.enabled?.[name] ? 'enabled' : 'disabled' })
      }
    }
  } catch {
  }
  return refs
}

async function cleanPolicyReferences(ctx, name, snapshot) {
  const global = await loadScopePolicy(ctx, 'global', null)
  delete global.enabled[name]
  delete global.disabled[name]
  await saveScopePolicy(ctx, global)
  for (const [threadId, threadSnapshot] of Object.entries(snapshot.threads || {})) {
    const thread = await loadScopePolicy(ctx, 'thread', threadId)
    delete thread.enabled[name]
    delete thread.disabled[name]
    await saveScopePolicy(ctx, thread)
  }
}

export async function deleteSkillPlan(ctx, name, { source = 'mcp' } = {}) {
  const normalized = normalizeSkillName(name)
  if (await isProtectedSkill(ctx, normalized)) {
    throw new SkillLibraryError('PROTECTED_SKILL', `${normalized} is a core/plugin-provided skill and cannot be deleted`)
  }
  const managedDir = path.join(managedRoot(ctx), normalized)
  if (!fsSync.existsSync(path.join(managedDir, 'SKILL.md'))) {
    throw new SkillLibraryError('NOT_MANAGED', `${normalized} is not managed by skill-scope; only managed or SkillsMP-installed skills can be deleted`)
  }
  const linkPath = path.join(ctx.globalRoot, normalized)
  const refs = await collectPolicyReferences(ctx, normalized)
  const changes = [
    { action: 'move-to-trash', target: managedDir },
    ...(fsSync.existsSync(linkPath) ? [{ action: 'remove-link', target: linkPath }] : []),
    { action: 'clean-policy', references: refs.length }
  ]
  return {
    schemaVersion: 1,
    skill: normalized,
    managedPath: managedDir,
    linkPath,
    changes,
    references: refs,
    risks: [],
    rollback_hint: `Restore with: skill-scope skill restore ${normalized}`
  }
}

export async function deleteSkill(ctx, name, { preview = true, source = 'mcp' } = {}) {
  const normalized = normalizeSkillName(name)
  const plan = await deleteSkillPlan(ctx, normalized, { source })
  if (preview) return { applied: false, plan }
  const stamp = nowStamp()
  const trashId = `${normalized}-${stamp}`
  const trashDir = path.join(trashRoot(ctx), trashId)
  const managedDir = path.join(managedRoot(ctx), normalized)
  const linkPath = path.join(ctx.globalRoot, normalized)
  const global = await loadScopePolicy(ctx, 'global', null)
  const threadSnapshot = {}
  const threadsDir = path.join(ctx.dataDir, 'policy', 'threads')
  try {
    const entries = await fs.readdir(threadsDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue
      const threadId = entry.name.replace(/\.json$/, '')
      const thread = await loadScopePolicy(ctx, 'thread', threadId)
      if (thread.enabled?.[normalized] || thread.disabled?.[normalized]) {
        threadSnapshot[threadId] = {
          enabled: thread.enabled?.[normalized] || null,
          disabled: thread.disabled?.[normalized] || null
        }
      }
    }
  } catch {
  }
  await fs.mkdir(trashDir, { recursive: true })
  await fs.rename(managedDir, path.join(trashDir, 'skill'))
  let linkMoved = false
  if (fsSync.existsSync(linkPath)) {
    try {
      await fs.rename(linkPath, path.join(trashDir, 'link'))
      linkMoved = true
      await removeLinkLedgerEntry(ctx, linkPath)
    } catch {
      // leave the link in place; restore will reconcile
    }
  }
  const meta = {
    schemaVersion: 1,
    originalName: normalized,
    deletedAt: new Date().toISOString(),
    source,
    managedPath: managedDir,
    linkPath,
    linkMoved,
    policySnapshot: {
      global: {
        enabled: global.enabled?.[normalized] || null,
        disabled: global.disabled?.[normalized] || null
      },
      threads: threadSnapshot
    }
  }
  await fs.writeFile(path.join(trashDir, '.skill-scope-trash.json'), JSON.stringify(meta, null, 2), 'utf8')
  await cleanPolicyReferences(ctx, normalized, { threads: threadSnapshot })
  await appendAudit(ctx, { source, action: 'skill-deleted', details: { skill: normalized, trashId } })
  return {
    applied: true,
    transactionId: `skill_delete_${trashId}`,
    skill: normalized,
    trashId,
    trashPath: trashDir,
    linkMoved,
    rollback_hint: `Restore with: skill-scope skill restore ${normalized}`
  }
}

export async function listTrash(ctx) {
  const root = trashRoot(ctx)
  const entries = []
  try {
    const dirs = await fs.readdir(root, { withFileTypes: true })
    for (const dir of dirs) {
      if (!dir.isDirectory()) continue
      try {
        const meta = JSON.parse(await fs.readFile(path.join(root, dir.name, '.skill-scope-trash.json'), 'utf8'))
        entries.push({ trashId: dir.name, path: path.join(root, dir.name), ...meta })
      } catch {
      }
    }
  } catch {
  }
  entries.sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')))
  return entries
}

export async function purgeTrash(ctx, trashId) {
  const safeId = String(trashId || '').trim()
  if (!/^[A-Za-z0-9._-]{1,200}$/.test(safeId)) {
    throw new SkillLibraryError('INVALID_TRASH_ID', 'Invalid trash id')
  }
  const root = trashRoot(ctx)
  const dir = path.join(root, safeId)
  if (!path.resolve(dir).startsWith(path.resolve(root) + path.sep)) {
    throw new SkillLibraryError('INVALID_TRASH_ID', 'Trash path escaped the trash root')
  }
  if (!fsSync.existsSync(dir)) {
    throw new SkillLibraryError('NOT_IN_TRASH', `Trash entry ${safeId} does not exist`)
  }
  await fs.rm(dir, { recursive: true, force: true })
  await appendAudit(ctx, { source: 'dashboard', action: 'trash-purged', details: { trashId: safeId } })
  return { ok: true, purged: safeId }
}

export async function restoreSkill(ctx, name, { source = 'mcp' } = {}) {
  const normalized = normalizeSkillName(name)
  const trashEntries = (await listTrash(ctx)).filter((entry) => entry.originalName === normalized)
  if (trashEntries.length === 0) {
    throw new SkillLibraryError('NOT_IN_TRASH', `${normalized} was not found in trash`)
  }
  const entry = trashEntries[0]
  const managedDir = path.join(managedRoot(ctx), normalized)
  if (fsSync.existsSync(path.join(managedDir, 'SKILL.md'))) {
    throw new SkillLibraryError('SKILL_EXISTS', `${normalized} already exists in the managed library`)
  }
  const skillDir = path.join(entry.path, 'skill')
  if (!fsSync.existsSync(path.join(skillDir, 'SKILL.md'))) {
    throw new SkillLibraryError('TRASH_INCOMPLETE', `Trash entry ${entry.trashId} is missing SKILL.md`)
  }
  await fs.mkdir(managedRoot(ctx), { recursive: true })
  await fs.rename(skillDir, managedDir)
  const snapshot = entry.policySnapshot || {}
  const global = await loadScopePolicy(ctx, 'global', null)
  delete global.enabled[normalized]
  delete global.disabled[normalized]
  if (snapshot.global?.enabled) global.enabled[normalized] = snapshot.global.enabled
  if (snapshot.global?.disabled) global.disabled[normalized] = snapshot.global.disabled
  await saveScopePolicy(ctx, global)
  for (const [threadId, threadSnapshot] of Object.entries(snapshot.threads || {})) {
    const thread = await loadScopePolicy(ctx, 'thread', threadId)
    delete thread.enabled[normalized]
    delete thread.disabled[normalized]
    if (threadSnapshot.enabled) thread.enabled[normalized] = threadSnapshot.enabled
    if (threadSnapshot.disabled) thread.disabled[normalized] = threadSnapshot.disabled
    await saveScopePolicy(ctx, thread)
  }
  let linkPath = null
  if (entry.linkMoved && fsSync.existsSync(path.join(entry.path, 'link'))) {
    linkPath = entry.linkPath || path.join(ctx.globalRoot, normalized)
    await fs.rename(path.join(entry.path, 'link'), linkPath)
    await addLinkLedgerEntry(ctx, linkPath, {
      skill: normalized,
      sourcePath: managedDir,
      source
    })
  } else if (snapshot.global?.enabled) {
    const transaction = await applyOperations(ctx, [{ action: 'set', scope: 'global', skill: normalized, enabled: true }], { [normalized]: { path: managedDir } }, { source })
    linkPath = transaction.changes.find((change) => change.kind === 'link' && change.action === 'link-create')?.linkPath || null
  }
  await appendAudit(ctx, { source, action: 'skill-restored', details: { skill: normalized, trashId: entry.trashId } })
  return {
    applied: true,
    transactionId: `skill_restore_${nowStamp()}`,
    skill: normalized,
    managedPath: managedDir,
    linkPath,
    restoredFrom: entry.trashId
  }
}

function repoFromSkillsmpPage(html) {
  const match = String(html).match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+/i)
  return match ? match[0].replace(/\/$/, '') : null
}

function repoUrlFromSource(source) {
  const value = String(source || '').trim()
  if (!value) return null
  if (value.startsWith('git@') || value.endsWith('.git') || /^https?:\/\/github\.com\//i.test(value)) return value
  if (value.startsWith('file://')) return value
  const ownerRepo = value.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  if (ownerRepo) return `https://github.com/${ownerRepo[1]}/${ownerRepo[2]}`
  return null
}

export async function resolveInstallSource(source, { allowNetwork = true } = {}) {
  const value = String(source || '').trim()
  if (fsSync.existsSync(value)) {
    return { kind: 'local', repoUrl: null, dir: path.resolve(value) }
  }
  if (/^https?:\/\/skillsmp\.com\//i.test(value)) {
    return { kind: 'skillsmp', pageUrl: value, repoUrl: null, dir: null }
  }
  const repoUrl = repoUrlFromSource(value)
  if (repoUrl) return { kind: 'git', repoUrl, dir: null }
  throw new SkillLibraryError('UNKNOWN_SOURCE', 'Source must be a local directory, SkillsMP page URL, GitHub URL, or owner/repo')
}

async function cloneRepo(repoUrl) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-scope-market-'))
  try {
    await new Promise((resolve, reject) => {
      execFile('git', ['clone', '--depth', '1', repoUrl, path.join(tmp, 'repo')], { timeout: 300000 }, (error, _stdout, stderr) => {
        if (error) reject(new SkillLibraryError('GIT_CLONE_FAILED', `git clone failed: ${stderr || error.message}`))
        else resolve()
      })
    })
    return path.join(tmp, 'repo')
  } catch (error) {
    await fs.rm(tmp, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

async function findSkillDir(repoDir, preferredName = null) {
  if (fsSync.existsSync(path.join(repoDir, 'SKILL.md'))) return repoDir
  const candidates = []
  async function walk(dir, depth) {
    if (depth > 5) return
    let entries
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === '.git' || entry.name === 'node_modules') continue
      const sub = path.join(dir, entry.name)
      if (fsSync.existsSync(path.join(sub, 'SKILL.md'))) candidates.push(sub)
      await walk(sub, depth + 1)
    }
  }
  await walk(repoDir, 0)
  if (candidates.length === 0) return null
  if (preferredName) {
    const byName = candidates.find((dir) => path.basename(dir) === preferredName)
    if (byName) return byName
    for (const candidate of candidates) {
      const meta = await readSkillMeta(candidate)
      if (meta?.name === preferredName) return candidate
    }
  }
  const repoBase = path.basename(repoDir)
  return candidates.find((dir) => path.basename(dir) === repoBase) || candidates[0]
}

async function copyTree(sourceDir, targetDir) {
  await fs.mkdir(targetDir, { recursive: true })
  await fs.cp(sourceDir, targetDir, {
    recursive: true,
    filter: (src) => {
      const base = path.basename(src)
      return base !== '.git' && base !== 'node_modules'
    }
  })
}

export async function installFromSource(ctx, source, { name = null, sourceLabel = 'mcp' } = {}) {
  const resolved = await resolveInstallSource(source)
  let repoDir = resolved.dir
  let tempRoot = null
  let repoUrl = resolved.repoUrl || null
  if (resolved.kind === 'skillsmp') {
    if (process.env.SKILL_SCOPE_NO_NETWORK === '1') {
      throw new SkillLibraryError('NETWORK_DISABLED', 'Network access is disabled for SkillsMP resolution')
    }
    const response = await fetch(resolved.pageUrl)
    if (!response.ok) throw new SkillLibraryError('SKILLSMP_FETCH_FAILED', `SkillsMP page returned ${response.status}`)
    const html = await response.text()
    repoUrl = repoFromSkillsmpPage(html)
    if (!repoUrl) throw new SkillLibraryError('SKILLSMP_NO_REPO', 'Could not find a GitHub repository link on the SkillsMP page')
  }
  if (resolved.kind === 'git' || resolved.kind === 'skillsmp') {
    repoDir = await cloneRepo(repoUrl)
    tempRoot = path.dirname(repoDir)
  }
  try {
    const skillDir = await findSkillDir(repoDir, name)
    if (!skillDir) throw new SkillLibraryError('SKILL_NOT_FOUND', 'No SKILL.md found in the repository (root or subdirectories)')
    const meta = await readSkillMeta(skillDir)
    if (!meta) throw new SkillLibraryError('INVALID_SKILL', 'SKILL.md frontmatter is missing or invalid')
    const skillName = normalizeSkillName(name || meta.name)
    if (await isProtectedSkill(ctx, skillName)) {
      throw new SkillLibraryError('PROTECTED_SKILL', `${skillName} is a core/plugin-provided skill and cannot be installed over`)
    }
    const managedDir = path.join(managedRoot(ctx), skillName)
    if (fsSync.existsSync(path.join(managedDir, 'SKILL.md'))) {
      throw new SkillLibraryError('SKILL_EXISTS', `${skillName} already exists in the managed library; delete it first or use another name`)
    }
    await copyTree(skillDir, managedDir)
    await fs.writeFile(path.join(managedDir, '.skill-scope-source.json'), JSON.stringify({
      schemaVersion: 1,
      installedAt: new Date().toISOString(),
      source: sourceLabel,
      repo: repoUrl,
      origin: source
    }, null, 2), 'utf8')
    const transaction = await applyOperations(ctx, [{ action: 'set', scope: 'global', skill: skillName, enabled: true }], { [skillName]: { path: managedDir } }, { source: sourceLabel })
    const linkPath = transaction.changes.find((change) => change.kind === 'link' && change.action === 'link-create')?.linkPath
      || path.join(ctx.globalRoot, skillName)
    await appendAudit(ctx, { source: sourceLabel, action: 'skill-installed', details: { skill: skillName, repo: repoUrl, origin: source } })
    return {
      applied: true,
      skill: skillName,
      description: meta.description,
      managedPath: managedDir,
      linkPath,
      repo: repoUrl,
      origin: source,
      transactionId: transaction.id
    }
  } finally {
    if (tempRoot) {
      await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
    }
  }
}

export async function openSkillsmp({ dryRun = false } = {}) {
  if (dryRun || process.env.SKILL_SCOPE_NO_OPEN === '1') {
    return { ok: true, opened: false, url: SKILLSMP_URL }
  }
  const command = process.platform === 'darwin' ? 'open'
    : process.platform === 'win32' ? 'cmd'
      : 'xdg-open'
  const args = process.platform === 'win32' ? ['/d', '/s', '/c', 'start', '', SKILLSMP_URL] : [SKILLSMP_URL]
  execFile(command, args, { detached: true, stdio: 'ignore' })
  return { ok: true, opened: true, url: SKILLSMP_URL }
}

export const skills = {
  SkillLibraryError,
  scanSkills,
  scanAllSkills,
  pluginRootsFor,
  deleteSkillPlan,
  deleteSkill,
  restoreSkill,
  listTrash,
  purgeTrash,
  installFromSource,
  resolveInstallSource,
  openSkillsmp,
  parseFrontmatter,
  isProtectedSkill
}

export default skills
