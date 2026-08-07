const $ = (id) => document.getElementById(id)

const state = {
  data: null,
  view: 'skills',
  scope: localStorage.getItem('skill-scope:dashboard-scope') || 'global',
  thread: localStorage.getItem('skill-scope:dashboard-thread') || '',
  search: '',
  sourceFilter: 'all',
  categoryFilter: 'all',
  statusFilter: 'all',
  selected: new Set(),
  plan: null,
  confirm: null,
  applying: false
}

class SessionError extends Error {}

async function api(pathname, options = {}) {
  const response = await fetch(pathname, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  })
  const body = await response.json().catch(() => ({}))
  if (response.status === 401) {
    throw new SessionError('会话已过期或未授权：请重新运行 skill-scope dashboard open 获取新的启动链接')
  }
  if (!response.ok || body.ok === false) {
    throw new Error(body.error || body.message || `${response.status} ${pathname}`)
  }
  return body
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]
  ))
}

function persist() {
  localStorage.setItem('skill-scope:dashboard-scope', state.scope)
  localStorage.setItem('skill-scope:dashboard-thread', state.thread)
}

function showError(error) {
  const box = $('error')
  box.hidden = false
  box.textContent = String(error?.message || error)
}

function clearError() {
  $('error').hidden = true
}

let toastTimer = null
function toast(message, kind = 'ok', actionLabel = null, actionFn = null) {
  const box = $('toast')
  box.hidden = false
  box.className = `toast ${kind}`
  box.innerHTML = `<span>${esc(message)}</span>${actionLabel ? `<button class="btn btn-ghost toast-btn">${esc(actionLabel)}</button>` : ''}`
  const button = box.querySelector('.toast-btn')
  if (button && actionFn) button.addEventListener('click', () => { box.hidden = true; actionFn() })
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => { box.hidden = true }, 6000)
}

function sourceLabel(source) {
  return { plugin: '插件', symlink: '软链', local: '本地', managed: '受管', skillsmp: 'SkillsMP', user: '用户' }[source] || source || '本地'
}

function effectiveSourceLabel(source) {
  return { global: 'global', thread: 'thread', default: 'global' }[source] || source
}

function scopeTarget() {
  return state.scope === 'thread' ? state.thread.trim() || null : null
}

function contextReady() {
  return state.scope === 'global' || Boolean(state.thread.trim())
}

async function loadData() {
  clearError()
  renderContext()
  renderGrid()
  try {
    const params = new URLSearchParams({ scope: state.scope })
    if (state.thread.trim()) params.set('thread_id', state.thread.trim())
    state.data = await api(`/api/skills?${params}`)
    if (!state.thread.trim() && state.data.threadId) {
      state.thread = state.data.threadId
      persist()
    }
    renderAll()
  } catch (error) {
    showError(error)
    $('skill-grid').innerHTML = `<div class="empty">加载失败：${esc(error.message)}</div>`
  }
}

function renderAll() {
  persist()
  renderContext()
  renderStats()
  renderFilters()
  renderGrid()
}

function renderContext() {
  document.querySelectorAll('.scope-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.scope === state.scope)
  })
  $('field-thread').hidden = state.scope !== 'thread'
  $('thread-input').value = state.thread
  const warning = $('context-warning')
  if (state.scope === 'thread' && !state.thread.trim()) {
    warning.hidden = false
    warning.textContent = '未提供线程 id（服务端会优先读取 CODEX_THREAD_ID）。thread 层不生效时将降级为 global 策略。'
  } else {
    warning.hidden = true
  }
}

function renderStats() {
  const data = state.data
  if (!data) return
  const total = data.skills.length
  const globalEnabled = data.skills.filter((skill) => skill.effective.enabled && ['global', 'default'].includes(skill.effective.source)).length
  const threadOverrides = data.policies.threads.reduce((sum, thread) => sum + thread.enabled.length + thread.disabled.length, 0)
  const disabled = data.skills.filter((skill) => !skill.effective.enabled).length
  $('stats').innerHTML = [
    statCard('Skill 总数', total, 'indigo'),
    statCard('全局启用', globalEnabled, 'green'),
    statCard('对话级覆盖', threadOverrides, 'amber'),
    statCard('回收站', data.trashCount, 'amber'),
    statCard('受限（禁用）', disabled, 'red')
  ].join('')
}

