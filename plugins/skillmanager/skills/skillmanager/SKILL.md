---
name: skillmanager
description: 使用 SkillManager 检查、诊断和打开本机 Agent Skills。当用户说“打开 SkillManager / Skill 管理器”，要求检查 Skills、查找重复或重叠项、了解 Skill 为什么没有触发、查看健康状态、检查 Codex 可见性，或打开当前项目的 Skill 配置时使用。
---

# SkillManager

把 SkillManager 作为本机 Agent Skills 的“先读取、后操作”控制台。

## 判断该走哪条路径

1. 尝试打开 Dashboard 前先调用 `get_status`，不要盲目重复启动服务。
2. 用户询问清单、筛选、重复项、健康状态或触发问题时，先调用对应的只读工具：
   - `list_skills`：列出和筛选 Skills。
   - `get_skill_summary`：查看单个 Skill 的元数据与 Agent 可见性。
   - `diagnose_library`：检查冲突、重叠和健康问题。
   - `diagnose_skill`：诊断单个 Skill 的触发问题。
3. 只有用户明确要看界面、比较细节、查看诊断项或版本，或需要在浏览器确认写操作时，才调用 `open_dashboard` 或 `get_deep_link`。

绝不能通过 `file://` 打开 `web/index.html`、`dist/web/index.html` 或其他 SkillManager 页面。这些只是源码或构建产物，并不是可运行的 Dashboard。必须使用 `open_dashboard`、`get_deep_link` 或 `skillmanager open --project <目录>`，让托管服务签发一次性本地会话。

## 保持证据边界

结论必须使用以下标签：

- `confirmed`：直接观察到的元数据、安装、可见性、冲突或配置状态。
- `likely`：可能解释当前行为的静态信号，但不是运行时证明。
- `needs_runtime_test`：需要在新的 Codex 对话里用原提示词实测。
- `blocked`：缺少必要安装、运行环境或授权。

不能声称静态检查已经证明模型实际选择了哪个 Skill。

## 写操作留在 Dashboard

P0 MCP 工具不会编辑、删除、覆盖、恢复或推送 Skill 数据。遇到这类请求时：

1. 用一句话说明准备做什么。
2. 打开对应的 Dashboard 深链接。
3. 让浏览器展示服务端生成的计划、差异、风险、有效期与恢复路径。
4. 要求用户在浏览器里明确确认。

不要用 shell 命令或客户端提供的路径绕过 ActionPlan 流程。

## 保护本地数据

只返回不透明 ID 和摘要。不要暴露用户目录绝对路径、控制凭据、GitHub token、完整 `SKILL.md` 正文、辅助文件内容，或用户没有要求的项目清单。
