# Claude Code Handoff

本仓库的完整协作规则见 `AGENTS.md`，工程与隐私边界见 `README.md`、`PRIVACY.md` 和 `SECURITY.md`。开始工作前还需完整阅读 `WeChat_Dashboard_Context_Handoff_OC_0809[A].md`。

必须保持以下约束：

- macOS 本机、loopback、只读；
- 群聊优先，私信允许尽力读取；
- 只在 `$wechat-dashboard` 被调用时启动，不创建 Automation、cron 或 LaunchAgent；
- Dashboard 页面打开期间每 30 分钟增量同步；语义分析循环只存在于仍运行的当前 Agent 任务中，页面关闭或任务结束后停止；
- 不运行 `wx init`，不高频重启或重新登录微信；
- 只允许 WeChat Dashboard Skill 导出受限的当日群聊上下文；Codex 首选 Luna Max、回退 Terra Max，Claude Code 使用当前实际模型；私信、完整数据库、账号目录和密钥不得进入模型上下文；
- 逐群汇总不得跨群合并，重点关注提示必须通过 evidence ID 校验；
- 敏感字段继续使用 Keychain 主密钥加密落盘；
- 不丢弃当前未提交工作树。

完成修改后运行 ESLint、TypeScript 和 production build，并用匿名计数验证真实行为后再报告完成。