function statCard(label, value, tone) {
  return `<div class="stat-card ${tone}"><span class="stat-label">${label}</span><span class="stat-value">${value}</span></div>`
}

function renderFilters() {
  const skills = state.data?.skills || []
  const sources = [...new Set(skills.map((skill) => skill.source || 'local'))].sort()
  const categories = [...new Set(skills.map((skill) => skill.category || '未分类'))].sort()
  const sourceSelect = $('filter-source')
  const categorySelect = $('filter-category')
  sourceSelect.innerHTML = `<option value="all">全部来源</option>` + sources.map((value) => `<option value="${esc(value)}">${esc(sourceLabel(value))}</option>`).join('')
  categorySelect.innerHTML = `<option value="all">全部分类</option>` + categories.map((value) => `<option value="${esc(value)}">${esc(value)}</option>`).join('')
  sourceSelect.value = state.sourceFilter
  categorySelect.value = state.categoryFilter
}

function filteredSkills() {
  const skills = state.data?.skills || []
  const q = state.search.trim().toLowerCase()
  return skills.filter((skill) => {
    if (q && !skill.name.toLowerCase().includes(q) && !(skill.description || '').toLowerCase().includes(q)) return false
    if (state.sourceFilter !== 'all' && (skill.source || 'local') !== state.sourceFilter) return false
    if (state.categoryFilter !== 'all' && (skill.category || '未分类') !== state.categoryFilter) return false
    if (state.statusFilter === 'enabled' && !skill.effective.enabled) return false
    if (state.statusFilter === 'disabled' && skill.effective.enabled) return false
    return true
  })
}

function effectiveBadge(skill) {
  const eff = skill.effective
  if (eff.enabled && eff.source === 'default') {
    return `<span class="eff-badge default" title="未显式配置，默认启用">默认启用<span class="eff-source">· global</span></span>`
  }
  if (eff.enabled) {
    return `<span class="eff-badge enabled" title="最终状态：thread > global，显式关闭优先">启用<span class="eff-source">· ${esc(effectiveSourceLabel(eff.source))}</span></span>`
  }
  return `<span class="eff-badge disabled" title="最终状态：thread > global，显式关闭优先">禁用<span class="eff-source">· ${esc(effectiveSourceLabel(eff.source))}</span></span>`
}

function scopeControl(skill) {
  const ready = contextReady()
  const explicit = skill.scopeState?.state || 'inherit'
  const active = (target) => explicit === target ? ` active-${target}` : ''
  const disabled = ready ? '' : 'disabled'
  return `<div class="scope-control" role="group" aria-label="当前作用域开关">
    <button data-action="set" data-enabled="true" data-skill="${esc(skill.name)}" class="on${active('enabled')}" ${disabled} title="在本层显式启用">开</button>
    <button data-action="set" data-enabled="false" data-skill="${esc(skill.name)}" class="off${active('disabled')}" ${disabled} title="在本层显式禁用（优先于启用）">关</button>
    <button data-action="reset" data-skill="${esc(skill.name)}" class="inherit${active('inherit')}" ${disabled} title="移除本层显式配置，继承上层">继承</button>
  </div>`
}

