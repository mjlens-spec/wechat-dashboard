# WeChat Dashboard Agent Guide

## 开始前

先完整阅读：

1. `README.md`
2. `PRIVACY.md`
3. `SECURITY.md`
4. `WeChat_Dashboard_Context_Handoff_OC_0809[A].md`

当前工作树包含从 WeChat Radar 到 WeChat Dashboard 的大规模未提交改造。不要执行 `git reset --hard`、`git checkout -- .` 或其他会丢弃用户工作的命令。

## 产品不变量

- 只在 macOS 本机运行，只监听 loopback。
- 只读微信已有会话和消息，不发送、回复、撤回或修改微信数据。
- 群聊是最高优先级；私信采用尽力读取，持续无法解析时允许标记为 `unsupported`。
- 项目只在 `$wechat-dashboard` 被调用时按需启动；不得创建 Codex Automation、cron、LaunchAgent 或其他常驻调度器。
- Dashboard 页面打开时，消息增量同步约 30 分钟一次；Codex 语义分析的 30 分钟循环只能存在于仍在运行的当前任务中。页面关闭或任务结束后停止。
- Dashboard 服务不直接调用外部模型。只有 WeChat Dashboard Skill 可以把受限的当日群聊上下文带入当前 Codex 或 Claude Code 任务；禁止导出私信、完整数据库、账号目录或密钥。
- Codex 语义分析首选 Luna Max，Luna 不可用时可回退 Terra Max；Claude Code 使用当前实际模型。结果必须记录实际模型，禁止伪报。
- 群聊汇总必须逐群独立，重点关注提示必须引用同群 evidence ID 并通过导入校验。
- 敏感字段必须加密落盘，主密钥保存在 macOS Keychain。
- 按需停止只能终止项目路径、session ID 和命令行均匹配的 supervisor；不得按端口或模糊进程名批量 kill。

## 本机读取器边界

- 不运行 `wx init`，避免覆盖当前可用的 `~/.wx-cli/all_keys.json`。
- 不高频退出、重启、扫码或重新登录微信。
- 不自动重签微信，不启动 Frida，不关闭 SIP。
- 如微信升级、重装、切换账号或密钥失效，先停止同步、保护现有状态，再提出一次受控恢复方案。
- 读取器调用使用 `execFile` 与固定参数，不改为 shell 命令拼接。

## 数据与日志

- 禁止在仓库、测试、日志和文档中写入真实密码、密钥、联系人、群名、私信名、正文或账号目录。
- `.local-debug/`、`~/.wx-cli`、`~/.wechat-dashboard`、数据库、WAL、SHM、Keychain 导出物和真实截图不得进入 Git。
- 错误只记录标准化代码和匿名计数。
- 新 schema 和迁移必须保留字段加密与 `0700` / `0600` 权限。
- Skill 临时明文只能写入私有临时目录，成功导入后删除；真实浏览器截图必须保持 gitignore。

## 工程验证

修改后按风险执行：

```bash
./node_modules/.bin/eslint .
./node_modules/.bin/tsc --noEmit
./node_modules/.bin/next build
pnpm reader:inspect
```

真实读取验证只输出匿名计数、覆盖率和错误码。界面验收不得把真实聊天截图写入仓库。涉及加密、输入、API、读取器或本地敏感数据时，额外进行安全审查。

## Git

- 保留无关的现有改动。
- commit 使用 Conventional Commits。
- 推送前检查 tracked files 和 diff 中没有秘密或真实数据。
- 只推送到私人 `origin`；未经用户明确要求，不提交、不推送、不创建 PR。
