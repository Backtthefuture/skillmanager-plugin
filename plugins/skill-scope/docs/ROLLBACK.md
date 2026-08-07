# 回滚与卸载

## 原则

- 所有写操作默认只出计划（`preview` / 无 `--apply`），确认后才落盘。
- 删除先移入 `$DATA_DIR/trash/`；符号链接替换先备份到 `$DATA_DIR/policy/backup/`。
- 事务记录在 `$DATA_DIR/policy/transactions.json`，审计在 `audit.jsonl`。

## 回滚途径

- 策略变更：`skill-scope policy reset --scope <global|thread> --skill <name> --apply`
  （或 MCP `reset_skill_scope`）。引擎层 `rollbackTransaction(ctx, txnId)` 可精确回滚事务。
- Skill 删除：`skill-scope skill restore <name>`（MCP `restore_skill`），恢复目录、
  符号链接与 global/thread 策略快照。
- 安装失败：临时目录自动清理；若安装成功但需移除，
  先 `skill-scope skill delete <name> --apply`，再 `restore` 或保留 trash。

## Dashboard

- 停止：`skill-scope dashboard stop`（或 MCP/浏览器关闭后由系统回收）。
- Dashboard 写操作同样走 `plans.json` → `transactions.json`；
  页面“事务 · 回滚”页签可一键回滚，恢复策略与符号链接。

## 卸载

```bash
codex plugin remove skill-scope@backtthefuture
```

卸载不会删除策略、受管 Skill 或 trash。如需彻底清理：

1. `skill-scope skill restore` 需要的项；
2. `skill-scope policy reset --scope global --all --apply`；
3. 删除 `$DATA_DIR/skills/`、`$DATA_DIR/trash/`、`$DATA_DIR/policy/` 与
   `~/.codex/skills/` 中由插件创建的符号链接（Doctor 会列出）。

> 旧 `project` 策略归档在 `$DATA_DIR/archive/`，按需手动合并或删除。
