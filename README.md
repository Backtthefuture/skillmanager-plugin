<p align="center"><img src="docs/assets/skillmanager-mark.svg" width="112" alt="SkillManager"></p>
<h1 align="center">SkillManager for Codex</h1>

<p align="center">把散落在不同 Agent 目录里的 Skills，安全整理成一个可追踪的主版本。</p>

## 安装

```bash
codex plugin marketplace add Backtthefuture/skillmanager-plugin
codex plugin add skillmanager@backtthefuture
```

安装后新建 Codex 任务，输入 **“打开 SkillManager”**。插件会启动或复用只监听 `127.0.0.1` 的本地服务，并返回 60 秒内有效、仅可使用一次的安全链接。不要打开源码中的 `file://web/index.html`。

## 更新日志

见 [CHANGELOG.md](CHANGELOG.md)。

## 能做什么

- 区分“Agent 已安装”和“某个 Skill 支持该 Agent”，避免虚假的安装数量。
- 发现重复副本，选择唯一主版本，把其他 Agent 位置整理为共享链接。
- 所有写入遵循预览、确认、陈旧状态检查、恢复快照或废纸篓记录。
- MCP 只暴露诊断和打开入口，不默认返回 Skill 正文或本机绝对路径。

## 平台

发布物要求 Node.js 20+，内含 `@napi-rs/keyring` 锁定的 12 个官方目标：macOS ARM/Intel、Windows ARM64/x64/ia32、Linux x64/ARM64 的 glibc/musl、Linux ARM/RISC-V 与 FreeBSD x64。源码 CI 在 macOS、Ubuntu、Windows 的 Node.js 20/22 上分别运行隔离验收；其余目标为制品完整性静态校验。

## 安全与隐私

- Dashboard 仅监听 `127.0.0.1`。
- GitHub 同步是可选功能，只有用户主动预览并确认后执行。
- GitHub Token 存放在操作系统凭据库，本地配置只保存引用。
- SkillManager 不运行托管数据收集服务。

[产品页](https://backtthefuture.github.io/skillmanager-plugin/) · [隐私说明](https://backtthefuture.github.io/skillmanager-plugin/privacy.html) · [使用条款](https://backtthefuture.github.io/skillmanager-plugin/terms.html) · [支持](https://backtthefuture.github.io/skillmanager-plugin/support.html)

## 开发与验证

开发源码位于 [Backtthefuture/skillmanager](https://github.com/Backtthefuture/skillmanager)。本仓库是经验证的 Public Git Marketplace 发布物。发布证明见 `plugins/skillmanager/release-manifest.json`。

同一发布物内含 macOS、Windows、Linux 与 FreeBSD 的官方钥匙串绑定，启动时会自动选择。源码 CI 会在 macOS、Ubuntu、Windows 的 Node.js 20/22 上分别执行隔离验收。

## License

MIT
