---
name: skill-scope
description: 使用 skill-scope 管理 Codex 本地 Skill 的全局/对话级开关、删除与恢复、从 SkillsMP/GitHub 下载 Skill。当用户要求“开关 Skill”“下载 Skill”“删除 Skill”“查看 Skill 白名单”或提到 SkillsMP 时使用。
---

# Skill Scope

skill-scope 是一个独立的 Codex 插件，通过 MCP 工具与 CLI 管理本地 Skill：

- 两层作用域：`global`（全局常开）与 `thread`（对话级，自动读取 `CODEX_THREAD_ID`）；
  优先级 `thread > global`；未配置时回退到 global（对话作用域 Skill 除外），
  默认启用，显式关闭优先。
- 自动对话作用域：在某个对话（thread 层）显式开启的 Skill，只在该对话运行；
  其他对话默认关闭，不再回退到 global。清除该对话的 thread 开关后恢复原默认。
- 直接开关：`set_skill_enabled` / `reset_skill_scope`（默认先出计划，确认后执行）。
- 删除/恢复：`delete_skill`（移入 trash，可回滚）与 `restore_skill`。
- SkillsMP：`open_skillsmp` 打开市场；`install_from_skillsmp` 从 SkillsMP 页面、
  GitHub 地址或 `owner/repo` 下载并校验 Skill，安装后立即在列表中显现。

## 使用路径

1. 先 `get_status` 或 `list_skills` 了解当前 Skill 库与生效状态。
2. 开关 Skill：`set_skill_enabled({ skill, enabled })`，默认落到当前对话
   （thread 层）；想全局生效时传 `scope: "global"`。
3. 按对话使用：在目标对话调用 `set_skill_enabled({ skill, enabled: true })`
   （默认落到 thread 层）即可，该 Skill 自动只在那个对话运行；
   旧版 `set_skill_default` 仅保留兼容。
4. 下载 Skill：`open_skillsmp` 打开市场；拿到页面或 GitHub 地址后调用
   `install_from_skillsmp({ source })`。
5. 删除 Skill：`delete_skill({ name, preview: true })` 查看计划，确认后
   `preview: false` 执行；`restore_skill({ name })` 从 trash 恢复。
6. 查看当前对话白名单：`get_active_skills()`（自动带 thread id）。

## 安全边界

- 绝不执行下载内容中的脚本；只复制文件并校验 frontmatter。
- 删除只针对受管 Skill；禁止删除插件自带 Skill 与系统能力。
- 所有写操作先出计划、可回滚；CLI 对应命令见 `skill-scope --help`。
