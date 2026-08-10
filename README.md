# WeChat × Feishu Dashboard

WeChat × Feishu Dashboard 是一个面向 Codex 的 macOS 本机双端会话分析看板。微信从已登录的 Mac 客户端只读同步；飞书完成一次用户认证后，通过 `lark-cli --as user` 读取群聊与私信。Terra High 对受限的今日会话上下文做语义分析，再把逐会话汇总、重点关注提示和潜在商机加密写回本机。

当前版本已经接入微信与飞书真实数据。两端群聊保持最高优先级；私信同步与语义分析分别受本机设置控制。项目不提供发送、回复、撤回、加好友或修改联系人等写操作。

## 运行方式

项目采用“调用才启动”的会话模式：

- 不创建 Codex Automation、cron 或 macOS LaunchAgent。
- 调用 Skill 时启动只监听 `127.0.0.1` 的临时 production 服务。
- 任意 Dashboard 页面打开时，本机页面心跳会在同步到期后触发新增消息读取；频率约为每 30 分钟一次，每小时做一次时间戳对账。
- 页面每分钟向本机服务发送一次心跳，但只能续到当前 Skill 租约上限。所有页面关闭后，临时服务约 3 分钟内自动退出；当前 Agent 任务结束时会停止服务或把查看宽限缩短到 10 分钟。
- 模型语义分析只存在于当前仍在运行、且可使用 Terra High 的 Codex 任务中。任务结束后不会继续后台分析。
- 再次使用时重新调用 Skill；也可以显式运行 `pnpm session:stop`。

这意味着本地页面服务和 AI 分析是两个边界：Chrome 页面负责维持临时本机监听和消息增量刷新；当前 Agent 任务负责语义分析。没有常驻调度器时，任务结束后无法继续每 30 分钟调用模型。

## 当前能力

- 微信读取本机会话元数据；飞书通过用户认证读取会话，统一区分平台、群聊与私信。
- 首次同步先建立元数据快照，再分批补齐最近 2 小时和当天消息。
- 页面打开期间每 30 分钟增量同步；提供“立即刷新”和“继续补齐今天”。
- 展示消息量、活跃群聊、活跃私信、趋势、近期会话和同步覆盖率。
- 总览提供“优先群聊”工作区：群聊可手动星标置顶；优先关键词命中群名或当前统计区间消息时自动前置；搜索可以同时检索群名和本机已同步的区间消息。
- 优先级顺序固定为“星标置顶 → 关键词命中数 → 当前区间消息量 → 最近活跃时间”。关键词使用 AES-256-GCM 加密保存，搜索与排序只在本机完成。
- `/summaries` 按微信、飞书分区，为每个会话生成独立卡片。
- `/attention` 左侧微信、右侧飞书，覆盖重要 @ 我、客户情绪、紧急事项、久未回复、冲突和久无方案六类情况。
- `/opportunities` 展示新需求、预算、合作、增购、转介绍和续约等潜在商机。
- 语义分析只接受 Terra High（`gpt-5.6-terra` + reasoning `high`）。
- 所有结构化结论必须引用同一任务、同一会话的 evidence ID，导入时强制校验。
- 聊天正文、会话名称、摘要、发送者、群聊汇总和提示正文使用 AES-256-GCM 加密；主密钥保存在 macOS Keychain。
- UI 采用本机 Lens Design 的 Slate & Wine 视觉语言：孔雀蓝、酒红、金色和冷灰纸面，使用克制圆角、细描边与轻量阴影；字体只使用 macOS 系统黑体和通用 sans-serif，不依赖特殊品牌字体。

## 明确边界

Dashboard 和 Skill 不会执行以下动作：

- 运行 `wx init`；
- 修改微信签名；
- 启动 Frida 或附加微信进程；
- 退出、重启或重新登录微信；
- 未经对应平台设置明确开启时导出私信给模型；
- 上传完整数据库、数据库密钥或账号目录；
- 安装任何常驻 Dashboard 服务或定时 AI 任务。

已有可用密钥映射时不要再次运行 `wx init`，避免覆盖当前状态。读取器初始化和密钥恢复属于单独的、低频受控维护工作。

## 运行条件

- macOS；当前实测环境为 Apple Silicon 和微信 Mac 版 4.1.11。
- 源码开发要求 Node.js 20.9 或更高版本、pnpm 11.16.0；完整移交包可以自行准备并校验项目专用 Node.js 22.23.1 与 pnpm，无需接收方预装。
- 项目内锁定飞书官方 `@larksuite/cli` 1.0.84；凭证由 CLI 与 macOS Keychain 管理。
- 已配置并可读取当前账号的 `wx` 读取器。
- `wx daemon` 正在运行，且 `~/.wx-cli` 只允许当前用户访问。
- 本机 Codex 可调用 Terra High。ChatGPT Pro 可提供 Codex 使用资格，但项目仍会单独检查宿主是否实际支持 `gpt-5.6-terra`。

