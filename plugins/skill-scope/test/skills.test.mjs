import test from 'node:test'
import assert from 'node:assert/strict'
import fsSync from 'node:fs'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const policy = await import(path.join(root, 'lib', 'policy.js'))
const skills = await import(path.join(root, 'lib', 'skills.js'))

async function makeContext() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-scope-skills-'))
  const ctx = policy.resolveContext({
    dataDir: path.join(base, 'data'),
    globalRoot: path.join(base, 'codex-skills'),
    pluginRoot: root,
    home: base
  })
  return { ctx, base }
}

async function writeSkill(dir, name, description = 'Test skill.') {
  await fs.mkdir(dir, { recursive: true })
  await fs.writeFile(path.join(dir, 'SKILL.md'), `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`, 'utf8')
}

test('scanSkills lists managed and user skills with effective state', async () => {
  const { ctx, base } = await makeContext()
  await writeSkill(path.join(ctx.dataDir, 'skills', 'managed-a'), 'managed-a')
  await writeSkill(path.join(ctx.globalRoot, 'user-b'), 'user-b')
  await policy.setSkillPolicy(ctx, { scope: 'global', skill: 'managed-a', state: false })

  const scan = await skills.scanSkills(ctx, { threadId: null })
  assert.equal(scan.stats.total, 2)
  const byName = Object.fromEntries(scan.skills.map((skill) => [skill.name, skill]))
  assert.equal(byName['managed-a'].managed, true)
  assert.equal(byName['managed-a'].source, 'managed')
  assert.equal(byName['managed-a'].effective.enabled, false)
  assert.equal(byName['user-b'].managed, false)
  assert.equal(byName['user-b'].source, 'user')
  assert.equal(byName['user-b'].effective.enabled, true)
  void base
})

test('delete moves skill and link to trash, cleans policy; restore brings everything back', async () => {
  const { ctx, base } = await makeContext()
  const managedDir = path.join(ctx.dataDir, 'skills', 'alpha')
  await writeSkill(managedDir, 'alpha')
  await policy.applyOperations(ctx, [{ action: 'set', scope: 'global', skill: 'alpha', enabled: true }], { alpha: { path: managedDir } }, { source: 'cli' })
  await policy.setSkillPolicy(ctx, { scope: 'thread', target: 'thread-1', skill: 'alpha', state: true })
  const linkPath = path.join(ctx.globalRoot, 'alpha')
  assert.equal(fsSync.existsSync(linkPath), true)

  const preview = await skills.deleteSkill(ctx, 'alpha', { preview: true })
  assert.equal(preview.applied, false)
  assert.ok(preview.plan.changes.some((change) => change.action === 'move-to-trash'))

  const deleted = await skills.deleteSkill(ctx, 'alpha', { preview: false, source: 'cli' })
  assert.equal(deleted.applied, true)
  assert.equal(fsSync.existsSync(managedDir), false)
  assert.equal(fsSync.existsSync(linkPath), false)
  const globalAfter = await policy.loadScopePolicy(ctx, 'global', null)
  assert.equal(globalAfter.enabled.alpha, undefined)
  const threadAfter = await policy.loadScopePolicy(ctx, 'thread', 'thread-1')
  assert.equal(threadAfter.enabled.alpha, undefined)

  const trash = await skills.listTrash(ctx)
  assert.equal(trash.length, 1)
  assert.equal(trash[0].originalName, 'alpha')

  const restored = await skills.restoreSkill(ctx, 'alpha', { source: 'cli' })
  assert.equal(restored.applied, true)
  assert.equal(fsSync.existsSync(path.join(managedDir, 'SKILL.md')), true)
  assert.equal(await fs.realpath(linkPath), await fs.realpath(managedDir))
  assert.equal((await policy.loadScopePolicy(ctx, 'global', null)).enabled.alpha !== undefined, true)
  assert.equal((await policy.loadScopePolicy(ctx, 'thread', 'thread-1')).enabled.alpha !== undefined, true)
  void base
})

