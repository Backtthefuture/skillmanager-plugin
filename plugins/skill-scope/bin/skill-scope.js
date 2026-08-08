#!/usr/bin/env node
import fsSync from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import * as policy from '../lib/policy.js'
import * as skills from '../lib/skills.js'
import { dashboardStatus, openDashboard, stopDashboard } from '../lib/server.js'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const packageJson = JSON.parse(fsSync.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'))
const version = packageJson.version

class CliError extends Error {
  constructor(code, message) {
    super(message)
    this.name = 'CliError'
    this.code = code
  }
}

function outputJson(value) {
  process.stdout.write(JSON.stringify(value) + '\n')
}

function autoThreadId() {
  return process.env.CODEX_THREAD_ID || null
}

function parseArguments(argv) {
  const commands = new Set(['status', 'policy', 'skill', 'market', 'dashboard', 'rescan', 'doctor', 'migrate', 'version', 'help'])
  let command = argv[0]
  let index = 1
  let subcommand = null
  let positional = []
  if (!command) command = 'help'
  else if (command === '--version' || command === '-v') command = 'version'
  else if (command === '--help' || command === '-h') command = 'help'
  else if (!commands.has(command)) throw new CliError('UNKNOWN_COMMAND', `Unknown command: ${command}`)

  if (['policy', 'skill', 'market', 'dashboard'].includes(command)) {
    const candidate = argv[index]
    if (candidate && !candidate.startsWith('--')) {
      subcommand = candidate
      index += 1
    }
  }
  const options = {
    json: false,
    scope: 'global',
    thread: null,
    skill: null,
    name: null,
    reason: null,
    source: null,
    state: null,
    apply: false,
    all: false,
    port: null
  }
  for (; index < argv.length; index++) {
    const arg = argv[index]
    if (arg === '--json') options.json = true
    else if (arg === '--scope') options.scope = argv[++index]
    else if (arg === '--thread') options.thread = argv[++index]
    else if (arg === '--thread-id') options.thread = argv[++index]
    else if (arg === '--skill') options.skill = argv[++index]
    else if (arg === '--name') options.name = argv[++index]
    else if (arg === '--reason') options.reason = argv[++index]
    else if (arg === '--source') options.source = argv[++index]
    else if (arg === '--state') options.state = argv[++index]
    else if (arg === '--apply' || arg === '--yes') options.apply = true
    else if (arg === '--all') options.all = true
    else if (arg === '--port') options.port = Number(argv[++index])
    else if (arg.startsWith('--')) throw new CliError('UNKNOWN_OPTION', `Unknown option: ${arg}`)
    else positional.push(arg)
  }
  if (!options.thread) {
    options.thread = autoThreadId()
  }
  return { command, subcommand, positional, options }
}

function helpText() {
  return `skill-scope ${version} - standalone Skill management for Codex

Usage:
  skill-scope status [--json]
  skill-scope policy list [--json]
  skill-scope policy status --skill <skill> [--scope global|thread] [--thread <id>] [--json]
  skill-scope policy enable|disable --scope global|thread --skill <skill> [--thread <id>] [--reason <text>] [--apply|--yes]
  skill-scope policy default --skill <skill> --state disabled|inherit [--reason <text>] [--apply|--yes]
  skill-scope policy reset --scope <scope> [--skill <skill>|--all] [--thread <id>] [--apply|--yes]
  skill-scope skill list [--json]
  skill-scope skill delete <name> [--apply|--yes]
  skill-scope skill restore <name>
  skill-scope market open
  skill-scope market install <source> [--name <skill-name>]
  skill-scope dashboard open [--port <port>]
  skill-scope dashboard status [--json]
  skill-scope dashboard stop
  skill-scope rescan [--json]
  skill-scope doctor [--json]
  skill-scope migrate [--json]
  skill-scope version [--json]
  skill-scope help

Thread scope uses --thread or the CODEX_THREAD_ID environment variable.
Policy writes default to preview; add --apply/--yes to execute.`
}

async function run(command, subcommand, positional, options) {
  const ctx = policy.resolveContext()
  if (command === 'help') {
    process.stdout.write(helpText() + '\n')
    return
  }
  if (command === 'version') {
    const output = { schemaVersion: 1, product: 'skill-scope', version }
    if (options.json) outputJson(output)
    else process.stdout.write(`skill-scope ${version}\n`)
    return
  }
  if (command === 'status') {
    const scan = await skills.scanSkills(ctx, { threadId: options.thread })
    const migration = await policy.getMigrationInfo(ctx)
    const output = {
      schemaVersion: 1,
      product: 'skill-scope',
      version,
      dataDir: ctx.dataDir,
      threadId: options.thread,
      migration,
      stats: scan.stats
    }
    if (options.json) outputJson(output)
    else {
      process.stdout.write(`skill-scope ${version}\n`)
      process.stdout.write(`data: ${ctx.dataDir}\n`)
      process.stdout.write(`skills: ${scan.stats.total} (managed ${scan.stats.managed}, skillsmp ${scan.stats.skillsmp})\n`)
      if (migration.archived) process.stdout.write(`legacy project policies archived at ${migration.movedTo}\n`)
    }
    return
  }
  if (command === 'migrate') {
    const result = await policy.migrateProjectPolicies(ctx)
    if (options.json) outputJson(result)
    else if (result.archived) process.stdout.write(`Archived ${result.count} legacy project policy file(s) to ${result.movedTo}\n`)
    else if (result.alreadyArchived) process.stdout.write(`Legacy project policies were already archived at ${result.movedTo}\n`)
    else process.stdout.write('No legacy project policies found.\n')
    return
  }
  if (command === 'doctor') {
    const result = await policy.doctor(ctx)
    if (options.json) outputJson(result)
    else {
      process.stdout.write(`skill-scope doctor (${result.healthy ? 'healthy' : `${result.stats.differences} difference(s)`}):\n`)
      for (const diff of result.differences) {
        process.stdout.write(`  [${diff.severity}] ${diff.code} ${diff.skill || ''}: ${diff.message}\n    fix: ${diff.fix}\n`)
      }
    }
    return
  }
  if (command === 'rescan') {
    const result = await skills.scanSkills(ctx, { threadId: options.thread })
    if (options.json) outputJson(result)
    else process.stdout.write(`Scanned ${result.stats.total} Skill(s) (managed ${result.stats.managed}, user ${result.stats.user}, skillsmp ${result.stats.skillsmp}).\n`)
    return
  }
  if (command === 'policy') {
    await runPolicy(ctx, subcommand || 'list', positional, options)
    return
  }
  if (command === 'skill') {
    await runSkill(ctx, subcommand || 'list', positional, options)
    return
  }
  if (command === 'market') {
    await runMarket(ctx, subcommand || 'open', positional, options)
    return
  }
  if (command === 'dashboard') {
    await runDashboard(ctx, subcommand || 'status', positional, options)
    return
  }
  throw new CliError('UNKNOWN_COMMAND', `Unknown command: ${command}`)
}

async function runPolicy(ctx, action, positional, options) {
  const scope = policy.normalizeScope(options.scope || 'global')
  const threadId = options.thread || autoThreadId()
  const target = scope === 'thread' ? threadId : null
  if (action === 'list') {
    const result = await policy.listScopes(ctx)
    if (options.json) outputJson(result)
    else {
      process.stdout.write(`global enabled: ${result.global.enabled.join(', ') || '(none)'}\n`)
      process.stdout.write(`global disabled: ${result.global.disabled.join(', ') || '(none)'}\n`)
      const defaultOff = result.global.defaults.filter((entry) => entry.thread === 'disabled').map((entry) => entry.skill)
      const defaultOn = result.global.defaults.filter((entry) => entry.thread === 'enabled').map((entry) => entry.skill)
      process.stdout.write(`global thread-default off: ${defaultOff.join(', ') || '(none)'}\n`)
      process.stdout.write(`global thread-default on: ${defaultOn.join(', ') || '(none)'}\n`)
      for (const thread of result.threads) {
        process.stdout.write(`thread ${thread.id} enabled: ${thread.enabled.join(', ') || '(none)'}, disabled: ${thread.disabled.join(', ') || '(none)'}\n`)
      }
    }
    return
  }
  if (action === 'status') {
    const skill = policy.normalizeSkillName(options.skill)
    const globalPolicy = await policy.loadScopePolicy(ctx, 'global', null)
    const layer = await policy.loadScopePolicy(ctx, scope, target)
    const effective = await policy.resolveEffective(ctx, { skill, threadId })
    const output = { schemaVersion: 1, skill, scope, threadId, defaults: globalPolicy.defaults?.[skill] || null, layer: { enabled: Object.keys(layer.enabled).includes(skill), disabled: Object.keys(layer.disabled).includes(skill) }, effective }
    if (options.json) outputJson(output)
    else process.stdout.write(`"${skill}" final state: ${effective.enabled ? 'enabled' : 'disabled'} (source: ${effective.source})\n`)
    return
  }
  if (action === 'default') {
    if (!options.skill) throw new CliError('MISSING_SKILL', 'policy default requires --skill')
    const state = policy.normalizeThreadDefault(options.state || 'disabled')
    const skill = policy.normalizeSkillName(options.skill)
    const operations = [{ action: 'default', scope: 'global', skill, threadDefault: state, reason: options.reason || null }]
    if (!options.apply) {
      const plan = await policy.createPlan(ctx, operations, null, { source: options.source || 'cli' })
      const output = { schemaVersion: 1, applied: false, planId: plan.id, changes: plan.changes, risks: plan.risks, next: `Re-run with --apply to execute ${plan.id}` }
      if (options.json) outputJson(output)
      else {
        process.stdout.write(`Preview ${plan.id} (${plan.changes.length} change(s), ${plan.risks.length} risk(s)):\n`)
        process.stdout.write(JSON.stringify({ changes: plan.changes, risks: plan.risks }, null, 2) + '\n')
        process.stdout.write(`Next: re-run with --apply.\n`)
      }
      return
    }
    const transaction = await policy.applyOperations(ctx, operations, null, { source: options.source || 'cli' })
    const output = { schemaVersion: 1, applied: true, transactionId: transaction.id, changes: transaction.changes }
    if (options.json) outputJson(output)
    else process.stdout.write(`Applied: ${skill} thread default → ${state} (txn ${transaction.id})\n`)
    return
  }
  if (action === 'enable' || action === 'disable') {
    if (!options.skill) throw new CliError('MISSING_SKILL', `policy ${action} requires --skill`)
    if (scope === 'thread' && !threadId) throw new CliError('MISSING_THREAD', 'Thread scope requires --thread or CODEX_THREAD_ID')
    const skill = policy.normalizeSkillName(options.skill)
    const operations = [{ action: 'set', scope, target, skill, enabled: action === 'enable' }]
    const scan = await skills.scanSkills(ctx, { threadId })
    const skillSources = Object.fromEntries(scan.skills.map((s) => [s.name, { path: s.path }]))
    if (!options.apply) {
      const plan = await policy.createPlan(ctx, operations, skillSources, { source: options.source || 'cli' })
      const output = { schemaVersion: 1, applied: false, planId: plan.id, changes: plan.changes, risks: plan.risks, next: `Re-run with --apply to execute ${plan.id}` }
      if (options.json) outputJson(output)
      else {
        process.stdout.write(`Preview ${plan.id} (${plan.changes.length} change(s), ${plan.risks.length} risk(s)):\n`)
        process.stdout.write(JSON.stringify({ changes: plan.changes, risks: plan.risks }, null, 2) + '\n')
        process.stdout.write(`Next: re-run with --apply.\n`)
      }
      return
    }
    const transaction = await policy.applyOperations(ctx, operations, skillSources, { source: options.source || 'cli' })
    const output = { schemaVersion: 1, applied: true, transactionId: transaction.id, changes: transaction.changes }
    if (options.json) outputJson(output)
    else process.stdout.write(`Applied: ${skill} → ${action === 'enable' ? 'enabled' : 'disabled'} (${scope}) txn ${transaction.id}\n`)
    return
  }
  if (action === 'reset') {
    if (!options.skill && !options.all) throw new CliError('MISSING_SKILL', 'policy reset requires --skill or --all')
    if (scope === 'thread' && !threadId) throw new CliError('MISSING_THREAD', 'Thread scope requires --thread or CODEX_THREAD_ID')
    const operations = [{ action: 'reset', scope, target, skill: options.skill ? policy.normalizeSkillName(options.skill) : null, all: Boolean(options.all) }]
    if (!options.apply) {
      const plan = await policy.createPlan(ctx, operations, null, { source: options.source || 'cli' })
      if (options.json) outputJson({ schemaVersion: 1, applied: false, planId: plan.id, changes: plan.changes, risks: plan.risks })
      else process.stdout.write(`Preview ${plan.id} (${plan.changes.length} change(s)). Re-run with --apply.\n`)
      return
    }
    const transaction = await policy.applyOperations(ctx, operations, null, { source: options.source || 'cli' })
    if (options.json) outputJson({ schemaVersion: 1, applied: true, transactionId: transaction.id })
    else process.stdout.write(`Reset ${options.all ? 'all' : options.skill} in ${scope} scope (txn ${transaction.id})\n`)
    return
  }
  throw new CliError('UNKNOWN_SUBCOMMAND', `Unknown policy subcommand: ${action}`)
}

async function runSkill(ctx, action, positional, options) {
  if (action === 'list') {
    const result = await skills.scanSkills(ctx, { threadId: options.thread })
    if (options.json) outputJson(result)
    else {
      for (const skill of result.skills) {
        const state = skill.effective.enabled ? 'enabled' : 'disabled'
        process.stdout.write(`  ${skill.name.padEnd(32)} ${state.padEnd(8)} ${skill.effective.source.padEnd(8)} ${skill.source}\n`)
      }
      process.stdout.write(`\n${result.stats.total} Skill(s); trash: ${(await skills.listTrash(ctx)).length}\n`)
    }
    return
  }
  if (action === 'delete') {
    const name = options.skill || positional[0]
    if (!name) throw new CliError('MISSING_NAME', 'skill delete requires a skill name')
    const result = await skills.deleteSkill(ctx, name, { preview: !options.apply, source: options.source || 'cli' })
    if (options.json) outputJson(result)
    else if (result.applied) process.stdout.write(`Deleted ${result.skill} (trash ${result.trashId}). Restore: skill-scope skill restore ${result.skill}\n`)
    else {
      process.stdout.write(`Preview: delete ${result.plan.skill}\n`)
      process.stdout.write(JSON.stringify(result.plan, null, 2) + '\n')
      process.stdout.write(`Next: re-run with --apply.\n`)
    }
    return
  }
  if (action === 'restore') {
    const name = options.skill || positional[0]
    if (!name) throw new CliError('MISSING_NAME', 'skill restore requires a skill name')
    const result = await skills.restoreSkill(ctx, name, { source: options.source || 'cli' })
    if (options.json) outputJson(result)
    else process.stdout.write(`Restored ${result.skill} from ${result.restoredFrom}\n`)
    return
  }
  throw new CliError('UNKNOWN_SUBCOMMAND', `Unknown skill subcommand: ${action}`)
}

async function runMarket(ctx, action, positional, options) {
  if (action === 'open') {
    const result = await skills.openSkillsmp()
    if (options.json) outputJson(result)
    else process.stdout.write(result.opened ? `Opened ${result.url}\n` : `Would open ${result.url}\n`)
    return
  }
  if (action === 'install') {
    const source = positional[0]
    if (!source) throw new CliError('MISSING_SOURCE', 'market install requires a source URL or local directory')
    const result = await skills.installFromSource(ctx, source, { name: options.name || null, sourceLabel: options.source || 'cli' })
    if (options.json) outputJson(result)
    else process.stdout.write(`Installed ${result.skill} from ${result.repo || source}\n  managed: ${result.managedPath}\n  link: ${result.linkPath}\n`)
    return
  }
  throw new CliError('UNKNOWN_SUBCOMMAND', `Unknown market subcommand: ${action}`)
}

async function runDashboard(ctx, action, positional, options) {
  if (action === 'open') {
    const result = await openDashboard({ port: options.port || null, openBrowser: true, ctx })
    if (options.json) outputJson(result)
    else process.stdout.write(result.opened ? `Opened Dashboard: ${result.launchUrl}\n` : `Dashboard launch URL (browser suppressed): ${result.launchUrl}\n`)
    return
  }
  if (action === 'status') {
    const result = await dashboardStatus(ctx)
    if (options.json) outputJson(result)
    else process.stdout.write(`Dashboard: ${result.status}${result.port ? ` (http://127.0.0.1:${result.port})` : ''}\n`)
    return
  }
  if (action === 'stop') {
    const result = await stopDashboard(ctx)
    if (options.json) outputJson(result)
    else process.stdout.write(result.stopped ? 'Dashboard stopped.\n' : 'Dashboard was not running.\n')
    return
  }
  throw new CliError('UNKNOWN_SUBCOMMAND', `Unknown dashboard subcommand: ${action}`)
}

let parsed
try {
  parsed = parseArguments(process.argv.slice(2))
  await run(parsed.command, parsed.subcommand, parsed.positional, parsed.options)
} catch (error) {
  const json = parsed?.options?.json || process.argv.includes('--json')
  const safe = { schemaVersion: 1, ok: false, code: error?.code || 'ERROR', error: error?.message || String(error) }
  if (json) {
    outputJson(safe)
    process.exitCode = 1
  }
  else {
    process.stderr.write(`skill-scope: ${error?.message || error}\n`)
    process.exitCode = 1
  }
}
