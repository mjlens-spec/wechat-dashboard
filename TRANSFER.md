# 项目移交说明

“微信飞书消息分析 Dashboard”是一个 macOS 本机双端会话分析项目。代码、依赖锁文件、安装脚本和 Agent Skill 可以移交；微信数据库密钥、飞书令牌、本机 Keychain 主密钥、聊天数据库和账号目录必须在每台 Mac 上独立配置。

## 移交包包含

- Next.js Dashboard 全部受版本控制的源码；
- 微信只读同步与飞书用户身份只读同步；
- 群聊汇总、重点关注提示和潜在商机；
- Terra High 语义分析契约与同会话 evidence 校验；
- SQLite 字段级加密、带来源范围的自定义关键词、loopback 服务、默认浏览器标签页复用和页面心跳按需租约；
- Codex Skill、项目专用运行时自举、安装与验收脚本；
- 面向既有安装的 Codex 升级说明、相对路径源码清单和升级前备份要求；
- 锁定的 pnpm 依赖清单、隐私和安全文档。

## 主动排除

- `.git/`、`node_modules/`、`.next/`、`.runtime/`、缓存和构建产物；
- `.env`、真实数据库、WAL / SHM、日志和备份；
- `~/.wx-cli`、`~/.wechat-dashboard` 与 macOS Keychain 内容；
- 飞书 OAuth 令牌、微信数据库密钥、联系人、群名、私信名和聊天正文；
- 本机项目 Handoff、机器调查记录、真实截图、UI mockup 原包和历史 ZIP。

## 新 Mac 的接入顺序

1. 解压移交包，先阅读包内“先读我”和“首次连接双端”。
2. 运行安装脚本。接收方无需预装 Node.js、pnpm 或飞书 CLI；脚本会使用兼容的现有 Node.js，或下载并校验项目专用 Node.js 22.23.1，再按锁文件安装依赖、重建 `better-sqlite3`、构建 Dashboard 并安装 Codex Skill。
3. 在该 Mac 上单独验证微信读取器；不得复制其他用户的密钥映射或数据库。
4. 使用官方 `lark-cli` 初始化飞书应用并以 user 身份完成 IM 域授权。
5. 打开 `/setup`，确认本机隐私边界和两端状态，再开始同步。
6. ChatGPT Pro 可提供 Codex 使用资格，但不保证宿主一定暴露 `gpt-5.6-terra`。Skill 优先创建隔离的 Terra High 执行单元；宿主无法提供该模型与推理强度时，只运行本机同步和页面。

## 另一台 Mac 的覆盖升级

把完整 ZIP 上传给另一台 Mac 的 Codex 后，让它先阅读包外层的 `AGENTS.md` 和 `CODEX_UPGRADE.md`。升级过程不假设原项目的绝对路径：Codex 应优先从 `~/.codex/skills/wechat-dashboard` 的现有链接反向定位项目，也可以在用户指定的工作区内查找 `package.json` 中名称为 `wechat-feishu-message-analysis-dashboard` 的目录。

确认目标后，先检查未提交改动并备份即将覆盖的源码，再按 `SOURCE_FILES.json` 的相对路径覆盖。不得覆盖或复制 `.env`、`.runtime`、`node_modules`、本机数据库、`~/.wechat-dashboard`、`~/.wx-cli`、飞书令牌或 Keychain 内容。完成后重装锁定依赖、重新构建、安装或核验 Skill，并运行验收命令。详细步骤以包内 `CODEX_UPGRADE.md` 为准。

## 验收基线

```bash
pnpm install --frozen-lockfile
pnpm rebuild better-sqlite3
pnpm lint
./node_modules/.bin/tsc --noEmit
pnpm build
pnpm intelligence:verify
pnpm priority:verify
pnpm keyword:verify
pnpm session:verify
pnpm security:verify
pnpm feishu:verify
pnpm skill:verify:transfer
pnpm skill:check:codex
pnpm reader:inspect
```

真实数据验收只输出匿名计数、覆盖率和标准化错误码，不把任何聊天内容写入仓库或日志。
