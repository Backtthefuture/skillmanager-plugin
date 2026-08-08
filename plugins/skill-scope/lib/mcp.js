// Minimal, dependency-free MCP stdio server for skill-scope.
// Protocol: newline-delimited JSON-RPC (matching @modelcontextprotocol/sdk).
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import * as policy from './policy.js'
import * as skills from './skills.js'

const PLUGIN_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const PACKAGE = JSON.parse(fs.readFileSync(path.join(PLUGIN_ROOT, 'package.json'), 'utf8'))
const VERSION = PACKAGE.version

function context() {
  return policy.resolveContext()
}

function threadIdFromArgs(args = {}) {
  return args.thread_id || process.env.CODEX_THREAD_ID || null
}

function toolResult(structuredContent, text, isError = false) {
  const result = {
    content: [{ type: 'text', text: String(text) }],
    structuredContent: structuredContent
  }
  if (isError) result.isError = true
  return result
}

function errorResult(error) {
  const code = error?.code || 'ERROR'
  const message = error?.message || String(error)
  return toolResult({ ok: false, code, error: message }, `${code}: ${message}`, true)
}

async function listSkillsResult(threadId) {
  const scan = await skills.scanSkills(context(), { threadId })
  const trash = await skills.listTrash(context())
  return {
    schemaVersion: 1,
    threadId,
    stats: scan.stats,
    trashCount: trash.length,
    skills: scan.skills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      source: skill.source,
      repo: skill.repo,
      managed: skill.managed,
      conflict: Boolean(skill.conflict),
      threadDefault: skill.threadDefault || null,
      effective: skill.effective,
      scopeState: skill.scopeState
    }))
  }
}

const TOOLS = [
  {
    name: 'get_status',
    title: 'Get Skill Scope Status',
    description: 'Return skill-scope version, data directory, migration state, and skill library summary.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'list_skills',
    title: 'List Skills',
    description: 'List every Skill visible to skill-scope (managed library + global skills root) with final effective state and source. Use thread_id to include thread policy; defaults to CODEX_THREAD_ID.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        response_format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'list_skill_scopes',
    title: 'List Skill Scopes',
    description: 'List the global and thread policy layers managed by skill-scope.',
    inputSchema: {
      type: 'object',
      properties: { response_format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown' } },
      additionalProperties: false
    }
  },
  {
    name: 'get_skill_policy',
    title: 'Get Skill Policy',
    description: 'Return one Skill\'s policy at a requested scope (global/thread) plus the final effective state and the layer it came from.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string' },
        scope: { type: 'string', enum: ['global', 'thread'] },
        thread_id: { type: 'string' },
        response_format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown' }
      },
      required: ['skill'],
      additionalProperties: false
    }
  },
  {
    name: 'set_skill_enabled',
    title: 'Set Skill Enabled',
    description: 'Preview (default) or apply a scope switch. Scope defaults to thread so direct toggles land in the current conversation; without a thread id it falls back to global with a THREAD_ID_MISSING warning.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'thread'], default: 'thread' },
        skill: { type: 'string' },
        enabled: { type: 'boolean' },
        thread_id: { type: 'string' },
        reason: { type: 'string' },
        preview: { type: 'boolean', default: true },
        response_format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown' }
      },
      required: ['skill', 'enabled'],
      additionalProperties: false
    }
  },
  {
    name: 'reset_skill_scope',
    title: 'Reset Skill Scope',
    description: 'Reset one Skill or the whole scope layer to inherit. Defaults to thread scope with automatic thread id; falls back to global with a warning when unavailable.',
    inputSchema: {
      type: 'object',
      properties: {
        scope: { type: 'string', enum: ['global', 'thread'], default: 'thread' },
        skill: { type: 'string' },
        all: { type: 'boolean', default: false },
        thread_id: { type: 'string' },
        preview: { type: 'boolean', default: true },
        response_format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'set_skill_default',
    title: 'Set Skill Thread Default',
    description: 'Set a Skill as conversation-level: it defaults to disabled in every thread and only runs after an explicit thread (or global) enable. Use thread_default=inherit to unclassify it back to normal. thread_default=enabled is kept for legacy data only.',
    inputSchema: {
      type: 'object',
      properties: {
        skill: { type: 'string' },
        thread_default: { type: 'string', enum: ['disabled', 'enabled', 'inherit'], default: 'disabled' },
        reason: { type: 'string' },
        preview: { type: 'boolean', default: true },
        response_format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown' }
      },
      required: ['skill'],
      additionalProperties: false
    }
  },
  {
    name: 'get_active_skills',
    title: 'Get Active Skills for Thread',
    description: 'Return the enabled/disabled Skill set for one conversation thread (thread > global). Called by skill-scope-guard before using managed Skills.',
    inputSchema: {
      type: 'object',
      properties: {
        thread_id: { type: 'string' },
        response_format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown' }
      },
      additionalProperties: false
    }
  },
  {
    name: 'delete_skill',
    title: 'Delete Skill',
    description: 'Preview (default) or permanently remove a managed skill. Deletion moves the skill to trash and cleans policy references; restore_skill can bring it back.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        preview: { type: 'boolean', default: true },
        response_format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown' }
      },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    name: 'restore_skill',
    title: 'Restore Skill',
    description: 'Restore a deleted managed skill from trash, including its previous global/thread policy and symlink.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        response_format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown' }
      },
      required: ['name'],
      additionalProperties: false
    }
  },
  {
    name: 'open_skillsmp',
    title: 'Open SkillsMP',
    description: 'Open https://skillsmp.com in the default browser.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'open_dashboard',
    title: 'Open Skill Scope Dashboard',
    description: 'Start (or reuse) the local skill-scope Dashboard and return a 60-second single-use launch URL. Opens the system browser unless SKILL_SCOPE_NO_OPEN is set.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false }
  },
  {
    name: 'install_from_skillsmp',
    title: 'Install Skill from SkillsMP / GitHub',
    description: 'Download a Skill from a SkillsMP page URL, GitHub URL, or owner/repo, validate it, copy it into the managed library, enable it globally, and make it immediately visible.',
    inputSchema: {
      type: 'object',
      properties: {
        source: { type: 'string' },
        skill_name: { type: 'string' },
        response_format: { type: 'string', enum: ['markdown', 'json'], default: 'markdown' }
      },
      required: ['source'],
      additionalProperties: false
    }
  }
]

