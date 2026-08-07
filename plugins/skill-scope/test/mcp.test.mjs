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
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-scope-mcp-'))
  const market = path.join(base, 'market', 'demo-skill')
  await fs.mkdir(market, { recursive: true })
  await fs.writeFile(path.join(market, 'SKILL.md'), '---\nname: demo-skill\ndescription: MCP demo skill.\n---\n# Demo\n', 'utf8')
  const globalUser = path.join(base, '.codex', 'skills', 'user-skill')
  await fs.mkdir(globalUser, { recursive: true })
  await fs.writeFile(path.join(globalUser, 'SKILL.md'), '---\nname: user-skill\ndescription: User skill.\n---\n# User\n', 'utf8')
  return { base, market }
}

function connect(env) {
  const child = spawn(nodeBin, [path.join(root, 'bin', 'skill-scope-mcp.js')], {
    cwd: root,
    env: { ...process.env, ...env },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  let buffer = ''
  const pending = new Map()
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
  child.stdout.on('data', (chunk) => {
    buffer += chunk.toString()
    let newlineIndex
    while ((newlineIndex = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, newlineIndex).trim()
      buffer = buffer.slice(newlineIndex + 1)
      if (!line) continue
      let message
      try {
        message = JSON.parse(line)
      } catch {
        continue
      }
      if (message.id !== undefined) {
        const waiter = pending.get(message.id)
        if (waiter) {
          pending.delete(message.id)
          waiter(message)
        }
      }
    }
  })
  let nextId = 1
  function send(method, params = {}) {
    const id = nextId++
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n')
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`MCP timeout waiting for ${method}; stderr: ${stderr.slice(-1000)}`)), 15000)
      pending.set(id, (message) => {
        clearTimeout(timer)
        resolve(message)
      })
    })
  }
  function notify(method, params = {}) {
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n')
  }
  return { child, send, notify, stderr: () => stderr }
}

test('MCP exposes and runs all standalone skill-scope tools', async () => {
  const { base, market } = await makeFixture()
  const env = {
    SKILLMANAGER_FIXTURE_ROOT: base,
    SKILL_SCOPE_DATA_DIR: path.join(base, 'data'),
    CODEX_THREAD_ID: 'thread-auto',
    SKILL_SCOPE_NO_OPEN: '1'
  }
  const client = connect(env)
  try {
    const init = await client.send('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'skill-scope-test', version: '1.0.0' }
    })
    assert.equal(init.result?.serverInfo?.name, 'skill-scope-mcp-server')
    client.notify('notifications/initialized', {})

    const tools = await client.send('tools/list', {})
    const names = tools.result.tools.map((tool) => tool.name)
    const expected = ['get_status', 'list_skills', 'list_skill_scopes', 'get_skill_policy', 'set_skill_enabled', 'set_skill_default', 'reset_skill_scope', 'get_active_skills', 'delete_skill', 'restore_skill', 'open_skillsmp', 'install_from_skillsmp']
    for (const name of expected) assert.ok(names.includes(name), `missing ${name}`)
    assert.ok(!names.includes('get_skill_summary'), 'SkillManager-only tool should be gone')

    const status = await client.send('tools/call', { name: 'get_status', arguments: {} })
    assert.equal(status.result?.structuredContent?.product, 'skill-scope')
    assert.equal(status.result?.structuredContent?.threadId, 'thread-auto')

    const active = await client.send('tools/call', { name: 'get_active_skills', arguments: { response_format: 'json' } })
    assert.equal(active.result?.structuredContent?.thread_id, 'thread-auto')
    assert.ok(active.result?.structuredContent?.enabled.includes('user-skill'))

    const preview = await client.send('tools/call', {
      name: 'set_skill_enabled',
      arguments: { scope: 'thread', skill: 'user-skill', enabled: false, preview: true, response_format: 'json' }
    })
    assert.equal(preview.result?.structuredContent?.applied, false)
    assert.ok(preview.result?.structuredContent?.plan?.id)
    assert.equal(preview.result?.structuredContent?.plan?.operations?.[0]?.scope, 'thread')

    const applied = await client.send('tools/call', {
      name: 'set_skill_enabled',
      arguments: { scope: 'thread', skill: 'user-skill', enabled: false, preview: false, response_format: 'json' }
    })
    assert.equal(applied.result?.structuredContent?.applied, true)

    const policyCheck = await client.send('tools/call', {
      name: 'get_skill_policy',
      arguments: { skill: 'user-skill', response_format: 'json' }
    })
    assert.equal(policyCheck.result?.structuredContent?.effective?.source, 'thread')
    assert.equal(policyCheck.result?.structuredContent?.effective?.enabled, false)

    const installed = await client.send('tools/call', {
      name: 'install_from_skillsmp',
      arguments: { source: market, response_format: 'json' }
    })
    assert.equal(installed.result?.structuredContent?.applied, true)
    assert.equal(installed.result?.structuredContent?.skill, 'demo-skill')

    const listed = await client.send('tools/call', { name: 'list_skills', arguments: { response_format: 'json' } })
    assert.ok(listed.result?.structuredContent?.skills.some((skill) => skill.name === 'demo-skill'))

    const deletePreview = await client.send('tools/call', {
      name: 'delete_skill',
      arguments: { name: 'demo-skill', preview: true, response_format: 'json' }
    })
    assert.equal(deletePreview.result?.structuredContent?.applied, false)

    const deleted = await client.send('tools/call', {
      name: 'delete_skill',
      arguments: { name: 'demo-skill', preview: false, response_format: 'json' }
    })
    assert.equal(deleted.result?.structuredContent?.applied, true)

    const afterDelete = await client.send('tools/call', { name: 'list_skills', arguments: { response_format: 'json' } })
    assert.equal(afterDelete.result?.structuredContent?.skills.some((skill) => skill.name === 'demo-skill'), false)
    assert.equal(afterDelete.result?.structuredContent?.trashCount, 1)

    const restored = await client.send('tools/call', {
      name: 'restore_skill',
      arguments: { name: 'demo-skill', response_format: 'json' }
    })
    assert.equal(restored.result?.structuredContent?.applied, true)

    const opened = await client.send('tools/call', { name: 'open_skillsmp', arguments: {} })
    assert.equal(opened.result?.structuredContent?.opened, false)
    assert.equal(opened.result?.structuredContent?.url, 'https://skillsmp.com')

    const reset = await client.send('tools/call', {
      name: 'reset_skill_scope',
      arguments: { scope: 'thread', skill: 'user-skill', preview: false, response_format: 'json' }
    })
    assert.equal(reset.result?.structuredContent?.applied, true)

    const defaultPreview = await client.send('tools/call', {
      name: 'set_skill_default',
      arguments: { skill: 'user-skill', thread_default: 'disabled', preview: true, response_format: 'json' }
    })
    assert.equal(defaultPreview.result?.structuredContent?.applied, false)
    assert.equal(defaultPreview.result?.structuredContent?.plan?.operations?.[0]?.action, 'default')

    const defaultApplied = await client.send('tools/call', {
      name: 'set_skill_default',
      arguments: { skill: 'user-skill', thread_default: 'disabled', preview: false, response_format: 'json' }
    })
    assert.equal(defaultApplied.result?.structuredContent?.applied, true)

    const policyWithDefault = await client.send('tools/call', {
      name: 'get_skill_policy',
      arguments: { skill: 'user-skill', response_format: 'json' }
    })
    assert.equal(policyWithDefault.result?.structuredContent?.defaults?.thread, 'disabled')
    assert.equal(policyWithDefault.result?.structuredContent?.effective?.enabled, false)
    assert.equal(policyWithDefault.result?.structuredContent?.effective?.source, 'thread-default')

    const activeAfterDefault = await client.send('tools/call', {
      name: 'get_active_skills',
      arguments: { response_format: 'json' }
    })
    assert.ok(activeAfterDefault.result?.structuredContent?.disabled.includes('user-skill'))
  } finally {
    client.child.kill('SIGTERM')
  }
})

