import test from 'node:test'
import assert from 'node:assert/strict'
import fsSync from 'node:fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const policy = await import(path.join(root, 'lib', 'policy.js'))

async function makeContext(overrides = {}) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-scope-policy-'))
  const ctx = policy.resolveContext({
    dataDir: path.join(base, 'data'),
    globalRoot: path.join(base, 'codex-skills'),
    pluginRoot: root,
    home: base,
    ...overrides
  })
  return { ctx, base }
}

async function makeLibrary(base, name) {
  const dir = path.join(base, 'lib', name)
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: Test skill.\n---\n# ${name}\n`, 'utf8')
  return dir
}

test('two layers: thread > global, inherit, default enabled, explicit disabled wins', async () => {
  const { ctx } = await makeContext()
  assert.equal((await policy.resolveEffective(ctx, { skill: 'alpha' })).enabled, true)
  assert.equal((await policy.resolveEffective(ctx, { skill: 'alpha' })).source, 'default')

  await policy.setSkillPolicy(ctx, { scope: 'global', skill: 'alpha', state: false })
  assert.equal((await policy.resolveEffective(ctx, { skill: 'alpha' })).source, 'global')
  assert.equal((await policy.resolveEffective(ctx, { skill: 'alpha' })).enabled, false)

  await policy.setSkillPolicy(ctx, { scope: 'thread', target: 'thread-1', skill: 'alpha', state: true })
  assert.equal((await policy.resolveEffective(ctx, { skill: 'alpha', threadId: 'thread-1' })).source, 'thread')
  assert.equal((await policy.resolveEffective(ctx, { skill: 'alpha', threadId: 'thread-1' })).enabled, true)

  const threadPolicy = await policy.loadScopePolicy(ctx, 'thread', 'thread-1')
  threadPolicy.enabled.alpha = { updatedAt: new Date().toISOString(), source: 'cli' }
  threadPolicy.disabled.alpha = { updatedAt: new Date().toISOString(), source: 'mcp' }
  await policy.saveScopePolicy(ctx, threadPolicy)
  assert.equal((await policy.resolveEffective(ctx, { skill: 'alpha', threadId: 'thread-1' })).enabled, false)
})

test('thread default-off classification disables unconfigured skills in threads until explicitly enabled', async () => {
  const { ctx } = await makeContext()
  await policy.setSkillDefault(ctx, { skill: 'alpha', threadDefault: 'disabled', reason: 'conversation-only', source: 'cli' })

  const inThread = await policy.resolveEffective(ctx, { skill: 'alpha', threadId: 'thread-1' })
  assert.equal(inThread.enabled, false)
  assert.equal(inThread.source, 'thread-default')
  assert.equal(inThread.reason, 'conversation-level default-off')

  // Without a thread id the classification still applies (global fallback is also a conversation).
  assert.equal((await policy.resolveEffective(ctx, { skill: 'alpha' })).enabled, false)

  // Explicit thread enable wins over the default-off classification.
  await policy.setSkillPolicy(ctx, { scope: 'thread', target: 'thread-1', skill: 'alpha', state: true })
  assert.equal((await policy.resolveEffective(ctx, { skill: 'alpha', threadId: 'thread-1' })).enabled, true)
  assert.equal((await policy.resolveEffective(ctx, { skill: 'alpha', threadId: 'thread-1' })).source, 'thread')

  // Explicit global enable also wins.
  await policy.setSkillPolicy(ctx, { scope: 'global', skill: 'alpha', state: true })
  assert.equal((await policy.resolveEffective(ctx, { skill: 'alpha', threadId: 'thread-2' })).enabled, true)
  assert.equal((await policy.resolveEffective(ctx, { skill: 'alpha', threadId: 'thread-2' })).source, 'global')

  // Removing the classification restores default-on for unconfigured threads.
  await policy.setSkillDefault(ctx, { skill: 'alpha', threadDefault: 'inherit' })
  assert.equal((await policy.resolveEffective(ctx, { skill: 'alpha', threadId: 'thread-2' })).enabled, true)
  assert.equal((await policy.resolveEffective(ctx, { skill: 'alpha', threadId: 'thread-2' })).source, 'global')
})

test('thread default plan applies and rolls back', async () => {
  const { ctx } = await makeContext()
  const transaction = await policy.applyOperations(ctx, [{ action: 'default', scope: 'global', skill: 'alpha', threadDefault: 'disabled' }], null, { source: 'cli' })
  assert.equal(transaction.changes[0].kind, 'default')
  assert.equal(transaction.changes[0].action, 'set-default')
  assert.equal((await policy.resolveEffective(ctx, { skill: 'alpha', threadId: 'thread-1' })).enabled, false)

  const resetTxn = await policy.applyOperations(ctx, [{ action: 'default', scope: 'global', skill: 'alpha', threadDefault: 'inherit' }], null, { source: 'cli' })
  assert.equal(resetTxn.changes[0].action, 'reset-default')
  assert.equal((await policy.resolveEffective(ctx, { skill: 'alpha', threadId: 'thread-1' })).enabled, true)

  await policy.rollbackTransaction(ctx, resetTxn.id, { source: 'cli' })
  assert.equal((await policy.resolveEffective(ctx, { skill: 'alpha', threadId: 'thread-1' })).enabled, false)
  await policy.rollbackTransaction(ctx, transaction.id, { source: 'cli' })
  assert.equal((await policy.resolveEffective(ctx, { skill: 'alpha', threadId: 'thread-1' })).enabled, true)
})