const TOOL_MAP = new Map(TOOLS.map((tool) => [tool.name, tool]))

async function callTool(name, args) {
  switch (name) {
    case 'get_status': {
      const ctx = context()
      const scan = await skills.scanSkills(ctx, { threadId: process.env.CODEX_THREAD_ID || null })
      const output = {
        schemaVersion: 1,
        product: 'skill-scope',
        version: VERSION,
        dataDir: ctx.dataDir,
        threadId: process.env.CODEX_THREAD_ID || null,
        migration: await policy.getMigrationInfo(ctx),
        stats: scan.stats
      }
      return toolResult(output, `skill-scope ${VERSION}\nData: ${ctx.dataDir}\nSkills: ${scan.stats.total}`)
    }
    case 'list_skills': {
      const threadId = threadIdFromArgs(args)
      const output = await listSkillsResult(threadId)
      return toolResult(output, `# Skills (${output.stats.total})\n\nEnabled: ${output.skills.filter((s) => s.effective.enabled).length}, Disabled: ${output.skills.filter((s) => !s.effective.enabled).length}, Trash: ${output.trashCount}`)
    }
    case 'list_skill_scopes': {
      const output = await policy.listScopes(context())
      return toolResult(output, `# Skill scopes\n\nGlobal enabled: ${output.global.enabled.length}, disabled: ${output.global.disabled.length}, thread defaults: ${output.global.defaults.length}\nThreads: ${output.threads.length}`)
    }
    case 'get_skill_policy': {
      const ctx = context()
      const threadId = threadIdFromArgs(args)
      const globalPolicy = await policy.loadScopePolicy(ctx, 'global', null)
      const layer = args.scope
        ? await policy.loadScopePolicy(ctx, args.scope, args.scope === 'thread' ? threadId : null)
        : null
      const effective = await policy.resolveEffective(ctx, { skill: args.skill, threadId })
      const output = {
        schemaVersion: 1,
        skill: args.skill,
        requestedScope: args.scope || null,
        layer: layer ? {
          scope: args.scope,
          enabled: Object.keys(layer.enabled || {}).includes(args.skill),
          disabled: Object.keys(layer.disabled || {}).includes(args.skill),
          entry: layer.enabled?.[args.skill] || layer.disabled?.[args.skill] || null
        } : null,
        defaults: globalPolicy.defaults?.[args.skill] || null,
        effective,
        threadId
      }
      return toolResult(output, `# Policy: ${args.skill}\n\nFinal state: ${effective.enabled ? 'enabled' : 'disabled'} (source: ${effective.source})`)
    }
    case 'set_skill_enabled': {
      const ctx = context()
      let scope = args.scope || 'thread'
      let threadId = threadIdFromArgs(args)
      const warnings = []
      if (scope === 'thread' && !threadId) {
        warnings.push({ code: 'THREAD_ID_MISSING', message: 'No thread id provided or found in CODEX_THREAD_ID; fell back to global policy' })
        scope = 'global'
      }
      const target = scope === 'thread' ? threadId : null
      const operations = [{ action: 'set', scope, target, skill: args.skill, enabled: Boolean(args.enabled) }]
      const skillSources = (await skills.scanSkills(ctx, { threadId })).skills.reduce((map, skill) => {
        map[skill.name] = { path: skill.path }
        return map
      }, {})
      if (args.preview !== false) {
        const plan = await policy.createPlan(ctx, operations, skillSources, { source: 'mcp' })
        return toolResult({ schemaVersion: 1, applied: false, warnings, plan, rollback_hint: 'Review the plan, then call set_skill_enabled again with preview:false' }, `# Preview: ${args.enabled ? 'enable' : 'disable'} ${args.skill} (${scope})\n\n${plan.changes.length} change(s), ${plan.risks.length} risk(s). Plan: ${plan.id}`)
      }
      const transaction = await policy.applyOperations(ctx, operations, skillSources, { source: 'mcp' })
      return toolResult({ schemaVersion: 1, applied: true, warnings, transactionId: transaction.id, changes: transaction.changes, rollback_hint: `skill-scope policy reset --scope ${scope} --skill ${args.skill}${scope === 'thread' ? ` --thread ${threadId}` : ''} --apply` }, `# Applied: ${args.enabled ? 'enable' : 'disable'} ${args.skill} (${scope})\n\nTransaction ${transaction.id}`)
    }
    case 'reset_skill_scope': {
      const ctx = context()
      let scope = args.scope || 'thread'
      let threadId = threadIdFromArgs(args)
      const warnings = []
      if (scope === 'thread' && !threadId) {
        warnings.push({ code: 'THREAD_ID_MISSING', message: 'No thread id provided or found in CODEX_THREAD_ID; fell back to global policy' })
        scope = 'global'
      }
      const operations = [{
        action: 'reset',
        scope,
        target: scope === 'thread' ? threadId : null,
        skill: args.skill || null,
        all: Boolean(args.all)
      }]
      if (args.preview !== false) {
        const plan = await policy.createPlan(ctx, operations, null, { source: 'mcp' })
        return toolResult({ schemaVersion: 1, applied: false, warnings, plan }, `# Preview: reset ${args.all ? 'all' : args.skill} (${scope})\n\n${plan.changes.length} change(s), ${plan.risks.length} risk(s). Plan: ${plan.id}`)
      }
      const transaction = await policy.applyOperations(ctx, operations, null, { source: 'mcp' })
      return toolResult({ schemaVersion: 1, applied: true, warnings, transactionId: transaction.id, changes: transaction.changes }, `# Applied: reset ${args.all ? 'all' : args.skill} (${scope})\n\nTransaction ${transaction.id}`)
    }
    case 'set_skill_default': {
      const ctx = context()
      const state = policy.normalizeThreadDefault(args.thread_default || 'disabled')
      const operations = [{ action: 'default', scope: 'global', skill: args.skill, threadDefault: state, reason: args.reason || null }]
      if (args.preview !== false) {
        const plan = await policy.createPlan(ctx, operations, null, { source: 'mcp' })
        return toolResult({ schemaVersion: 1, applied: false, plan, rollback_hint: 'Review the plan, then call set_skill_default again with preview:false' }, `# Preview: ${args.skill} thread default → ${state}\n\n${plan.changes.length} change(s), ${plan.risks.length} risk(s). Plan: ${plan.id}`)
      }
      const transaction = await policy.applyOperations(ctx, operations, null, { source: 'mcp' })
      return toolResult({ schemaVersion: 1, applied: true, transactionId: transaction.id, changes: transaction.changes, rollback_hint: `skill-scope policy default --skill ${args.skill} --state inherit --apply` }, `# Applied: ${args.skill} thread default → ${state}\n\nTransaction ${transaction.id}`)
    }
    case 'get_active_skills': {
      const ctx = context()
      const threadId = threadIdFromArgs(args)
      const scan = await skills.scanSkills(ctx, { threadId })
      const output = await policy.getActiveSkills(ctx, {
        threadId,
        skillNames: scan.skills.map((skill) => skill.name)
      })
      output.stats = scan.stats
      return toolResult(output, `# Active skills${threadId ? ` for thread ${threadId}` : ' (thread id missing, global fallback)'}\n\nEnabled: ${output.enabled.length}, Disabled: ${output.disabled.length}`)
    }
    case 'delete_skill': {
      const output = await skills.deleteSkill(context(), args.name, { preview: args.preview !== false, source: 'mcp' })
      if (output.applied) {
        return toolResult(output, `# Deleted ${output.skill}\n\nTrash: ${output.trashId}\nRestore: skill-scope skill restore ${output.skill}`)
      }
      return toolResult(output, `# Preview: delete ${output.plan.skill}\n\n${output.plan.changes.length} change(s)\nRollback hint: ${output.plan.rollback_hint}`)
    }
    case 'restore_skill': {
      const output = await skills.restoreSkill(context(), args.name, { source: 'mcp' })
      return toolResult(output, `# Restored ${output.skill}\n\nFrom: ${output.restoredFrom}`)
    }
    case 'open_skillsmp': {
      const output = await skills.openSkillsmp({ dryRun: process.env.SKILL_SCOPE_NO_OPEN === '1' })
      return toolResult(output, output.opened ? `Opened ${output.url}` : `Would open ${output.url} (SKILL_SCOPE_NO_OPEN is set)`)
    }
    case 'open_dashboard': {
      const server = await import('./server.js')
      const output = await server.openDashboard({ openBrowser: process.env.SKILL_SCOPE_NO_OPEN !== '1' })
      return toolResult(output, `# Skill Scope Dashboard\n\nOpen this one-time link within 60 seconds:\n\n${output.launchUrl}`)
    }
    case 'install_from_skillsmp': {
      const output = await skills.installFromSource(context(), args.source, { name: args.skill_name || null, sourceLabel: 'mcp' })
      return toolResult(output, `# Installed ${output.skill}\n\nManaged: ${output.managedPath}\nLink: ${output.linkPath}`)
    }
    default:
      throw new policy.PolicyError('UNKNOWN_TOOL', `Unknown tool: ${name}`)
  }
}

