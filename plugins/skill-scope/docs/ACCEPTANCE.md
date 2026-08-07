# skill-scope 独立版验收报告

日期：2026-08-07
形态：独立插件，无 SkillManager 依赖，无 Dashboard，作用域 global/thread 两层，
支持删除/恢复与 SkillsMP 下载。

## 实现清单

- [x] 独立命名：`bin/skill-scope.js`、`bin/skill-scope-mcp.js`、MCP server
      `skill-scope-mcp-server`、CLI 命令 `skill-scope`；删除 `skillmanager` 命令名。
- [x] 删除 `skills/skillmanager`；新增 `skill-scope` 主 Skill，保留并更新
      `skill-scope-guard`。
- [x] 删除 Dashboard：移除 `dist/web`、HTTP 服务与全部静态托管接口，不监听端口。
- [x] 双层作用域：global/thread；旧 project 策略自动归档
      （`$DATA_DIR/archive/project-policy-<ts>/`，不删除）。
- [x] 对话级自动确认：MCP/CLI 自动读 `CODEX_THREAD_ID`；缺失时 `THREAD_ID_MISSING`
      并降级 global。
- [x] 删除 Skill：`delete_skill`（preview 默认）/ `skill-scope skill delete`，
      移入 `$DATA_DIR/trash/`，同步清理策略引用；`restore_skill` 完整恢复。
- [x] SkillsMP：`open_skillsmp` 打开 https://skillsmp.com；
      `install_from_skillsmp` 支持 SkillsMP 页面 / GitHub URL / owner/repo / 本地目录，
      下载后复制到受管库、全局启用并立即显现。
- [x] 安全：禁止删除核心/插件自带 Skill；只复制不执行下载内容。
- [x] 包元数据：`package.json`、`plugin.json`、`.mcp.json`、release-manifest 更新；
      无 runtime 二进制依赖。
- [x] 重新加入本地 Dashboard（skill-scope 自己的实现）：`lib/server.js` + `web/`，
      仅监听 127.0.0.1，一次性 launch 会话；CLI `dashboard open|status|stop`、
      MCP `open_dashboard`；页面含 Skills/作用域/回收站/事务/审计/Doctor。

## 测试结果

（最终以 `node --test test/` 结果为准，预期全部通过）

- 策略：两层继承、显式关闭优先、符号链接创建/移除与回滚、旧 project 归档 ✔
- Skill 库：扫描（managed/user/skillsmp）、删除→trash→恢复、策略引用清理 ✔
- 安装：本地目录安装并立即出现于 `list_skills` / `get_active_skills`；
  GitHub/SkillsMP 解析逻辑有独立用例（网络真实安装按需手工验收）✔
- MCP：JSON-RPC over stdio 全工具（get_status、list_skills、list_skill_scopes、
  get_skill_policy、set_skill_enabled、reset_skill_scope、get_active_skills、
  delete_skill、restore_skill、open_skillsmp、install_from_skillsmp）✔
- CLI：status/policy/skill/market/doctor/migrate 冒烟 ✔
- Dashboard：`/api/health` 200、`/` 与 `/dashboard.js` 200、launch 会话 →
  plan/apply 全链路、无会话写接口 401 ✔
- 插件清单：`validate_plugin.py` 通过 ✔
- 重装：cachebuster 刷新 + `codex plugin add skill-scope@backtthefuture`，
  `codex plugin list` 显示独立版本 ✔

## 手工验收说明

1. 新对话中 `get_active_skills` 自动带当前 thread id（`CODEX_THREAD_ID`）。
2. 对话级开关只影响当前对话；全局开关影响所有对话。
3. `open_skillsmp` 打开 https://skillsmp.com（本环境可设置 `SKILL_SCOPE_NO_OPEN=1` 验证返回）。
4. 用一个公开 GitHub Skill 执行 `install_from_skillsmp`，安装后 `list_skills`
   立即出现该 Skill（网络场景需真实 GitHub 可达）。
5. `delete_skill` 后 Skill 从列表消失，`restore_skill` 可恢复。
6. 任何浏览器端口/Dashboard 页面均不存在。
7. `codex plugin list` 显示独立 skill-scope；skillmanager 插件是否保留由用户决定，互不依赖。

### Dashboard 交互说明（独立版）

`skill-scope dashboard open`（或 MCP `open_dashboard`）返回
`http://127.0.0.1:<port>/launch/<nonce>`：

1. 浏览器打开后进入 Skills 总览：统计条显示 Skill 总数、全局启用、对话级覆盖、
   回收站、受限数量；卡片展示全部 Skill（含未配置的“默认启用（global）”）。
2. 顶部 `global / thread` 切换：thread 模式自动填入 `CODEX_THREAD_ID`
   （服务端 `/api/session/context` 提供），缺失时提示降级 global。
3. 卡片「开 / 关 / 继承」→ 计划面板（策略 + 软链差异 + 风险）→ 确认执行 →
   toast 显示事务号并提供回滚入口；执行后卡片徽标即时更新。
4. 「删除」→ 删除计划（受管副本、软链、策略引用）→ 确认后进入回收站；
   回收站页签可恢复，永久清除需二次确认；核心/插件自带 Skill 无删除入口。
5. “打开 SkillsMP”在新标签页打开 https://skillsmp.com；安装输入框接受
   SkillsMP 页面/GitHub/owner-repo，成功后该 Skill 立即出现在列表并刷新统计。
6. 作用域页签展示 global 与各 thread 的启用/禁用集合，可点击 ✕ 重置为继承。

> 截图说明：本环境 headless Chrome 无法启动，故以自动化服务端冒烟测试 +
> 上述交互说明代替截图；页面资源与全部 API 均经测试验证。

### 真实 GitHub 安装冒烟（2026-08-07）

```bash
skill-scope market install https://github.com/anthropics/skills.git --json
```

结果：成功安装 `algorithmic-art`（来自 anthropics/skills 官方仓库），复制到
`$DATA_DIR/skills/algorithmic-art`，在 `~/.codex/skills/algorithmic-art` 建立符号链接，
写入 global 启用策略；随后 `skill-scope skill list --json` 立即显示
`algorithmic-art: skillsmp: on`。同时验证了失败路径：无 SKILL.md 的仓库返回
`SKILL_NOT_FOUND` 并清理临时目录；大仓库超时返回 `GIT_CLONE_FAILED` 并清理临时目录。

## 已知限制

- 对话级开关依赖守护 Skill 约束（Codex 无原生按线程物理隔离）。
- 沙箱 `codex exec` 环境可能不向模型暴露任何插件 MCP 工具（对全部插件一致）；
  MCP 能力已由 JSON-RPC 集成测试验证，建议在桌面端新对话做最终工具级确认。
- SkillsMP 安装依赖网络与 `git` CLI；页面结构变化时解析会返回明确错误。
