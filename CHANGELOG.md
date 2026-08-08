# Changelog

## [0.1.0+codex.20260808040500] — 2026-08-08

### skill-scope · 自动对话作用域

- 移除卡片上的“对话级（默认关）/ 普通”分类开关，以及 thread 层的“继承”按钮。
- 作用域面板与计划预览中的“继承”文案改为“移除本层显式配置”。
- 新默认行为：在某个对话（thread 层）显式开启的 Skill 只在该对话运行；
  其他对话默认关闭，且不再回退到 global。
- 清除所有 thread 开启记录后，Skill 恢复原默认（global / 默认启用）。
- 旧版 `defaults` 手动分类与 `set_skill_default` / `policy default` 仅保留兼容。
- 新增自动对话作用域策略测试；全套 30 项测试通过。

## [0.1.0+codex.20260808035718] — 2026-08-08

### skill-scope · 对话级分类 UX 简化

- Dashboard 的“对话级默认 默认关/开/继承”改为“对话级（默认关）/ 普通”两个动作：
  设为对话级即对所有对话默认关闭，取消即恢复普通。
- 明确 thread 层是唯一按对话生效的层：某对话显式开启后只在该对话运行，其他对话保持关闭。
- “默认开启”分类仅在数据与 API 层保留兼容，不再出现在界面。

## [0.1.0+codex.20260807155704] — 2026-08-08

### skill-scope · 对话级默认关闭

- 新增“对话级默认关闭”分类：把任意 Skill 标记为 `defaults.<skill>.thread = "disabled"`
  后，它在所有对话中默认禁用，只有显式开启（thread 或 global）才会启动。
- 生效顺序调整为 `thread 显式 > global 显式 > 对话级默认分类 > 未分类默认启用`。
- 新增 MCP 工具 `set_skill_default`：`thread_default` 支持 `disabled` / `enabled` / `inherit`。
- 新增 CLI 子命令 `skill-scope policy default --skill <name> --state disabled|enabled|inherit`。
- Dashboard 卡片新增“对话级默认 默认关/开/继承”开关，作用域页新增默认分类列表。
- 守护 Skill 生效规则同步更新：默认关闭的 Skill 出现在 `get_active_skills` 的 `disabled`，
  不会被动用；只有显式开启后才进入白名单。
- 所有写操作继续写入审计日志 `policy/audit.jsonl`（计划创建、执行、回滚均含默认分类操作）。
- 新增策略、CLI、MCP 与回滚测试；全套 29 项测试通过。

### skill-scope · 先前未发布修复

- Dashboard 修复 `[hidden]` 全局覆盖规则，解决 modal/toast/field 显隐回归。
- Dashboard Skills 页面改为枚举所有 Codex 可见 Skill（系统/插件/用户/受管/SkillsMP）。

## [0.1.0] — 2026-08-07

### skill-scope · 初始版本

- 两层作用域（global/thread），优先级 `thread > global`，未配置继承、默认启用。
- 直接开关、删除/恢复（trash）、SkillsMP/GitHub 安装、本地 Dashboard。
- 计划预览、事务回滚、审计日志与 Doctor 一致性检查。