## 安装

```bash
git clone https://github.com/mjlens-spec/wechat-dashboard.git
cd wechat-dashboard
pnpm install --frozen-lockfile
pnpm rebuild better-sqlite3
pnpm privacy:harden
pnpm reader:inspect
pnpm build
```

把仓库内 Skill 安装到当前用户的 Codex：

```bash
pnpm skill:install:codex
pnpm skill:check:codex
```

安装脚本只创建指向当前仓库 `skills/wechat-dashboard` 的符号链接；如果目标位置已有同名真实目录或指向其他位置的链接，它会拒绝覆盖。Codex 安装位置为 `~/.codex/skills/wechat-dashboard`，调用 `$wechat-dashboard`；Skill 的显示名称为“微信分析启动”，桌面端也可以输入 `/` 后从 Skill 列表选择。Skill 通过自己的运行入口寻找系统 Node.js 或移交包准备的项目专用 Node.js，因此后续调用不依赖终端的临时 PATH。工程不依赖脱离列表选择流程的任意 `/微信分析启动` 文本别名。

每次调用 Skill 时都会先启动临时本机服务，并自动在内置浏览器或 Google Chrome 中打开 Dashboard；明确要求“停止”时例外。单轮分析完成后页面最多保留 10 分钟，关闭页面后临时服务仍会按短租约自动退出。

首次使用会打开 `/setup`，检查读取器、daemon、缓存权限和当前活跃账号，并把该账号固定为本 Dashboard 的数据源。

## 按需会话命令

```bash
# 启动临时服务，默认给 10 分钟打开页面的宽限期
pnpm session:start

# 查看服务、页面心跳和最近分析任务
pnpm session:status

# 只终止经项目路径和 session ID 验证的本项目临时服务
pnpm session:stop
```

开发界面时可显式使用 `pnpm dev`。开发服务器不受按需租约管理，需要开发者自行停止。

## 同步机制

首次进入真实数据模式时：

1. 导入所有可识别的会话元数据，不读取大段历史正文。
2. 优先同步最近 2 小时内活跃的群聊，再处理可读取的私信。
3. 当天消息按小批次补齐，每批最多处理 20 个会话。
4. 任意 Dashboard 页面打开时，全局页面心跳会在 30 分钟同步到期后调用一次增量读取；停留在总览、群聊汇总或重点关注提示页面均有效。
5. 每小时用会话时间戳对账，补抓读取器增量状态可能遗漏的会话。

同步任务在服务端后台运行，数据库保存单实例锁、进度和错误码。群聊解析失败会进入后续重试；无法解析且没有可用名称的私信会标记为 `unsupported`。

## Codex 智能分析

默认 `scheduled` 单轮流程：

1. 启动本机临时 Dashboard，自动在内置浏览器或 Google Chrome 中打开页面，并增量同步消息。
2. 从当天双端会话导出有界上下文：最多 80 个会话、每会话 160 条、总计 800 条，每条正文最多 1200 字符；私信必须显式开启。
3. Skill 优先创建隔离的 `gpt-5.6-terra`、reasoning `high` 执行单元，按会话独立生成当天汇总、重点关注提示和潜在商机；宿主无法提供该组合时停止语义导入。
4. 每条结论引用匿名 evidence ID；导入时验证 evidence ID 属于同一任务和同一会话。
5. 结果继续加密落盘；临时上下文和结果文件在成功导入后删除。

用户明确要求“持续监控”时，Skill 可以让当前支持 Terra High 的 Codex 任务保持活动，并使用 35 分钟任务租约覆盖下一次 30 分钟循环。每轮前必须确认临时监听仍可达且 Chrome 页面仍有心跳；页面关闭后停止，不自动重启。这个循环不会跨越当前 Agent 任务，也不会创建定时 Automation。任务结束前必须停止服务，或把仅用于查看的宽限缩短到 10 分钟。

手动桥接命令：

```bash
zsh skills/wechat-dashboard/scripts/run-bridge.zsh prepare --mode summaries
zsh skills/wechat-dashboard/scripts/run-bridge.zsh prepare --mode alerts
zsh skills/wechat-dashboard/scripts/run-bridge.zsh prepare --mode opportunities
```

桥接脚本拒绝非 loopback URL。

## 本地数据与安全

```text
~/.wechat-dashboard/config.json
~/.wechat-dashboard/dashboard.db
~/.wechat-dashboard/backups/
~/.wechat-dashboard/logs/
~/.wechat-dashboard/session-lease.json    # 临时存在
~/.wechat-dashboard/session-service.json  # 临时存在
~/.wx-cli/
```

