# 项目移交说明

“微信飞书消息分析 Dashboard”是一个 macOS 本机双端会话分析项目。代码、依赖锁文件、安装脚本和 Agent Skill 可以移交；微信数据库密钥、飞书令牌、本机 Keychain 主密钥、聊天数据库和账号目录必须在每台 Mac 上独立配置。

## 移交包包含

- Next.js Dashboard 全部受版本控制的源码；
- 微信只读同步与飞书用户身份只读同步；
- 群聊汇总、重点关注提示和潜在商机；
- Terra High 语义分析契约与同会话 evidence 校验；
- SQLite 字段级加密、loopback 服务和按需会话租约；
- Codex / Claude Code Skill、安装与验收脚本；
- 锁定的 pnpm 依赖清单、隐私和安全文档。

## 主动排除

- `.git/`、`node_modules/`、`.next/`、缓存和构建产物；
- `.env`、真实数据库、WAL / SHM、日志和备份；
- `~/.wx-cli`、`~/.wechat-dashboard` 与 macOS Keychain 内容；
- 飞书 OAuth 令牌、微信数据库密钥、联系人、群名、私信名和聊天正文；
- 本机项目 Handoff、机器调查记录、真实截图、UI mockup 原包和历史 ZIP。

## 新 Mac 的接入顺序

1. 解压移交包，先阅读包内“先读我”和“首次连接双端”。
2. 运行安装脚本，按锁文件安装依赖、重建 `better-sqlite3`、构建 Dashboard 并安装 Skill。
3. 在该 Mac 上单独验证微信读取器；不得复制其他用户的密钥映射或数据库。
4. 使用官方 `lark-cli` 初始化飞书应用并以 user 身份完成 IM 域授权。
5. 打开 `/setup`，确认本机隐私边界和两端状态，再开始同步。
6. 语义分析只允许 Terra High；宿主无法提供该模型与推理强度时，只运行本机同步和页面。

## 验收基线

```bash
pnpm install --frozen-lockfile
pnpm rebuild better-sqlite3
pnpm lint
./node_modules/.bin/tsc --noEmit
pnpm build
pnpm intelligence:verify
pnpm priority:verify
pnpm session:verify
pnpm security:verify
pnpm skill:check
pnpm reader:inspect
```

真实数据验收只输出匿名计数、覆盖率和标准化错误码，不把任何聊天内容写入仓库或日志。
