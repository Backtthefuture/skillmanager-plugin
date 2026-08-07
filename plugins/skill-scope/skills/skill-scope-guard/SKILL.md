---
name: skill-scope-guard
description: 由 skill-scope 插件提供的对话级守护 Skill。当对话涉及受限 Skill 时，必须先调用 get_active_skills 获取当前线程白名单；thread > global，未查询前不得假定任何受限 Skill 可用，查询失败时 fail-closed。
---

# Skill Scope Guard

本 Skill 强制在单个对话内执行 Skill 作用域策略。它是 skill-scope 插件内置的常开守护项，
不受作用域开关限制。

## 何时必须查询

出现以下情况时，**先调用 `get_active_skills`，再使用任何受限 Skill**：

1. 用户要求使用、引用或描述某个 Skill 的能力；
2. 你要决定是否采用某个 Skill 的流程、模板或工具约定；
3. 对话上下文出现 Skill 名称，但你不知道它在本对话是否启用；
4. 用户明确要求“按对话开关”“禁用某个 Skill”“用全局默认”。

受限 Skill 集合由 `get_active_skills` 返回的 `managed_skills` 给出。
**未查询前不得假定某个 Skill 可用。**

## 线程 id 获取（自动）

1. `get_active_skills` / `set_skill_enabled` / `reset_skill_scope` 会优先读取环境变量
   `CODEX_THREAD_ID`（Codex 会话中实测存在，值为 UUID）；无需手动传参。
2. 也可显式传 `thread_id`（例如从会话元数据取得的对话 id）。
3. 两者都缺失时，工具返回 `THREAD_ID_MISSING` 警告并降级到 global 策略；
   你要在回复中说明：对话级开关无法生效，当前只按全局策略执行。

## 生效规则（两层）

- 优先级：`thread > global`。
- thread 未配置时继承 global；global 未配置时默认启用。
- 显式关闭优先于显式启用。
- 只使用返回结果 `enabled` 数组中的 Skill；`disabled` 中的 Skill 不得调用，
  不得以其流程作答，也不得绕道读取其 `SKILL.md`。
- `get_active_skills` 调用失败时，对受限 Skill 采取 **fail-closed**：不假定可用，
  并向用户说明查询失败原因。

## 删除与安装安全

- `delete_skill` 默认只返回删除计划；`preview:false` 才执行，且只允许删除受管 Skill。
- 禁止删除本守护 Skill、`skill-scope` 主 Skill 或任何插件自带 Skill。
- `install_from_skillsmp` 只下载并复制文件，**绝不执行**下载内容中的脚本；
  安装成功后 Skill 立即出现在 `list_skills` / `get_active_skills` 中。

## 边界

- 本守护 Skill、`skill-scope` 主 Skill、系统内置能力不受作用域限制。
- 作用域只约束 skill-scope 管理的受限 Skill；非受限 Skill 不受影响。