test('project scope is rejected and listScopes only returns global/thread', async () => {
  const { ctx } = await makeContext()
  assert.throws(() => policy.normalizeScope('project'), { code: 'INVALID_SCOPE' })
  await policy.setSkillPolicy(ctx, { scope: 'global', skill: 'beta', state: true })
  await policy.setSkillPolicy(ctx, { scope: 'thread', target: 'thread-x', skill: 'beta', state: false })
  const scopes = await policy.listScopes(ctx)
  assert.deepEqual(scopes.global.enabled, ['beta'])
  assert.equal(scopes.threads.length, 1)
  assert.deepEqual(scopes.threads[0].disabled, ['beta'])
  assert.equal('projects' in scopes, false)
})

test('global enable creates symlink; disable backs it up; rollback restores', async () => {
  const { ctx, base } = await makeContext()
  const lib = await makeLibrary(base, 'alpha')
  const sources = { alpha: { path: lib } }
  const enabled = await policy.applyOperations(ctx, [{ action: 'set', scope: 'global', skill: 'alpha', enabled: true }], sources, { source: 'cli' })
  const linkPath = path.join(ctx.globalRoot, 'alpha')
  assert.equal(await fs.realpath(linkPath), await fs.realpath(lib))

  const disabled = await policy.applyOperations(ctx, [{ action: 'set', scope: 'global', skill: 'alpha', enabled: false }], sources, { source: 'cli' })
  await assert.rejects(() => fs.lstat(linkPath), { code: 'ENOENT' })

  await policy.rollbackTransaction(ctx, disabled.id, { source: 'cli' })
  assert.equal(await fs.realpath(linkPath), await fs.realpath(lib))
  assert.equal((await policy.loadScopePolicy(ctx, 'global', null)).enabled.alpha !== undefined, true)

  await policy.rollbackTransaction(ctx, enabled.id, { source: 'cli' })
  await assert.rejects(() => fs.lstat(linkPath), { code: 'ENOENT' })
})

test('legacy project policies are archived once and not deleted', async () => {
  const { ctx, base } = await makeContext()
  const projectsDir = path.join(ctx.dataDir, 'policy', 'projects')
  await fs.mkdir(projectsDir, { recursive: true })
  await fs.writeFile(path.join(projectsDir, 'project_abc.json'), JSON.stringify({ schemaVersion: 1, scope: 'project' }), 'utf8')

  const first = await policy.migrateProjectPolicies(ctx)
  assert.equal(first.archived, true)
  assert.equal(first.count, 1)
  assert.ok(first.movedTo.startsWith(path.join(ctx.dataDir, 'archive', 'project-policy-')))
  assert.equal(fsSync.existsSync(projectsDir), false)
  assert.equal((await fs.readdir(first.movedTo)).length, 1)

  const second = await policy.migrateProjectPolicies(ctx)
  assert.equal(second.archived, false)
  assert.equal(second.alreadyArchived, true)

  const info = await policy.getMigrationInfo(ctx)
  assert.equal(info.archived, true)
  assert.equal(info.count, 1)
  void base
})

test('getActiveSkills returns warnings when thread id is missing and global fallback works', async () => {
  const { ctx } = await makeContext()
  await policy.setSkillPolicy(ctx, { scope: 'global', skill: 'alpha', state: true })
  const output = await policy.getActiveSkills(ctx, { threadId: null, skillNames: ['alpha', 'gamma'] })
  assert.ok(output.warnings.some((warning) => warning.code === 'THREAD_ID_MISSING'))
  assert.deepEqual(new Set(output.enabled), new Set(['alpha', 'gamma']))
})

test('doctor reports missing global link', async () => {
  const { ctx, base } = await makeContext()
  const lib = await makeLibrary(base, 'alpha')
  await policy.applyOperations(ctx, [{ action: 'set', scope: 'global', skill: 'alpha', enabled: true }], { alpha: { path: lib } }, { source: 'cli' })
  assert.equal((await policy.doctor(ctx)).healthy, true)
  await fs.rm(path.join(ctx.globalRoot, 'alpha'))
  assert.ok((await policy.doctor(ctx)).differences.some((diff) => diff.code === 'GLOBAL_LINK_MISSING'))
})
