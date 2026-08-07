import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import fs from 'fs/promises'
import os from 'os'
import path from 'path'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const nodeBin = process.env.SKILL_SCOPE_NODE || process.execPath

async function makeFixture() {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-scope-server-'))
  const globalUser = path.join(base, '.codex', 'skills', 'user-skill')
  const managed = path.join(base, 'data', 'skills', 'managed-a')
  const systemSkill = path.join(base, '.codex', 'skills', '.system', 'sys-skill')
  const fakePlugin = path.join(base, 'plugins', 'fake-plugin')
  await fs.mkdir(globalUser, { recursive: true })
  await fs.mkdir(managed, { recursive: true })
  await fs.mkdir(systemSkill, { recursive: true })
  await fs.mkdir(path.join(fakePlugin, '.codex-plugin'), { recursive: true })
  await fs.mkdir(path.join(fakePlugin, 'skills', 'plugin-skill'), { recursive: true })
  await fs.writeFile(path.join(globalUser, 'SKILL.md'), '---\nname: user-skill\ndescription: User skill.\n---\n# User\n', 'utf8')
  await fs.writeFile(path.join(managed, 'SKILL.md'), '---\nname: managed-a\ndescription: Managed skill.\n---\n# Managed\n', 'utf8')
  await fs.writeFile(path.join(systemSkill, 'SKILL.md'), '---\nname: sys-skill\ndescription: System skill.\n---\n# System\n', 'utf8')
  await fs.writeFile(path.join(fakePlugin, '.codex-plugin', 'plugin.json'), JSON.stringify({ name: 'fake-plugin', version: '1.0.0', skills: './skills/' }), 'utf8')
  await fs.writeFile(path.join(fakePlugin, 'skills', 'plugin-skill', 'SKILL.md'), '---\nname: plugin-skill\ndescription: Plugin skill.\n---\n# Plugin\n', 'utf8')
  return { base, fakePlugin }
}

async function waitForHealth(url, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/api/health`)
      if (response.ok) return
    } catch {
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error('Dashboard did not become healthy')
}

test('Dashboard serves pages and APIs; session launch enables plan/apply', async () => {
  const { base, fakePlugin } = await makeFixture()
  const port = 5000 + Math.floor(Math.random() * 500)
  const baseUrl = `http://127.0.0.1:${port}`
  const controlToken = 'test-control-token-0123456789abcdef'
  const child = spawn(nodeBin, [path.join(root, 'bin', 'skill-scope-dashboard.js')], {
    cwd: root,
    env: {
      ...process.env,
      SKILLMANAGER_FIXTURE_ROOT: base,
      SKILL_SCOPE_DASHBOARD_PORT: String(port),
      SKILL_SCOPE_CONTROL_TOKEN: controlToken,
      SKILL_SCOPE_DATA_DIR: path.join(base, 'data'),
      SKILL_SCOPE_PLUGIN_ROOTS: fakePlugin,
      CODEX_THREAD_ID: 'thread-server'
    },
    stdio: ['ignore', 'pipe', 'pipe']
  })
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  try {
    await waitForHealth(baseUrl)

    const health = await (await fetch(`${baseUrl}/api/health`)).json()
    assert.equal(health.product, 'skill-scope-dashboard')
    assert.equal(health.threadId, 'thread-server')

    const page = await fetch(`${baseUrl}/`)
    assert.equal(page.status, 200)
    assert.match(page.headers.get('content-type') || '', /text\/html/)
    assert.match(await page.text(), /Skill Scope Dashboard/)

    const script = await fetch(`${baseUrl}/dashboard.js`)
    assert.equal(script.status, 200)
    assert.match(await script.text(), /api\/skills/)

    const css = await fetch(`${baseUrl}/dashboard.css`)
    assert.equal(css.status, 200)
    assert.match(await css.text(), /\[hidden\]\s*\{\s*display:\s*none\s*!important;?\s*\}/)

    const noSession = await fetch(`${baseUrl}/api/policy/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ operations: [] })
    })
    assert.equal(noSession.status, 401)

    const launchResponse = await fetch(`${baseUrl}/api/session/launch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${controlToken}`
      },
      body: JSON.stringify({ target: '/' })
    })
    assert.equal(launchResponse.status, 200)
    const launch = await launchResponse.json()
    assert.match(launch.launchUrl, /\/launch\/[A-Za-z0-9_-]+/)

    const redirected = await fetch(launch.launchUrl, { redirect: 'manual' })
    assert.equal(redirected.status, 302)
    const setCookie = redirected.headers.get('set-cookie') || ''
    const sessionToken = setCookie.match(/skill-scope-session=([^;]+)/)?.[1]
    assert.ok(sessionToken)

    const skills = await (await fetch(`${baseUrl}/api/skills?scope=global`, {
      headers: { Cookie: `skill-scope-session=${sessionToken}` }
    })).json()
    assert.equal(skills.ok, true)
    assert.equal(skills.stats.total, 4)
    assert.equal(skills.stats.bySource.system, 1)
    assert.equal(skills.stats.bySource.plugin, 1)
    assert.equal(skills.stats.bySource.user, 1)
    assert.equal(skills.stats.bySource.managed, 1)
    assert.ok(skills.skills.some((skill) => skill.name === 'user-skill'))
    assert.ok(skills.skills.some((skill) => skill.name === 'managed-a' && skill.canDelete === true))
    assert.ok(skills.skills.some((skill) => skill.name === 'sys-skill' && skill.canDelete === false))
    assert.ok(skills.skills.some((skill) => skill.name === 'plugin-skill' && skill.canDelete === false))

    const plan = await fetch(`${baseUrl}/api/policy/plan`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `skill-scope-session=${sessionToken}` },
      body: JSON.stringify({ operations: [{ action: 'set', scope: 'global', skill: 'user-skill', enabled: false }] })
    })
    assert.equal(plan.status, 200)
    const planJson = await plan.json()
    assert.ok(planJson.plan?.id)

    const applied = await fetch(`${baseUrl}/api/policy/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: `skill-scope-session=${sessionToken}` },
      body: JSON.stringify({ plan_id: planJson.plan.id })
    })
    assert.equal(applied.status, 200)
    const appliedJson = await applied.json()
    assert.equal(appliedJson.transaction.status, 'applied')

    const skillsAfter = await (await fetch(`${baseUrl}/api/skills?scope=global`, {
      headers: { Cookie: `skill-scope-session=${sessionToken}` }
    })).json()
    assert.equal(skillsAfter.skills.find((skill) => skill.name === 'user-skill').effective.enabled, false)
  } finally {
    child.kill('SIGTERM')
    await new Promise((resolve) => setTimeout(resolve, 500))
    if (stderr) process.stderr.write(stderr)
  }
})
