# skill-scope 设计文档（独立版）

> 版本：0.1.0（2026-08-07）
> 形态：独立插件，不依赖/不内置 SkillManager；自带仅监听 127.0.0.1 的本地 Dashboard。

## 1. 架构

```text
┌──────────────────────────────────────────────────────────┐
│ skill-scope 插件                                          │
│  bin/skill-scope.js        CLI（独立命令）                 │
│  bin/skill-scope-mcp.js    MCP stdio 入口                 │
│  lib/mcp.js                零依赖 MCP 服务（newline JSON） │
│  lib/policy.js             双层策略引擎（global/thread）    │
│  lib/skills.js             Skill 库：扫描/删除/恢复/安装    │
│  skills/skill-scope-guard  守护 Skill（常开）              │
│  skills/skill-scope        主 Skill（能力说明）            │
└──────────────────────────────────────────────────────────┘
        │ 读写策略/符号链接        │ git clone / fetch（仅用户指定来源）
        ▼                          ▼
  $DATA_DIR/policy/*        $DATA_DIR/skills/ + ~/.codex/skills/
  $DATA_DIR/trash/          SkillsMP / GitHub
```

## 2. 数据模型

- `$DATA_DIR/policy/global.json`：全局常开策略。
- `$DATA_DIR/policy/threads/<thread-id>.json`：对话级策略。
- `$DATA_DIR/policy/links.json`：本插件管理的符号链接台账。
- `$DATA_DIR/policy/plans.json` / `transactions.json` / `audit.jsonl` / `backup/`：
  计划、事务、审计、备份。
- `$DATA_DIR/skills/<name>`：受管 Skill 库（含 `.skill-scope-source.json` 来源标记）。
- `$DATA_DIR/trash/<name>-<ts>/`：删除的 Skill（含 `.skill-scope-trash.json` 元数据）。
- `$DATA_DIR/archive/project-policy-<ts>/`：旧 project 策略归档（只归档不删除）。

策略文件结构：

```json
{
  "schemaVersion": 1,
  "scope": "global",
  "updatedAt": "…",
  "enabled": { "my-skill": { "updatedAt": "…", "reason": null, "source": "cli" } },
  "disabled": { "noisy-skill": { "updatedAt": "…", "reason": "…", "source": "mcp" } }
}
```

## 3. 生效规则

`thread > global`；thread 未配置继承 global；global 未配置默认启用；
同一层显式关闭优先于显式启用。

`get_active_skills` 返回每个 Skill 的 `enabled` 与 `source`（thread/global/default），
供对话直接展示。线程 id 自动读取 `CODEX_THREAD_ID`；缺失时返回
`THREAD_ID_MISSING` 警告并降级到 global。

## 4. 删除与恢复

- 只允许删除受管 Skill（`$DATA_DIR/skills/<name>` 或 SkillsMP 来源标记）。
- 删除 = 移入 trash（目录 + 符号链接）+ 清理 global/thread 策略引用 + 记录审计；
  元数据保存原策略快照，`restore_skill` 可完整恢复。
- 禁止删除 `skill-scope-guard`、`skill-scope` 主 Skill、插件自带 Skill。

## 5. SkillsMP 安装

1. 解析来源：本地目录 / SkillsMP 页面（抓取页面中的 GitHub 链接）/ GitHub URL / `owner/repo`。
2. `git clone --depth 1` 到临时目录（本地目录则直接使用）。
3. 定位 `SKILL.md`（仓库根或子目录，深度 ≤5），校验 frontmatter 与名称。
4. 仅复制文件到 `$DATA_DIR/skills/<name>`（排除 `.git`/`node_modules`），写来源标记。
5. 写入 global 策略并建立 `~/.codex/skills/<name>` 符号链接，立即在列表显现。
6. 任何失败都清理临时目录并返回错误；**绝不执行下载内容中的脚本**。

## 6. 迁移

`migrateProjectPolicies()` 幂等：发现 `$DATA_DIR/policy/projects/` 时整体移动到
`$DATA_DIR/archive/project-policy-<ts>/` 并写入标记，CLI `status`/`migrate` 与
`get_status` 会提示归档位置。

## 7. 本地 Dashboard

`lib/server.js` 提供零依赖 HTTP 服务（仅 `127.0.0.1`），`web/` 提供静态页面。

### 会话模型

- CLI/MCP 调 `openDashboard`：未运行则拉起 `bin/skill-scope-dashboard.js`，写
  `$DATA_DIR/runtime/dashboard-state.json`（pid/port/controlToken）。
- `POST /api/session/launch` 需要 `Authorization: Bearer <controlToken>`，返回
  `http://127.0.0.1:<port>/launch/<nonce>`（60 秒、一次性）。
- 浏览器访问 launch 链接后获得 `skill-scope-session` Cookie；除 `/api/health` 与
  `/api/session/*` 外的 `/api/*` 均要求会话，写操作额外校验同源 Origin。

### API

| 方法/路径 | 说明 |
|---|---|
| GET /api/health | 健康检查（公开） |
| GET /api/skills | 全量 Skill + effective/scopeState/policies/trashCount |
| GET /api/policy | global/thread 策略 |
| POST /api/policy/plan · apply · rollback | 计划 → 确认 → 回滚 |
| GET /api/transactions | 事务列表 |
| GET /api/trash · POST restore · purge | 回收站 |
| POST /api/skills/delete-plan · delete | 删除计划与执行 |
| POST /api/market/install | SkillsMP/GitHub 安装 |
| GET /api/audit · /api/doctor | 审计与一致性 |

### 页面

- 侧边导航：Skills、作用域、回收站、事务、审计、Doctor。
- 统计条：Skill 总数、全局启用、对话级覆盖、回收站、受限（禁用）。
- 卡片：名称/描述/来源/分类/受管徽标、最终生效状态（启用/禁用 + thread/global）、
  当前作用域「开/关/继承」开关、删除入口（仅受管 Skill）。
- 作用域切换只有 global/thread；thread 自动读取 `CODEX_THREAD_ID`。
- 所有写操作先弹计划面板，确认后执行；删除/恢复/永久清除均有明确确认与回滚路径。

## 8. 已知限制

- 对话级开关依赖守护 Skill 约束，不是 Codex 原生按线程物理隔离。
- `open_skillsmp` 依赖系统默认浏览器（`open` / `xdg-open` / `cmd start`）。
- SkillsMP 页面解析依赖页面中的 GitHub 链接；页面结构变化时可能失败并返回明确错误。