function skillCard(skill) {
  const selected = state.selected.has(skill.name)
  const badges = [
    `<span class="mini-badge">${esc(sourceLabel(skill.source))}</span>`,
    skill.category ? `<span class="mini-badge indigo">${esc(skill.category)}</span>` : '',
    skill.managed ? `<span class="mini-badge green">受管</span>` : '',
    skill.conflict ? `<span class="mini-badge red">⚠ 冲突</span>` : ''
  ].filter(Boolean).join('')
  const deleteButton = skill.canDelete
    ? `<button class="btn btn-danger" data-delete="${esc(skill.name)}">删除</button>`
    : ''
  return `<article class="skill-card${selected ? ' selected' : ''}" data-skill-card="${esc(skill.name)}">
    <div class="card-top">
      <input class="card-check" type="checkbox" data-select="${esc(skill.name)}" ${selected ? 'checked' : ''} title="选择用于批量操作" />
      <div class="card-title-row">
        <div class="card-title"><h3>${esc(skill.name)}</h3></div>
        <div class="card-badges">${badges}</div>
      </div>
    </div>
    <p class="card-desc">${esc(skill.description || '（无描述）')}</p>
    <div class="effective-row">
      ${effectiveBadge(skill)}
      ${scopeControl(skill)}
    </div>
    <div class="card-actions">${deleteButton}</div>
  </article>`
}

function renderGrid() {
  const grid = $('skill-grid')
  if (!state.data) {
    grid.innerHTML = `<div class="loading"><div class="spinner"></div><span>正在加载 Skills…</span></div>`
    return
  }
  const skills = filteredSkills()
  $('visible-count').textContent = String(skills.length)
  if (skills.length === 0) {
    grid.innerHTML = `<div class="empty">${state.data.skills.length === 0 ? '暂无 Skills：可通过 SkillsMP 安装，或把 Skill 放入 ~/.codex/skills。' : '没有符合筛选条件的 Skill。'}</div>`
    return
  }
  grid.innerHTML = skills.map(skillCard).join('')
  updateBatchUi()
}

function updateBatchUi() {
  const count = state.selected.size
  $('selected-count').hidden = count === 0
  $('selected-count').textContent = `已选 ${count} 个`
  $('batch-enable').disabled = count === 0 || !contextReady()
  $('batch-disable').disabled = count === 0 || !contextReady()
}

function operationsFor(skills, action, enabled) {
  const target = scopeTarget()
  return skills.map((skill) => ({ action, scope: state.scope, target, skill, enabled }))
}

async function openPlan(operations) {
  clearError()
  try {
    const result = await api('/api/policy/plan', {
      method: 'POST',
      body: JSON.stringify({ operations, thread_id: state.thread.trim() || null })
    })
    state.plan = result.plan
    renderPlan(result.plan, result.warnings || [])
    $('plan-modal').hidden = false
  } catch (error) {
    showError(error)
  }
}

function renderPlan(plan, warnings = []) {
  const affected = new Set((plan.changes || []).map((change) => change.skill).filter(Boolean)).size
  $('plan-title').textContent = `${plan.changes.length} 项变更 · 影响 ${affected} 个 Skill`
  const changes = (plan.changes || []).map((change) => {
    if (change.kind === 'policy') {
      const target = change.action === 'set' ? (change.enabled ? '启用' : '禁用') : '重置为继承'
      const from = change.before?.enabled ? '启用' : change.before?.disabled ? '禁用' : '继承'
      return `<div class="plan-change"><span class="tag policy">策略</span> <span class="mono">${esc(change.skill)}</span>：${from} → ${target}（${esc(change.scope)}）</div>`
    }
    if (change.kind === 'link') {
      if (change.action === 'blocked') {
        return `<div class="plan-change"><span class="tag link">链接</span> <span class="mono">${esc(change.skill)}</span>：无法执行（${esc(change.reason || '未知原因')}）</div>`
      }
      if (change.action === 'noop') {
        return `<div class="plan-change"><span class="tag link">链接</span> <span class="mono">${esc(change.skill)}</span>：已在发现目录中，无需新增链接</div>`
      }
      const verb = change.action === 'create' ? '创建软链' : '移除软链'
      return `<div class="plan-change"><span class="tag link">链接</span> ${verb}：<span class="mono">${esc(change.linkPath)}</span>${change.sourcePath ? ` ← ${esc(change.sourcePath)}` : ''}</div>`
    }
    return `<div class="plan-change">${esc(JSON.stringify(change))}</div>`
  }).join('')
  const risks = [...(plan.risks || []), ...warnings].map((risk) => `<div class="plan-risk">⚠ ${esc(risk.message || JSON.stringify(risk))}</div>`).join('')
  $('plan-body').innerHTML = `
    <div class="plan-meta"><span class="badge indigo mono">${esc(plan.id)}</span><span class="badge">过期：${esc(plan.expiresAt || '—')}</span></div>
    ${changes || '<div class="empty">没有可执行的变更。</div>'}
    ${risks}
    <p class="plan-hint">确认后才落盘；执行后可在「事务 · 回滚」中回滚。所有删除/替换操作都会先备份。</p>
  `
}

