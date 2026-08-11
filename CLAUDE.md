# Claude Code Handoff

本仓库的完整协作规则见 `AGENTS.md`，工程与隐私边界见 `README.md`、`PRIVACY.md`、`SECURITY.md` 和 `TRANSFER.md`。本机存在项目 Handoff 时再作为补充阅读，移交包不会携带机器调查记录。

必须保持以下约束：

- macOS 本机、loopback、只读；
- 群聊优先，私信允许尽力读取；
- 只在 `$wechat-dashboard` 被调用时启动，不创建 Automation、cron 或 LaunchAgent；
- Dashboard 页面打开期间由独立滚动心跳保持本机服务，并每 10 分钟增量同步微信与飞书群聊、私信；全部页面关闭后约 3 分钟退出。每轮同步完整完成后才能运行 Terra，语义分析循环只存在于仍运行的当前 Agent 任务中，任务结束后停止模型分析；
- 不运行 `wx init`，不高频重启或重新登录微信；
- 只允许 WeChat Dashboard Skill 导出受限的当日双端会话上下文；私信必须由对应平台设置显式开启；完整数据库、账号目录和密钥不得进入模型上下文；
- 语义分析只接受 `gpt-5.6-terra`、reasoning `high`，不得使用 Luna 或伪报模型；
- 当前宿主无法提供 Terra High 时，只允许启动本机页面与双端同步，不得生成或导入语义结果；
- 逐会话汇总、重点关注提示和潜在商机不得跨会话合并，必须通过 evidence ID 校验；
- 敏感字段继续使用 Keychain 主密钥加密落盘；
- 不丢弃当前未提交工作树。

完成修改后运行 ESLint、TypeScript 和 production build，并用匿名计数验证真实行为后再报告完成。
