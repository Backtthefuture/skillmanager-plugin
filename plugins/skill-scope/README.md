# Skill Scope

Skill Scope 是一个完全独立的 Codex 插件，用于管理本地 Agent Skill：

- **两层作用域**：`global`（全局常开）与 `thread`（对话级，自动读取 `CODEX_THREAD_ID`）；
  优先级 `thread > global`，未配置继承，默认启用，显式关闭优先。
- **直接开关**：MCP/CLI 直接启用/禁用任意受管 Skill；默认先出计划，确认后生效，可回滚。
- **删除/恢复**：受管 Skill 可删除（先移入 `$DATA_DIR/trash/`）并随时恢复。
- **SkillsMP**：一键打开 https://skillsmp.com；从 SkillsMP 页面 / GitHub 仓库 / `owner/repo`
  下载 Skill，校验后复制到受管库并立即出现在列表与对话白名单中。
- **本地 Dashboard**：skill-scope 自带仅监听 127.0.0.1 的 Web Dashboard
  （Skills 总览 / 作用域 / 回收站 / 事务 / 审计 / Doctor），所有能力同时可通过
  MCP 工具、CLI 与 Codex 对话使用。

> 说明：本插件由 SkillManager 派生并重写为独立实现（MIT，保留原作者署名），
> 已不再依赖或内置 SkillManager。旧 `project` 级策略数据会在首次运行时归档到
> `$DATA_DIR/archive/`，不删除、不影响既有 global/thread 数据。

## 安装

```bash
codex plugin add skill-scope@backtthefuture
```

然后在 Codex“+ 添加插件”中启用，并**新开一个对话**以加载插件 Skill 与 MCP 工具。

## MCP 工具

| 工具 | 说明 |
|---|---|
| `get_status` | 版本、数据目录、迁移状态、Skill 统计 |
| `list_skills` | 全量 Skill + 最终生效状态/来源/管理归属/trash 计数 |
| `list_skill_scopes` | global/thread 两层策略 |
| `get_skill_policy` | 单 Skill 指定层策略与最终状态、来源 |
| `set_skill_enabled` | 开关 Skill；默认落到当前对话（thread），无 thread id 时回退 global 并警告 |
| `reset_skill_scope` | 重置单 Skill 或整层为继承 |
| `get_active_skills` | 当前对话白名单（守护 Skill 调用） |
| `delete_skill` | 删除受管 Skill（默认 preview；`preview:false` 执行，移入 trash） |
| `restore_skill` | 从 trash 恢复 Skill 及原策略/符号链接 |
| `open_skillsmp` | 用系统浏览器打开 https://skillsmp.com |
| `install_from_skillsmp` | 从 SkillsMP/GitHub 下载并安装 Skill，立即显现 |
| `open_dashboard` | 启动（或复用）本地 Dashboard 并返回 60 秒一次性 launch URL |

所有写工具默认 `preview: true`，确认后才执行。

## CLI

```bash
skill-scope status
skill-scope policy list
skill-scope policy enable --scope global --skill my-skill --apply
skill-scope policy disable --scope thread --skill my-skill --apply   # 自动用 CODEX_THREAD_ID
skill-scope policy reset --scope thread --skill my-skill --apply
skill-scope skill list
skill-scope skill delete my-skill --apply
skill-scope skill restore my-skill
skill-scope market open
skill-scope market install https://skillsmp.com/skills/xxx
skill-scope dashboard open          # 启动并打开本地 Dashboard
skill-scope dashboard status        # 查询运行状态
skill-scope dashboard stop          # 停止 Dashboard
skill-scope rescan
skill-scope doctor
skill-scope migrate
```

## 本地 Dashboard

skill-scope 自带一个本地 Web Dashboard（skill-scope 自己的实现，不依赖 SkillManager）：

- 仅监听 `127.0.0.1`；所有写操作需要先通过一次性 launch 链接建立会话，
  链接 60 秒内有效且只能用一次。
- 页面：Skills 总览（全量卡片、独立开关、搜索/筛选/批量）、作用域（global/thread）、
  回收站（恢复/永久清除）、事务/回滚、审计、Doctor。
- 顶部作用域切换只有 `global / thread`；thread 模式自动显示 `CODEX_THREAD_ID`，
  缺失时可手动输入并提示降级到 global。
- 删除 Skill 先出计划，确认后移入回收站；回收站可恢复，永久清除需二次确认。
- 顶部可一键打开 SkillsMP，并粘贴 SkillsMP/GitHub/owner-repo 地址直接安装。

打开方式：

```bash
skill-scope dashboard open
```

或通过 MCP `open_dashboard`。服务未启动时会自动拉起，已运行则复用并生成新会话链接。

## 数据与迁移

- 策略：`$DATA_DIR/policy/global.json`、`$DATA_DIR/policy/threads/<thread-id>.json`
  （macOS 默认 `~/Library/Application Support/SkillManager/policy`，可用
  `SKILL_SCOPE_DATA_DIR` 覆盖）。
- 受管库：`$DATA_DIR/skills/<name>`；符号链接：`~/.codex/skills/<name>`；
- trash：`$DATA_DIR/trash/<name>-<ts>/`；事务/审计/备份沿用 `policy/` 子目录。
- 旧 `project` 策略：首次运行自动归档到 `$DATA_DIR/archive/project-policy-<ts>/`，
  `skill-scope migrate` 可手动触发，`status` 会提示归档位置。

## 安全

- 只复制下载内容，**绝不执行**下载的脚本。
- 禁止删除 `skill-scope-guard`、`skill-scope` 主 Skill 与任何插件自带 Skill。
- 删除先移入 trash，可恢复；所有写操作可回滚。

## 测试

```bash
node --test test/
```

覆盖策略解析/继承、符号链接与回滚、旧 project 数据归档、Skill 删除/恢复、
本地目录安装（SkillsMP/GitHub 安装逻辑的同源实现）、MCP JSON-RPC 全工具调用、CLI 冒烟。

## 文档

- [docs/DESIGN.md](docs/DESIGN.md) — 架构与数据模型
- [docs/ROLLBACK.md](docs/ROLLBACK.md) — 回滚与卸载
- [docs/ACCEPTANCE.md](docs/ACCEPTANCE.md) — 验收报告

## License

MIT。基础设计衍生自 SkillManager（Backtthefuture），新增实现同样以 MIT 发布。