function cancelPlan() {
  state.plan = null
  $('plan-modal').hidden = true
}

async function confirmPlan() {
  if (!state.plan || state.applying) return
  state.applying = true
  $('plan-apply').disabled = true
  $('plan-apply').textContent = '执行中…'
  try {
    const result = await api('/api/policy/apply', { method: 'POST', body: JSON.stringify({ plan_id: state.plan.id }) })
    const txnId = result.transaction.id
    state.plan = null
    $('plan-modal').hidden = true
    toast(`已执行事务 ${txnId}（${result.transaction.changes.length} 项变更）`, 'ok', '查看回滚', () => {
      switchView('transactions')
      void loadTransactions()
    })
    await loadData()
  } catch (error) {
    toast(error.message, 'err')
  } finally {
    state.applying = false
    $('plan-apply').disabled = false
    $('plan-apply').textContent = '确认执行'
  }
}

function openConfirm(title, message, onOk) {
  state.confirm = { onOk }
  $('confirm-title').textContent = title
  $('confirm-body').innerHTML = `<p class="small">${esc(message)}</p>`
  $('confirm-modal').hidden = false
}

function closeConfirm() {
  state.confirm = null
  $('confirm-modal').hidden = true
}

async function runConfirm() {
  if (!state.confirm) return
  const handler = state.confirm.onOk
  closeConfirm()
  await handler()
}

async function deleteSkill(name) {
  clearError()
  try {
    const result = await api('/api/skills/delete-plan', { method: 'POST', body: JSON.stringify({ name }) })
    state.plan = { ...result.plan, id: `delete_${name}` }
    $('plan-title').textContent = `删除计划：${name}`
    $('plan-body').innerHTML = `
      <div class="plan-meta"><span class="badge warn">删除会移入回收站，可恢复</span></div>
      ${(result.plan.changes || []).map((change) => `<div class="plan-change"><span class="tag link">${esc(change.action)}</span> <span class="mono">${esc(change.target)}</span></div>`).join('')}
      ${(result.plan.references || []).map((ref) => `<div class="plan-risk">⚠ 将清理策略引用：${esc(ref.scope)}${ref.threadId ? ` ${esc(ref.threadId)}` : ''} (${esc(ref.state)})</div>`).join('')}
      <p class="plan-hint">${esc(result.plan.rollback_hint)}</p>
    `
    state.plan = { ...result.plan, kind: 'delete' }
    $('plan-modal').hidden = false
  } catch (error) {
    showError(error)
  }
}

async function confirmDeletePlan() {
  if (!state.plan || state.plan.kind !== 'delete') return confirmPlan()
  const name = state.plan.skill
  state.plan = null
  $('plan-modal').hidden = true
  try {
    const result = await api('/api/skills/delete', { method: 'POST', body: JSON.stringify({ name }) })
    toast(`已删除 ${name}（回收站：${result.result.trashId}）`, 'ok', '查看回收站', () => {
      switchView('trash')
      void loadTrash()
    })
    await loadData()
  } catch (error) {
    toast(error.message, 'err')
  }
}