test('protected skills cannot be deleted', async () => {
  const { ctx } = await makeContext()
  await assert.rejects(() => skills.deleteSkill(ctx, 'skill-scope-guard', { preview: true }), { code: 'PROTECTED_SKILL' })
  await assert.rejects(() => skills.deleteSkill(ctx, 'skill-scope', { preview: true }), { code: 'PROTECTED_SKILL' })
})

test('installFromSource copies a local skill, enables it globally and makes it visible', async () => {
  const { ctx, base } = await makeContext()
  const sourceDir = path.join(base, 'market-repo')
  await writeSkill(sourceDir, 'market-skill', 'Downloaded from market.')

  const result = await skills.installFromSource(ctx, sourceDir, { sourceLabel: 'cli' })
  assert.equal(result.skill, 'market-skill')
  assert.equal(fsSync.existsSync(path.join(ctx.dataDir, 'skills', 'market-skill', '.skill-scope-source.json')), true)
  assert.equal(await fs.realpath(path.join(ctx.globalRoot, 'market-skill')), await fs.realpath(path.join(ctx.dataDir, 'skills', 'market-skill')))

  const scan = await skills.scanSkills(ctx, { threadId: null })
  const found = scan.skills.find((skill) => skill.name === 'market-skill')
  assert.ok(found)
  assert.equal(found.source, 'skillsmp')
  assert.equal(found.effective.enabled, true)
})

test('install refuses protected names and existing skills', async () => {
  const { ctx, base } = await makeContext()
  const sourceDir = path.join(base, 'market-repo')
  await writeSkill(sourceDir, 'skill-scope', 'x')
  await assert.rejects(() => skills.installFromSource(ctx, sourceDir, { sourceLabel: 'cli' }), { code: 'PROTECTED_SKILL' })
  await writeSkill(path.join(ctx.dataDir, 'skills', 'exists'), 'exists')
  await writeSkill(sourceDir, 'exists', 'x')
  await assert.rejects(() => skills.installFromSource(ctx, sourceDir, { sourceLabel: 'cli' }), { code: 'SKILL_EXISTS' })
})

test('resolveInstallSource parses SkillsMP/GitHub/owner-repo and honors network guard', async () => {
  assert.deepEqual((await skills.resolveInstallSource('owner/repo-name')).repoUrl, 'https://github.com/owner/repo-name')
  assert.deepEqual((await skills.resolveInstallSource('https://github.com/a/b.git')).repoUrl, 'https://github.com/a/b.git')
  assert.equal((await skills.resolveInstallSource('https://skillsmp.com/skills/foo')).kind, 'skillsmp')
  process.env.SKILL_SCOPE_NO_NETWORK = '1'
  const { ctx } = await makeContext()
  await assert.rejects(() => skills.installFromSource(ctx, 'https://skillsmp.com/skills/foo'), { code: 'NETWORK_DISABLED' })
  delete process.env.SKILL_SCOPE_NO_NETWORK
})

test('openSkillsmp returns without launching when SKILL_SCOPE_NO_OPEN is set', async () => {
  process.env.SKILL_SCOPE_NO_OPEN = '1'
  const result = await skills.openSkillsmp()
  assert.equal(result.opened, false)
  assert.equal(result.url, 'https://skillsmp.com')
  delete process.env.SKILL_SCOPE_NO_OPEN
})

test('purgeTrash permanently removes a trash entry', async () => {
  const { ctx, base } = await makeContext()
  const managedDir = path.join(ctx.dataDir, 'skills', 'purge-me')
  await writeSkill(managedDir, 'purge-me')
  await skills.deleteSkill(ctx, 'purge-me', { preview: false, source: 'cli' })
  const trash = await skills.listTrash(ctx)
  assert.equal(trash.length, 1)
  const result = await skills.purgeTrash(ctx, trash[0].trashId)
  assert.equal(result.purged, trash[0].trashId)
  assert.equal((await skills.listTrash(ctx)).length, 0)
  await assert.rejects(() => skills.purgeTrash(ctx, trash[0].trashId), { code: 'NOT_IN_TRASH' })
  void base
})