Dashboard 数据根目录固定为当前用户的 `~/.wechat-dashboard`，不接受运行时重定向。目录权限基线为 `0700`；配置、数据库、WAL、SHM、备份、租约、状态和读取器缓存文件为 `0600`。应用会拒绝数据根目录、配置或数据库上的符号链接、异常文件类型和非当前用户所有的路径。可重新执行 `pnpm privacy:harden`。完整边界见 [PRIVACY.md](PRIVACY.md) 和 [SECURITY.md](SECURITY.md)。

## 迁移到另一台 Mac

代码可迁移到少量内测用户的 Mac，但读取器、账号和密钥必须逐机独立准备：

1. 使用完整移交 ZIP 时双击 `INSTALL.command`；它会自检 macOS 架构和现有 Node.js，必要时下载并校验项目专用 Node.js 22.23.1，再安装锁定依赖。首次安装需要能访问 nodejs.org 与 npm 官方软件源。
2. 在该 Mac 上准备匹配当前微信版本和当前账号的 `wx` 环境。
3. 不复制其他用户的 `all_keys.json`、Keychain 主密钥或 Dashboard 数据库。
4. 运行 `pnpm privacy:harden`、`pnpm reader:inspect` 和 `pnpm build`。
5. 安装脚本先在临时目录验证 Skill 安装，再把同一份 Skill 安全链接到 Codex 用户 Skill 目录。
6. 在 Codex 调用 `$wechat-dashboard`，再到 `/setup` 验证本机读取器、飞书用户授权和账号。若当前 Codex 环境不能提供 Terra High，本机页面与同步仍可使用，语义结果不会导入。
7. 先完成安全 bootstrap，再逐批扩展当天覆盖。

不需要安装 LaunchAgent，也不需要创建 Codex Automation。微信升级、重装或切换账号后，可能需要重新做一次低频、受控的本机读取器验证。

生成脱敏的完整项目移交包时，先提交当前代码，再运行：

```bash
pnpm package:transfer
```

脚本只接受干净的 Git 工作树，只打包已跟踪源码，并自动生成安装说明、双端接入说明、检查脚本、包内 `SHA256SUMS.txt` 和 ZIP 外部校验文件。输出位于 `.release/`；本机数据库、密钥、日志、构建缓存、项目 Handoff、UI mockup 和历史 ZIP 不会进入包内。完整移交边界见 [TRANSFER.md](TRANSFER.md)。

## 验证

```bash
./node_modules/.bin/eslint .
./node_modules/.bin/tsc --noEmit
pnpm build
node scripts/verify-intelligence.mjs
pnpm priority:verify
pnpm priority:verify:live
pnpm session:verify
pnpm security:verify
pnpm feishu:verify
pnpm skill:verify:transfer
pnpm skill:check:codex
pnpm reader:inspect
```

## 常见问题

| 现象 | 处理方式 |
| --- | --- |
| 页面进入 `/setup` | 检查读取器、daemon、缓存权限和活跃账号。 |
| `wxReaderReady` 为 false | 保护现有 `~/.wx-cli/all_keys.json`，不要直接运行 `wx init`；按 handoff 检查账号目录和密钥映射。 |
| Dashboard 提示账号变化 | 停止同步，确认微信当前登录账号；需要切换时重新进入 `/setup`。 |
| 个别私信没有正文 | 可以跳过，不影响群聊。 |
| Skill 报 `PRODUCTION_BUILD_MISSING` | 在项目目录运行 `pnpm build` 后重试。 |
| Skill 报 `DASHBOARD_VIEWER_CLOSED` | 页面已关闭，监控按设计停止；重新调用 Skill 即可。 |
| 没有“@ 我的信息” | 在 `/setup` 填写本人在工作群使用的昵称或别名。 |
| `better-sqlite3` 无法加载 | 运行 `pnpm rebuild better-sqlite3`。 |
| Skill 报 `NODE_RUNTIME_MISSING` | 回到移交包双击 `INSTALL.command`，补齐项目专用运行环境。 |
| Skill 报 `TERRA_HIGH_UNAVAILABLE` | 当前 Codex 没有确认可用的 Terra High；本机同步和页面可继续使用，语义导入保持停止。 |

## 项目协作

接手开发前阅读 [AGENTS.md](AGENTS.md)、[CLAUDE.md](CLAUDE.md) 和 [TRANSFER.md](TRANSFER.md)；本机存在项目 Context / Handoff 时再补充阅读。真实聊天数据、数据库、Keychain 密钥、`~/.wx-cli`、`.local-debug/`、日志和真实截图不得提交到 Git。未经用户要求，不提交、不推送、不创建 PR。

## 上游与致谢

本项目从 [zjp1997720/wechat-radar](https://github.com/zjp1997720/wechat-radar) 的思路演化而来，当前已重构为独立的本地 Dashboard。读取能力依赖 [jackwener/wx-cli](https://github.com/jackwener/wx-cli)。界面与本地服务使用 Next.js、React、ECharts 和 better-sqlite3。

## License

MIT