async function installSkill() {
  const source = $('install-source').value.trim()
  if (!source) return toast('请粘贴 SkillsMP 页面 / GitHub 地址 / owner/repo', 'err')
  $('install-btn').disabled = true
  $('install-btn').textContent = '安装中…'
  try {
    const result = await api('/api/market/install', { method: 'POST', body: JSON.stringify({ source }) })
    toast(`已安装 ${result.result.skill}，立即生效`, 'ok')
    $('install-source').value = ''
    await loadData()
  } catch (error) {
    toast(`安装失败：${error.message}`, 'err')
  } finally {
    $('install-btn').disabled = false
    $('install-btn').textContent = '安装 Skill'
  }
}

function switchView(view) {
  state.view = view
  document.querySelectorAll('.side-link, .mobile-link').forEach((link) => {
    link.classList.toggle('active', link.dataset.view === view)
  })
  for (const name of ['skills', 'scope', 'trash', 'transactions', 'audit', 'doctor']) {
    $(`view-${name}`).hidden = name !== view
  }
  if (view === 'scope') void renderScopePanel()
  if (view === 'trash') void loadTrash()
  if (view === 'transactions') void loadTransactions()
  if (view === 'audit') void loadAudit()
  if (view === 'doctor') void loadDoctor()
}

function renderScopePanel() {
  const data = state.data
  const box = $('scope-panel')
  if (!data) {
    box.innerHTML = `<div class="empty">先加载 Skills 数据。</div>`
    return
  }
  const policies = data.policies
  const chips = (names, scope, threadId) => names.map((name) => `<span class="chip">${esc(name)}<button class="chip-reset" data-reset-chip="${esc(name)}" data-scope="${esc(scope)}" data-thread="${esc(threadId || '')}" title="重置为继承">✕</button></span>`).join('') || '<span class="small">（无）</span>'
  box.innerHTML = `
    <div class="scope-section">
      <h3>global · 全局常开</h3>
      <div class="chip-row"><span class="small">启用：</span>${chips(policies.global.enabled, 'global', '')}</div>
      <div class="chip-row" style="margin-top:8px"><span class="small">禁用：</span>${chips(policies.global.disabled, 'global', '')}</div>
    </div>
    <div class="scope-section">
      <h3>thread · 对话级（当前：${esc(state.thread || '未提供')}）</h3>
      ${policies.threads.map((thread) => `
        <div style="margin-bottom:12px">
          <div class="small mono">${esc(thread.id)}</div>
          <div class="chip-row" style="margin-top:6px"><span class="small">启用：</span>${chips(thread.enabled, 'thread', thread.id)}</div>
          <div class="chip-row" style="margin-top:6px"><span class="small">禁用：</span>${chips(thread.disabled, 'thread', thread.id)}</div>
        </div>`).join('') || '<div class="empty">暂无对话级策略。</div>'}
    </div>
  `
}

async function loadTrash() {
  const box = $('trash-panel')
  box.innerHTML = `<div class="loading"><div class="spinner"></div><span>加载回收站…</span></div>`
  try {
    const result = await api('/api/trash')
    const entries = result.entries || []
    if (entries.length === 0) {
      box.innerHTML = `<div class="empty">回收站为空。删除的受管 Skill 会先到这里，可随时恢复。</div>`
      return
    }
    box.innerHTML = `<div class="table-wrap"><table class="grid-table">
      <thead><tr><th>名称</th><th>删除时间</th><th>来源</th><th>操作</th></tr></thead>
      <tbody>` + entries.map((entry) => `
        <tr>
          <td class="mono">${esc(entry.originalName)}</td>
          <td class="small">${esc(entry.deletedAt)}</td>
          <td>${esc(entry.source)}</td>
          <td>
            <button class="btn btn-ghost" data-restore="${esc(entry.originalName)}">恢复</button>
            <button class="btn btn-danger" data-purge="${esc(entry.trashId)}">永久清除</button>
          </td>
        </tr>`).join('') + `</tbody></table></div>`
  } catch (error) {
    box.innerHTML = `<div class="empty">${esc(error.message)}</div>`
  }
}