test('set_skill_enabled falls back to global with THREAD_ID_MISSING when thread id is unavailable', async () => {
  const { base } = await makeFixture()
  const client = connect({
    SKILLMANAGER_FIXTURE_ROOT: base,
    SKILL_SCOPE_DATA_DIR: path.join(base, 'data'),
    CODEX_THREAD_ID: ''
  })
  try {
    await client.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    client.notify('notifications/initialized', {})
    const result = await client.send('tools/call', {
      name: 'set_skill_enabled',
      arguments: { scope: 'thread', skill: 'user-skill', enabled: false, preview: true, response_format: 'json' }
    })
    const structured = result.result?.structuredContent
    assert.ok(structured?.warnings.some((warning) => warning.code === 'THREAD_ID_MISSING'))
    assert.equal(structured?.plan?.operations?.[0]?.scope, 'global')
  } finally {
    client.child.kill('SIGTERM')
  }
})

test('open_dashboard returns a launch URL and the server can be stopped', async () => {
  const { base } = await makeFixture()
  const port = 4800 + Math.floor(Math.random() * 400)
  const client = connect({
    SKILLMANAGER_FIXTURE_ROOT: base,
    SKILL_SCOPE_DATA_DIR: path.join(base, 'data'),
    CODEX_THREAD_ID: 'thread-dash',
    SKILL_SCOPE_NO_OPEN: '1',
    SKILL_SCOPE_DASHBOARD_PORT: String(port)
  })
  try {
    await client.send('initialize', { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } })
    client.notify('notifications/initialized', {})
    const tools = await client.send('tools/list', {})
    assert.ok(tools.result.tools.some((tool) => tool.name === 'open_dashboard'))
    const result = await client.send('tools/call', { name: 'open_dashboard', arguments: {} })
    const structured = result.result?.structuredContent
    assert.equal(structured?.ok, true)
    assert.match(structured?.launchUrl || '', /\/launch\/[A-Za-z0-9_-]+/)
    assert.equal(structured?.opened, false)
  } finally {
    client.child.kill('SIGTERM')
    const server = await import(path.join(root, 'lib', 'server.js'))
    const policy = await import(path.join(root, 'lib', 'policy.js'))
    await server.stopDashboard(policy.resolveContext({ dataDir: path.join(base, 'data') }))
  }
})