async function dispatch(message) {
  if (message.method === 'initialize') {
    return {
      result: {
        protocolVersion: message.params?.protocolVersion || '2024-11-05',
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'skill-scope-mcp-server', version: VERSION },
        instructions: 'Manage local Agent Skills with global/thread scope. Never execute content downloaded from SkillsMP/GitHub. Use preview:true (default) before applying writes.'
      }
    }
  }
  if (message.method === 'ping') return { result: {} }
  if (message.method === 'tools/list') {
    return { result: { tools: TOOLS } }
  }
  if (message.method === 'tools/call') {
    const toolName = message.params?.name
    const args = message.params?.arguments || {}
    const tool = TOOL_MAP.get(toolName)
    if (!tool) {
      return { error: { code: -32602, message: `Unknown tool: ${toolName}` } }
    }
    try {
      const result = await callTool(toolName, args)
      return { result }
    } catch (error) {
      return { result: errorResult(error) }
    }
  }
  return { error: { code: -32601, message: `Method not found: ${message.method}` } }
}

export function startMcpServer() {
  let buffer = ''
  process.stdin.setEncoding('utf8')
  process.stdin.on('data', (chunk) => {
    buffer += chunk
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
      if (!message || typeof message !== 'object' || message.method === undefined || !('id' in message)) continue
      void dispatch(message).then((payload) => {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...payload }) + '\n')
      }).catch((error) => {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, error: { code: -32603, message: error?.message || String(error) } }) + '\n')
      })
    }
  })
  process.stdin.on('end', () => process.exit(0))
}