async function restoreSkill(name) {
  try {
    const result = await api('/api/trash/restore', { method: 'POST', body: JSON.stringify({ name }) })
    toast(`已恢复 ${result.result.skill}`, 'ok')
    await Promise.all([loadData(), loadTrash()])
  } catch (error) {
    toast(error.message, 'err')
  }
}

async function purgeTrash(trashId) {
  try {
    await api('/api/trash/purge', { method: 'POST', body: JSON.stringify({ trash_id: trashId }) })
    toast(`已永久清除 ${trashId}`, 'ok')
    await loadTrash()
  } catch (error) {
    toast(error.message, 'err')
  }
}

async function loadTransactions() {
  const box = $('transactions')
  box.innerHTML = `<div class="loading"><div class="spinner"></div><span>加载事务…</span></div>`
  try {
    const result = await api('/api/transactions')
    const list = result.transactions || []
    if (list.length === 0) {
      box.innerHTML = `<div class="empty">暂无事务。</div>`
      return
    }
    box.innerHTML = `<div class="table-wrap"><table class="grid-table">
      <thead><tr><th>事务</th><th>时间</th><th>来源</th><th>状态</th><th>变更</th><th>操作</th></tr></thead>
      <tbody>` + list.map((txn) => `
        <tr>
          <td class="mono">${esc(txn.id)}</td>
          <td class="small">${esc(txn.createdAt)}</td>
          <td>${esc(txn.source)}</td>
          <td>${txn.status === 'applied' ? '<span class="eff-badge enabled">已执行</span>' : `<span class="eff-badge disabled">${esc(txn.status)}</span>`}</td>
          <td>${(txn.changes || []).length}</td>
          <td>${txn.status === 'applied' ? `<button class="btn btn-ghost" data-rollback="${esc(txn.id)}">回滚</button>` : `<span class="small">已回滚</span>`}</td>
        </tr>`).join('') + `</tbody></table></div>`
  } catch (error) {
    box.innerHTML = `<div class="empty">${esc(error.message)}</div>`
  }
}

async function rollback(txnId) {
  try {
    const result = await api('/api/policy/rollback', { method: 'POST', body: JSON.stringify({ transaction_id: txnId }) })
    toast(`已回滚事务 ${txnId}（恢复 ${result.transaction.restoredChanges?.length || 0} 项）`, 'ok')
    await Promise.all([loadData(), loadTransactions()])
  } catch (error) {
    toast(error.message, 'err')
  }
}

async function loadAudit() {
  const box = $('audit')
  box.innerHTML = `<div class="loading"><div class="spinner"></div><span>加载审计日志…</span></div>`
  try {
    const result = await api('/api/audit')
    const entries = result.entries || []
    if (entries.length === 0) {
      box.innerHTML = `<div class="empty">暂无审计记录。</div>`
      return
    }
    box.innerHTML = `<div class="table-wrap"><table class="grid-table">
      <thead><tr><th>时间</th><th>来源</th><th>动作</th><th>详情</th></tr></thead>
      <tbody>` + entries.map((entry) => `
        <tr>
          <td class="small">${esc(entry.ts)}</td>
          <td>${esc(entry.source)}</td>
          <td class="mono">${esc(entry.action)}</td>
          <td class="small">${esc(JSON.stringify(entry.details || {}))}</td>
        </tr>`).join('') + `</tbody></table></div>`
  } catch (error) {
    box.innerHTML = `<div class="empty">${esc(error.message)}</div>`
  }
}

async function loadDoctor() {
  const box = $('doctor')
  box.innerHTML = `<div class="loading"><div class="spinner"></div><span>检查策略与文件系统一致性…</span></div>`
  try {
    const result = await api('/api/doctor')
    if (!result.differences || result.differences.length === 0) {
      box.innerHTML = `<div class="empty">healthy：策略与文件系统一致。</div>`
      return
    }
    box.innerHTML = `<div class="diff-list">` + result.differences.map((diff) => `
      <div class="diff ${esc(diff.severity)}">
        <strong>[${esc(diff.severity)}] ${esc(diff.code)}</strong> ${esc(diff.skill || '')}
        <div>${esc(diff.message)}</div>
        <span class="fix">fix: ${esc(diff.fix)}</span>
      </div>`).join('') + `</div>`
  } catch (error) {
    box.innerHTML = `<div class="empty">${esc(error.message)}</div>`
  }
}

