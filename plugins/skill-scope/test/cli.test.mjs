import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodeBin = process.env.SKILL_SCOPE_NODE || process.execPath
const cli = path.join(root, 'bin', 'skill-scope.js')

function run(args, env) {
  return spawnSync(nodeBin, [cli, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ...env }
  })
}

async function makeFixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-scope-cli-'))
  const market = path.join(base, 'market', 'cli-skill')
  await fs.mkdir(market, { recursive: true })
  await fs.writeFile(path.join(market, 'SKILL.md'), '---\nname: cli-skill\ndescription: CLI demo.\n---\n# CLI\n', 'utf8')
  return { base, market }
}

test('CLI status, policy, skill delete/restore, and market install work', async () => {
  const { base, market } = await makeFixture()
  const env = {
    SKILLMANAGER_FIXTURE_ROOT: base,
    SKILL_SCOPE_DATA_DIR: path.join(base, 'data'),
    CODEX_THREAD_ID: 'thread-cli'
  }

  const status = run(['status', '--json'], env)
  assert.equal(status.status, 0)
  const statusJson = JSON.parse(status.stdout)
  assert.equal(statusJson.product, 'skill-scope')
  assert.equal(statusJson.threadId, 'thread-cli')

  const list = run(['policy', 'list', '--json'], env)
  assert.equal(list.status, 0)
  assert.deepEqual(JSON.parse(list.stdout).global.enabled, [])

  const install = run(['market', 'install', market, '--json'], env)
  assert.equal(install.status, 0, install.stderr)
  assert.equal(JSON.parse(install.stdout).skill, 'cli-skill')

  const skillList = run(['skill', 'list', '--json'], env)
  assert.equal(skillList.status, 0)
  assert.ok(JSON.parse(skillList.stdout).skills.some((skill) => skill.name === 'cli-skill'))

  const preview = run(['skill', 'delete', 'cli-skill', '--json'], env)
  assert.equal(preview.status, 0)
  assert.equal(JSON.parse(preview.stdout).applied, false)

  const deleted = run(['skill', 'delete', 'cli-skill', '--apply', '--json'], env)
  assert.equal(deleted.status, 0, deleted.stderr)
  assert.equal(JSON.parse(deleted.stdout).applied, true)

  const restored = run(['skill', 'restore', 'cli-skill', '--json'], env)
  assert.equal(restored.status, 0, restored.stderr)
  assert.equal(JSON.parse(restored.stdout).applied, true)

  const resetGlobal = run(['policy', 'reset', '--scope', 'global', '--skill', 'cli-skill', '--apply', '--json'], env)
  assert.equal(resetGlobal.status, 0, resetGlobal.stderr)

  const defaultOff = run(['policy', 'default', '--skill', 'cli-skill', '--state', 'disabled', '--apply', '--json'], env)
  assert.equal(defaultOff.status, 0, defaultOff.stderr)
  assert.equal(JSON.parse(defaultOff.stdout).applied, true)

  const defaultStatus = run(['policy', 'status', '--skill', 'cli-skill', '--scope', 'thread', '--json'], env)
  assert.equal(defaultStatus.status, 0, defaultStatus.stderr)
  assert.equal(JSON.parse(defaultStatus.stdout).effective.enabled, false)
  assert.equal(JSON.parse(defaultStatus.stdout).effective.source, 'thread-default')
  assert.equal(JSON.parse(defaultStatus.stdout).defaults.thread, 'disabled')

  const listWithDefaults = run(['policy', 'list', '--json'], env)
  assert.equal(listWithDefaults.status, 0)
  assert.ok(JSON.parse(listWithDefaults.stdout).global.defaults.some((entry) => entry.skill === 'cli-skill' && entry.thread === 'disabled'))

  const defaultInherit = run(['policy', 'default', '--skill', 'cli-skill', '--state', 'inherit', '--apply', '--json'], env)
  assert.equal(defaultInherit.status, 0, defaultInherit.stderr)
  assert.equal(JSON.parse(defaultInherit.stdout).applied, true)

  const enable = run(['policy', 'enable', '--scope', 'global', '--skill', 'cli-skill', '--apply', '--json'], env)
  assert.equal(enable.status, 0, enable.stderr)
  assert.equal(JSON.parse(enable.stdout).applied, true)

  const doctor = run(['doctor', '--json'], env)
  assert.equal(doctor.status, 0)
  assert.equal(JSON.parse(doctor.stdout).healthy, true)

  const migrate = run(['migrate', '--json'], env)
  assert.equal(migrate.status, 0)
  assert.equal(JSON.parse(migrate.stdout).archived, false)

  const version = run(['version', '--json'], env)
  assert.equal(version.status, 0)
  assert.equal(JSON.parse(version.stdout).product, 'skill-scope')
})

test('CLI rejects project scope', async () => {
  const { base } = await makeFixture()
  const result = run(['policy', 'list', '--scope', 'project', '--json'], {
    SKILLMANAGER_FIXTURE_ROOT: base,
    SKILL_SCOPE_DATA_DIR: path.join(base, 'data')
  })
  assert.equal(result.status, 1)
  assert.equal(JSON.parse(result.stdout).code, 'INVALID_SCOPE')
})

test('CLI dashboard open/status/stop lifecycle works', async () => {
  const { base } = await makeFixture()
  const port = 4900 + Math.floor(Math.random() * 200)
  const env = {
    SKILLMANAGER_FIXTURE_ROOT: base,
    SKILL_SCOPE_DATA_DIR: path.join(base, 'data'),
    SKILL_SCOPE_NO_OPEN: '1',
    SKILL_SCOPE_DASHBOARD_PORT: String(port)
  }
  const opened = run(['dashboard', 'open', '--port', String(port), '--json'], env)
  assert.equal(opened.status, 0, opened.stderr)
  const openedJson = JSON.parse(opened.stdout)
  assert.equal(openedJson.ok, true)
  assert.match(openedJson.launchUrl || '', /\/launch\//)

  const status = run(['dashboard', 'status', '--json'], env)
  assert.equal(status.status, 0)
  assert.equal(JSON.parse(status.stdout).status, 'running')

  const stopped = run(['dashboard', 'stop', '--json'], env)
  assert.equal(stopped.status, 0)
  assert.equal(JSON.parse(stopped.stdout).stopped, true)

  const after = run(['dashboard', 'status', '--json'], env)
  assert.equal(JSON.parse(after.stdout).status, 'stopped')
})