function handleGridClick(event) {
  const actionButton = event.target.closest('[data-action]')
  if (actionButton) {
    const skill = actionButton.dataset.skill
    const action = actionButton.dataset.action
    const enabled = actionButton.dataset.enabled === 'true'
    void openPlan(operationsFor([skill], action, enabled))
    return
  }
  const deleteButton = event.target.closest('[data-delete]')
  if (deleteButton) {
    void deleteSkill(deleteButton.dataset.delete)
    return
  }
  const checkbox = event.target.closest('[data-select]')
  if (checkbox) {
    const skill = checkbox.dataset.select
    if (checkbox.checked) state.selected.add(skill)
    else state.selected.delete(skill)
    const card = document.querySelector(`[data-skill-card="${CSS.escape(skill)}"]`)
    card?.classList.toggle('selected', checkbox.checked)
    updateBatchUi()
  }
}

document.addEventListener('click', (event) => {
  const rollbackBtn = event.target.closest('[data-rollback]')
  if (rollbackBtn) { void rollback(rollbackBtn.dataset.rollback); return }
  const restoreBtn = event.target.closest('[data-restore]')
  if (restoreBtn) { void restoreSkill(restoreBtn.dataset.restore); return }
  const purgeBtn = event.target.closest('[data-purge]')
  if (purgeBtn) {
    openConfirm('永久清除回收站条目', `将永久删除 ${purgeBtn.dataset.purge}，此操作不可恢复。确定继续？`, () => purgeTrash(purgeBtn.dataset.purge))
    return
  }
  const resetChip = event.target.closest('[data-reset-chip]')
  if (resetChip) {
    void openPlan([{ action: 'reset', scope: resetChip.dataset.scope, target: resetChip.dataset.thread || null, skill: resetChip.dataset.resetChip }])
    return
  }
  const viewLink = event.target.closest('[data-view]')
  if (viewLink && viewLink.tagName === 'BUTTON') switchView(viewLink.dataset.view)
})

function bindEvents() {
  $('reload').addEventListener('click', () => void loadData())
  $('skill-grid').addEventListener('click', handleGridClick)
  $('search').addEventListener('input', (event) => { state.search = event.target.value; renderGrid() })
  $('filter-source').addEventListener('change', (event) => { state.sourceFilter = event.target.value; renderGrid() })
  $('filter-category').addEventListener('change', (event) => { state.categoryFilter = event.target.value; renderGrid() })
  $('filter-status').addEventListener('change', (event) => { state.statusFilter = event.target.value; renderGrid() })
  $('batch-enable').addEventListener('click', () => void openPlan(operationsFor([...state.selected], 'set', true)))
  $('batch-disable').addEventListener('click', () => void openPlan(operationsFor([...state.selected], 'set', false)))
  $('install-btn').addEventListener('click', () => void installSkill())
  $('install-source').addEventListener('keydown', (event) => { if (event.key === 'Enter') void installSkill() })
  document.querySelectorAll('.scope-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      state.scope = tab.dataset.scope
      state.selected.clear()
      void loadData()
    })
  })
  $('thread-input').addEventListener('change', (event) => {
    state.thread = event.target.value.trim()
    void loadData()
  })
  $('plan-cancel').addEventListener('click', cancelPlan)
  $('plan-cancel-foot').addEventListener('click', cancelPlan)
  $('plan-apply').addEventListener('click', () => void confirmDeletePlan())
  $('confirm-cancel').addEventListener('click', closeConfirm)
  $('confirm-cancel-foot').addEventListener('click', closeConfirm)
  $('confirm-ok').addEventListener('click', () => void runConfirm())
}

bindEvents()
switchView('skills')
void loadData()
