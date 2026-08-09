# WeChat Dashboard 项目 Context 与 Handoff

> 最后更新：2026-08-09（Asia/Taipei）
> 工作目录：`/Users/lensmiao/Desktop/CCworks/Wechat-Dashborad`
> 接手目标：维护以 Codex 为主、兼容 Claude Code 的按需本地 WeChat Dashboard；只有用户调用时启动，在页面和当前 Agent 任务都保持活动期间，每 30 分钟同步真实群聊并执行语义分析。Codex 首选 Luna Max、回退 Terra Max，Claude Code 使用当前实际模型。

## 0. 先读结论

核心读取、安全导入、逐群汇总、重点关注提示和按需运行链路已经打通，真实群聊监控可以工作。

- 当前活跃微信账号的 21 个数据库密钥已离线匹配并安装到 `~/.wx-cli/all_keys.json`。
- Dashboard 已固定当前活跃账号，真实模式 `configured: true`。
- 真实元数据快照包含 562 个可识别会话：群聊 307 个、私信 255 个。
- 此前匿名审计已确认真实消息会继续增量写入加密数据库；最近一次页面快照包含 349 条消息、7 个活跃群聊和 3 个活跃私信。精确数字会随本机微信变化，接手时应重新匿名回读。
- 最近 2 小时覆盖为 4 / 4；当天可读取会话覆盖为 8 / 8。另有 1 个无法解析的私信被标记为 `unsupported`，不会阻塞群聊。
- 同步策略已经改为群聊优先：群聊先补齐、失败后继续重试；私信持续失败时允许跳过。
- 消息增量读取和当前任务内的 Codex 语义循环均改为每 30 分钟一次；任意 Dashboard 页面发送的全局心跳都会在同步到期时触发本机增量读取，底层会话时间戳对账仍为每小时一次。
- `$wechat-dashboard` Skill 已安装到本机 Codex；显示名称为“微信分析启动”。桌面端可输入 `/` 后从 Skill 列表选择它；稳定的显式工程入口仍是 `$wechat-dashboard`，不依赖脱离列表选择流程的任意中文斜杠别名。
- 旧 Codex Automation `wechat-dashboard` 已删除，不再创建任何 Automation、cron 或后台语义调度。
- Dashboard 已新增“群聊汇总”和“重点关注提示”两个独立入口。群聊汇总严格按群分开，不做跨群合并。
- 总览已新增“优先群聊”工作区：群聊可星标置顶；加密优先关键词命中群名或当前统计区间消息时自动前置；定向搜索同时覆盖群名和本机区间消息。排序固定为星标、关键词命中数、消息量、最近活跃时间。
- UI 已迁移到本机 `/Users/lensmiao/Desktop/CCworks/Lens Design` 的默认 Slate & Wine 视觉语言：孔雀蓝 `#1F566B`、酒红 `#8E3B46`、金色 `#B0883E`、冷灰纸面与 2 / 6 / 12px 圆角。按用户要求，标题与正文只使用系统黑体和通用 sans-serif，不加载特殊品牌衬线字体。
- 首次真实 Luna Max 循环已成功导入 6 个不同群的 6 份汇总和 1 条重点关注提示；证据归属、解密回读和密文落盘均通过验证。
- 旧 macOS LaunchAgent `com.mjlens.wechat-dashboard` 已卸载。Dashboard 现在由 Skill 启动带双重上限的临时 production 服务：任意页面每分钟发送本机心跳，并在 30 分钟同步到期时触发本机增量读取；心跳不能复活已经过期的页面租约或 Skill 租约，失败的读取任务至少退避 30 分钟；所有页面关闭后约 3 分钟自动退出，任务结束前还会停止服务或把查看宽限缩短到 10 分钟。
- Luna Max 已完成两轮真实分析；每轮均导入 6 个不同群的独立汇总和 1 条提示。Terra Max 回退也已完成真实契约和导入验收，随后已用 Luna 结果恢复提示页面。
- 数据库内的会话名称、摘要、发送者和正文全部为 AES-256-GCM 密文，主密钥保存在 macOS Keychain。
- `dashboard.db`、WAL、SHM 与读取器缓存权限已经现场验证为仅当前用户可访问。
- ESLint、TypeScript、production build、Skill quick_validate、真实按需 start / heartbeat / stop / restart、Luna 导入和 Playwright 最终界面均已重新验收通过。
- 本轮没有重启、退出登录、重新签名或再次附加微信。
- 当前代码仍是未提交 WIP，尚未 commit / push。

此前失败的直接原因是本机存在两个微信账号数据目录，而验证脚本用 `find -quit` 误选了旧账号目录。对当前活跃目录重新校验后，立即匹配成功 21 个数据库。

## 1. 用户原始目标

把 `zjp1997720/wechat-radar` 改造成完全独立的私人项目 `WeChat Dashboard`：

1. 只运行在本机 macOS 和微信 Mac 客户端。
2. 只读本机至今已有的群聊与私信数据，不需要微信发送、回复、撤回等完整聊天功能；群聊是主要监控对象，私信为次要的尽力读取范围。
3. 用 Chrome 打开本地 Dashboard。
4. Skill 调用后才启动；页面与当前 Codex 或 Claude Code 任务都保持活动时，每 30 分钟增量更新消息并执行群聊语义分析。
5. 项目仓库保持私有，仅供公司内部同事和少数内测者使用。
6. 能迁移到个位数内测用户的 Mac，并能在 Codex / Claude Code 中继续维护。
7. Dashboard 本身不直接调用外部模型；用户明确允许 `$wechat-dashboard` Skill 把受限的当日群聊上下文带入 Codex。私信、完整数据库、账号目录和密钥不得进入模型上下文。

## 1.1 最新 Codex Intelligence 与按需运行架构

数据流固定为：

```text
微信 Mac（只读）
  → 页面打开期间 30 分钟增量同步
  → 本机 AES-256-GCM SQLite
  → Skill 导出受限的当日群聊上下文
  → Luna Max 语义分析（不可用时 Terra Max）
  → evidence ID 与 Zod 契约校验
  → 加密写回逐群汇总和重点关注提示
  → Chrome Dashboard 展示
  → 页面关闭后短租约失效，临时服务退出
```

核心实现：

- Skill 源：`skills/wechat-dashboard/`
- 本机安装：`pnpm skill:install` 会让 `~/.codex/skills/wechat-dashboard` 和 `~/.claude/skills/wechat-dashboard` 安全指向仓库内同一份 Skill；分别通过 Codex 的 `$wechat-dashboard` 和 Claude Code 的 `/wechat-dashboard` 调用。
- Bridge：`skills/wechat-dashboard/scripts/dashboard-bridge.mjs`
- 按需 supervisor：`scripts/session-service.mjs`
- 页面心跳：`components/SessionHeartbeat.tsx`、`/api/session/heartbeat`
- 数据契约：`skills/wechat-dashboard/references/analysis-contract.md`
- 规则候选：`lib/intelligence-rules.ts`
- 任务、导出、校验、加密写入：`lib/intelligence-store.ts`
- 页面：`/summaries`、`/attention`
- API：`/api/intelligence/export`、`/api/intelligence/import`、`/api/intelligence/status`、`/api/summaries`、`/api/attention`
- 遗留常驻服务清理：`scripts/install-dashboard-service.mjs --uninstall`；脚本已禁止安装新常驻服务。
- 匿名验收：`scripts/verify-intelligence.mjs`
- 群聊优先级存储与本机检索：`lib/conversation-priorities.ts`、`lib/conversation-priority-policy.mjs`
- 星标与关键词 API：`/api/priorities`
- 优先群聊 UI：`components/PriorityWorkspace.tsx`
- 优先级验收：`scripts/verify-priority-policy.mjs`、`scripts/verify-priority-workspace.mjs`

模型与回退：

- 主模型：`gpt-5.6-luna`，reasoning `max`。
- 回退：`gpt-5.6-terra`，reasoning `max`。
- 输出中的 `model` 必须写实际执行模型；禁止在 Terra 执行时标成 Luna。
- Skill 说明要求 Luna 无法执行时只重试一次 Terra Max，不改变上下文或证据规则。当前没有 Codex Automation。

安全约束：

- 只导出当天群聊；不导出私信。
- 默认最多 50 个群、每群 180 条、总计 800 条，每条正文最多 1200 字符。
- 分析任务使用随机一次性令牌，有效期 30 分钟；数据库只保存令牌 SHA-256。
- 所有 summary 和 alert 必须引用同一任务、同一群的匿名 evidence ID。
- 临时上下文和结果文件为 `0600`，成功导入后删除。
- 分析正文、决定、待办、风险、提示说明和建议动作均为 AES-256-GCM 密文。
- 语义循环只能存在于仍在运行的当前 Agent 任务；任务结束后不会继续调用模型。
- 活跃监控使用 35 分钟 Skill 租约覆盖下一次 30 分钟循环；页面心跳只在这个上限内滚动续到约 3 分钟。关闭所有页面后 supervisor 自动停止 Next 服务。
- `stop` 在发信号前核验项目路径、session ID、supervisor PID 和实际命令行，禁止按端口模糊终止进程。

## 2. 最新风险边界与用户授权

用户的最新边界如下：

- 用户明确授权修改本机微信签名并加入 `com.apple.security.get-task-allow`。
- 用户理解同一用户下的调试工具可以附加微信，直到微信升级或重装。
- 用户允许必要时在本地处理账号目录、联系人、聊天正文和数据库密钥。
- 用户修正了此前“完全不能重启”的表述：允许少量、低频的微信退出和重启尝试。
- 严禁高频反复退出、登录或扫码验证；这可能触发账号风控或封禁。
- 优先使用已捕获的密钥和离线数据库验证。只有确有必要时，才做一次受控的微信重启或动态附加。
- 当前 handoff 未固化本机密码。下一位 agent 如遇系统授权，可在当次系统提示中使用用户已提供的本机凭据。

重要：目前没有必要再次附加微信。21 个密钥已经工作，除非微信升级、重装、切换账号或数据库密钥轮换。

## 3. 机器与微信现状

### 3.1 系统

- macOS：26.6（Build 25G72）
- 架构：Apple Silicon `arm64`
- Node.js：v26.5.0
- pnpm：11.16.0
- SIP：启用

### 3.2 微信

- 应用：`/Applications/WeChat.app`
- Bundle ID：`com.tencent.xinWeChat`
- 版本：4.1.11
- Build：269136
- 当前状态：微信正常运行；没有残留 Frida 进程。

当前签名状态已现场回读：

```text
Identifier=com.tencent.xinWeChat
Signature=adhoc
TeamIdentifier=not set
com.apple.security.get-task-allow=true
```

影响：

- 微信升级或重装会恢复官方签名，并移除当前 entitlement。
- ad-hoc 签名可能影响微信自更新或风控判断，不要无必要重复签名。
- 本轮没有关闭 SIP。
- 此前已启用调试相关系统能力；当前 `DevToolsSecurity -status` 在本运行环境里无法稳定回读，不应把该命令的结果当作唯一依据。

## 4. GitHub 与 Git 状态

### 4.1 私有独立仓库

- 私有仓库：<https://github.com/mjlens-spec/wechat-dashboard>
- `isPrivate: true`
- `isFork: false`
- 默认分支：`main`

远程配置：

```text
origin       https://github.com/mjlens-spec/wechat-dashboard.git
legacy-fork  https://github.com/mjlens-spec/wechat-radar.git
upstream     https://github.com/zjp1997720/wechat-radar.git
```

当前基线：

```text
de7ec99 Publish updated WeChat Radar
8abb29e Initial open source release
```

`origin/main` 仍停在 `de7ec99`。本轮改造尚未提交或推送。

### 4.2 当前工作树

当前是一次大规模未提交改造：旧 Radar 的 AI 分类、话题、链接解析、全文检索、群详情等页面和 API 已移除，只保留 Dashboard 所需入口。

保留的 App 路由：

```text
/
/setup
/api/dashboard
/api/setup
/api/sync
```

不要丢弃工作树，也不要执行 `git reset --hard` 或 `git checkout -- .`。

## 5. 两个微信账号目录：本轮最关键的根因

本机存在两个数据库根目录：

```text
/Users/lensmiao/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/shuyi145700_af78/db_storage
/Users/lensmiao/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/Lens_miao_7ddf/db_storage
```

当前活跃账号是：

```text
/Users/lensmiao/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/Lens_miao_7ddf/db_storage
```

判定依据：该目录下 `session.db` 和 `session.db-wal` 的修改时间是当前时间；另一个目录停留在旧时间。

此前所有 0 命中的离线校验，都错误地使用了第一个旧目录：

```zsh
find ... -path '*/db_storage/session/session.db' -print -quit
```

不要再用未排序的 `-print -quit` 选择账号。应明确指定当前目录，或按 `session.db-wal` 的最近修改时间选择。

## 6. 真实读取器现状

### 6.1 当前依赖

项目固定使用：

```json
"@jackwener/wx-cli": "0.3.0"
```

本地可执行文件：

```text
/Users/lensmiao/Desktop/CCworks/Wechat-Dashborad/node_modules/.bin/wx
```

运行目录：

```text
/Users/lensmiao/.wx-cli
```

权限已验证：

- Dashboard 数据根目录固定为 `~/.wechat-dashboard`，不接受运行时环境变量重定向；应用在打开配置和数据库前拒绝符号链接、异常文件类型及非当前用户所有的路径。

```text
drwx------ ~/.wx-cli
-rw------- ~/.wx-cli/all_keys.json
-rw------- ~/.wx-cli/config.json
```

### 6.2 已安装密钥映射

`~/.wx-cli/all_keys.json` 当前有 21 个已验证数据库映射，包括：

```text
bizchat/bizchat.db
contact/contact.db
contact/contact_fts.db
emoticon/emoticon.db
favorite/favorite.db
favorite/favorite_fts.db
general/general.db
hardlink/hardlink.db
head_image/head_image.db
message/biz_message_0.db
message/biz_message_1.db
message/media_0.db
message/media_1.db
message/message_0.db
message/message_1.db
message/message_2.db
message/message_fts.db
message/weclaw.db
session/session.db
sns/sns.db
solitaire/solitaire.db
```

密钥值未写入本 Markdown。接手 agent 可在本机读取受限文件，但严禁把它们提交到 Git。

重要：不要再运行 `wx init`。当前版本的静态扫描会得到 0 个密钥，并可能覆盖已经可用的 `all_keys.json`。

### 6.3 已完成的真实验证

会话验证命令：

```zsh
node scripts/reader/verify-sessions.mjs node_modules/.bin/wx
```

现场结果：

```json
{"total":1000,"groups":307,"private":255,"newest_timestamp":1786252344}
```

说明：`1000` 是验证脚本传给 CLI 的上限，不一定是全部会话总数。

消息验证命令：

```zsh
node scripts/reader/verify-history.mjs node_modules/.bin/wx
```

现场结果：

```json
{"conversation_type":"group","message_count":100,"newest_timestamp":1786251996}
```

验证脚本不会打印会话名称、用户名或消息正文。

Dashboard 最新现场结果（只记录匿名计数）：

```json
{
  "configured": true,
  "demoMode": false,
  "wxInstalled": true,
  "wxReaderReady": true,
  "wxDaemonRunning": true,
  "readerCachePrivate": true,
  "totalConversations": 562,
  "totalGroups": 307,
  "totalPrivate": 255,
  "encryptedMessagesAtInitialAcceptance": 313,
  "encryptedMessagesAtFinalAudit": 327,
  "activeGroups": 7,
  "activePrivate": 2,
  "recentCoverage": "4/4",
  "todayCoverage": "8/8",
  "unsupportedPrivate": 1,
  "autoSyncMinutes": 30
}
```

真实增量 run 5 完成：`status=ok`、失败会话 0、读取并新增 205 条。紧接着执行 run 6 验证增量游标与去重：读取 0 条、新增 0 条、失败 0。

SQLite 最终匿名审计结果：562 / 562 个会话名称为合法密文，327 / 327 条消息正文和发送者为合法密文，非法密文计数为 0；数据库、WAL、SHM 权限均为 `0600`。

## 7. 密钥提取研究记录

### 7.1 失败的静态扫描

`@jackwener/wx-cli` 0.3.0 的静态方案扫描如下字符串：

```text
x'<64 hex key><32 hex salt>'
```

在微信 4.1.11 上：

- 非 root `wx init`：`task_for_pid` 失败。
- 完成 ad-hoc 重签后以高权限运行：拿到 task port，但候选密钥为 0。
- `wx sessions` 随后报无法解密 `session.db`。

这与微信 4.1.10 起不再常驻旧 key string 的公开研究一致。

### 7.2 评估但未采用的方案

`pandorafuture/wx-cli` v0.7.4：

- 官方 release SHA 做过校验。
- 文档只明确支持微信 4.1.7 / 4.1.8。
- 要求关闭 SIP。
- 本轮拒绝采用，保留 SIP 启用。

### 7.3 Frida 路径

参考实现：

- <https://github.com/huangserva/wechat-radar>
- <https://github.com/Evanyuan-builder/wechat-4.1.10-macos-key>
- <https://github.com/ydotdog/wechat-export-macos/issues/5>

临时环境：

```text
/private/tmp/wechat-dashboard-frida-venv
Frida 17.17.0
PyCryptodome 3.23.0
```

初始 huangserva hook 支持：

- `sqlite3_key`
- `sqlite3_key_v2`
- `CCKeyDerivationPBKDF`

为适配 4.1.11，本轮做了两处实验改动：

1. 去掉 PBKDF2 `rounds > 1000` 限制，保留 2 轮 HMAC key derivation。
2. 增加 `CCCrypt`、`CCCryptorCreate`、`CCCryptorCreateWithMode` 的 32 字节 AES key 捕获。

仅启动微信、不打开会话时抓不到数据库链路。打开会话并向上翻页后，抓到：

- 1 个 `pbkdf_password_r256000`
- 30 个 `pbkdf_derived_r256000`
- 30 个 `pbkdf_password_r2`
- 30 个 `pbkdf_derived_r2`
- `wechat.dylib` 的 AES-CBC 加解密调用

集合关系已验证：

- 30 个 256000 轮派生结果与 30 个 2 轮 PBKDF 输入完全一致。
- 30 个 AES 解密 key 全部来自 256000 轮派生结果。

对旧账号目录校验为 0；对当前活跃目录校验立即得到：

```text
[match] resolved 21 DB(s) from 61 candidate key(s)
```

因此 4.1.11 的提取链路是有效的，真正的故障是账号目录选择错误。

## 8. 本地调试资产

项目根目录内有一个已加入 `.gitignore` 的受限目录：

```text
.local-debug/
```

目录权限 `0700`，文件权限 `0600`。当前包含：

```text
.local-debug/wechat-4.1.11-candidates.json
.local-debug/wechat-4.1.11-candidates-Lens_miao_7ddf.json
.local-debug/wechat-key-hook-4.1.11.js
.local-debug/frida_extract.py
.local-debug/match_keys.py
.local-debug/verify_cccrypt.py
.local-debug/match_pbkdf.py
.local-debug/all_keys.before-4.1.11.json
```

说明：

- `wechat-4.1.11-candidates.json` 是原始捕获。
- `wechat-4.1.11-candidates-Lens_miao_7ddf.json` 已写入 21 个数据库映射，同时仍保留候选桶。
- `all_keys.before-4.1.11.json` 是安装前的空 key map 备份。
- `scripts/reader/install-key-map.mjs` 会删除 `_candidate_keys` 后，再以 `0600` 原子写入 `~/.wx-cli/all_keys.json`。
- `.local-debug/` 不得提交或上传。

## 9. 微信进程实验的副作用

需要让接手 agent 知道以下现象：

- Frida `--spawn` 能装载 hook，但早期实验没有触发 DB 页面读取，所以为 0。
- 动态附加后打开会话、向上翻页，才能触发 PBKDF2 和 AES 链路。
- 多次 Frida session detach 后，微信主进程会退出；必须手动 `open -a WeChat` 恢复。
- 这也是用户要求避免高频重启的直接原因。
- 当前微信已经恢复正常运行，没有残留 Frida。
- 后续不需要再次动态捕获，除非密钥因微信升级或账号切换失效。

如果未来确实要重新捕获：

1. 先确认当前 `all_keys.json` 已备份。
2. 一次受控操作完成，不循环重试。
3. 明确选择当前活跃账号目录。
4. 捕获完成后只重启 `wx-cli daemon`，不要无必要重启微信。
5. 验证成功后立即停止 Frida，并确认微信正常运行。

## 10. Dashboard 代码改造现状

### 10.1 已完成

- 包名改为 `wechat-dashboard`。
- `dev` / `start` 只监听 `127.0.0.1`。
- 依赖固定 `@jackwener/wx-cli` 0.3.0。
- 新数据目录：`~/.wechat-dashboard`。
- 新数据库：`~/.wechat-dashboard/dashboard.db`。
- 新表：
  - `conversations`
  - `messages`
  - `sync_state`
  - `sync_runs`
  - `sync_lock`
  - `app_state`
  - `analysis_jobs`
  - `analysis_job_evidence`
  - `group_summaries`
  - `attention_alerts`
- 会话类型同时支持 `group` 和 `private`。
- 会话名称、摘要、发送者和正文采用 AES-256-GCM 字段级加密；主密钥自动保存在 macOS Keychain。
- 当前 schema 使用稳定消息指纹兼容 `wx new-messages` 缺少 `local_id` 的情况，并允许后续历史记录补回 `local_id`。
- 首次同步拆为元数据、最近 2 小时、当天分批三个阶段；任务在后台运行并持久化进度。
- 同步排序为群聊优先。无法解析的群聊保留为失败并重试；无法解析的私信标记为 `unsupported`。
- Dashboard 固定首次配置时的活跃账号，检测到账号目录变化后停止同步。
- Dashboard 提供：
  - 消息量
  - 活跃群聊
  - 活跃私信
  - 数据新鲜度
  - 群聊 / 私信趋势
  - 近期会话列表
  - 按群独立的当天汇总
  - 重点关注提示及“已处理 / 已忽略”状态
- 浏览器页面打开期间每 30 分钟调用一次最新同步；当前 Codex 或 Claude Code 任务在持续监控模式下同周期执行语义分析。
- 提供手动“立即刷新”和“继续补齐今天”。
- Skill 使用 Luna Max；无法执行时允许一次 Terra Max 回退。
- Skill bridge 按需启动 production Dashboard；页面心跳续租，关闭页面后临时服务自动退出。旧 LaunchAgent 安装路径已禁用。
- 旧 Radar 的 AI 分类、话题生成、链接联网解析、全文搜索、群详情等接口和页面已删除。
- `proxy.ts` 限制非 loopback 请求，并阻止跨源写操作。
- `wx-cli` 的 JSON 包装已经兼容：`data` / `sessions` / `messages` / `items`。
- 新增匿名 reader 验证脚本。
- 新增读取器二进制 SHA-256 检查与权限加固脚本。
- 已删除旧的明文 demo seed 和群聊回填脚本。

### 10.2 已验证

```text
node_modules/.bin/eslint .       PASS
node_modules/.bin/tsc --noEmit  PASS
node_modules/.bin/next build    PASS（需要沙箱外运行，Turbopack 会绑定临时本地端口）
真实 bootstrap / latest         PASS
连续 latest 去重验证             PASS（第二次 0 seen / 0 inserted）
SQLite 密文与文件权限审计         PASS
Skill 官方 quick_validate         PASS
两轮 Luna Max 真实循环             PASS（每轮 6 个独立群汇总 / 1 条提示）
逐群分离、证据、解密与密文审计      PASS
旧 LaunchAgent 卸载                 PASS
Terra Max 真实回退与空结果导入       PASS
按需 start / 页面 heartbeat / stop   PASS
任务硬上限自然到期与自动清理          PASS（页面持续心跳时仍按 Skill 上限停止；端口、lease、state 均清理）
最终 Luna scheduled 循环             PASS（6 个独立群汇总 / 1 条提示）
Playwright 页面与控制台             PASS（0 errors / 0 warnings）
私有路径与符号链接拒绝测试          PASS（根目录、DB、WAL/SHM、备份 staging）
真实加密数据库备份                  PASS（普通文件、当前 UID、0600、无 staging 遗留）
最终代码审查与安全审查              APPROVE（Critical / High / Medium / Low 均为 0）
```

生产构建最终路由：

```text
/
/_not-found
/api/dashboard
/api/attention
/api/intelligence/export
/api/intelligence/import
/api/intelligence/status
/api/session/heartbeat
/api/setup
/api/summaries
/api/sync
/attention
/setup
/summaries
Proxy (Middleware)
```

### 10.3 尚未完成

1. 7 天和 30 天历史回填尚未开放；当前安全范围为最近 2 小时、当天分批和 30 分钟增量。
2. 其他内测 Mac 的读取器初始化和按需 production build 仍需逐机验证；Codex / Claude Code 的 Skill 符号链接已收敛为 `pnpm skill:install`，脚本会拒绝覆盖同名真实目录或其他链接。
3. `@ 我` 依赖使用者在 `/setup` 填写自己的群聊昵称或别名；当前机器如未填写，则系统会主动禁止生成 mention 提示。
4. 按需启动、页面心跳、显式停止、重新启动、双重租约及任务硬上限自然到期都已真实验收：常规查看使用 10 分钟 Skill 上限，页面滚动窗口为 180 秒；真实 2 分钟上限测试中，即使页面持续心跳，端口、lease 和 state 也会按期自动清理。
5. 代码尚未 commit / push。

## 11. 首次同步性能风险：已解决

此前空库会对 562 个会话直接读取长历史的风险已经消除。当前约束如下：

1. 先导入会话元数据，不对所有会话读取历史。
2. 最近 2 小时阶段最多处理 25 个活跃会话、5000 条消息、90 秒，并发为 2。
3. 当天回填每次最多处理 20 个会话，使用分页 offset 保存进度。
4. 所有候选队列按“未完成分页、群聊优先、最近活跃”排序。
5. 后台任务使用 `sync_lock` 保证单实例，API 立即返回 `run_id`，浏览器轮询持久化进度。
6. 增量使用 `wx new-messages`；每小时用会话时间戳对账，再继续当天回填。
7. 每次消息写入使用稳定指纹去重；连续两次增量实测第二次没有重复写入。
8. 私信的不可解析错误不会再使整个任务变成 partial；群聊错误仍会进入后续重试。

真实 bootstrap 已完成，当前可以安全打开首页。不要把 7 天或 30 天全量扫描重新塞回首次启动流程。

## 12. 推荐接手顺序

### P0：保持当前真实读取链路

```zsh
cd /Users/lensmiao/Desktop/CCworks/Wechat-Dashborad
pnpm privacy:harden
pnpm reader:inspect
```

不要运行 `wx init`，不要覆盖 `~/.wx-cli/all_keys.json`，不要为普通 Dashboard 开发重启或重新签名微信。

### P1：按需会话与 30 分钟智能循环稳定性

- 验证调用前端口未监听、调用后按需启动、页面心跳为 active、显式 stop 后端口关闭。
- 验证关闭所有 Dashboard 页面后约 3 分钟租约失效，服务自动退出。
- 持续监控只能在当前 Agent 任务内运行；不要创建 Automation 作为替代。
- 继续只记录匿名计数、模型名、任务状态和错误码，不把真实正文写入日志。

### P2：历史范围

- 在现有 offset、锁和进度基础上开放可取消的 7 天回填。
- 先设全局消息、时间、会话上限，再考虑 30 天历史。
- 群聊继续优先，私信不能成为完成条件。

### P3：内测迁移

- 在第二台 Mac 上从干净 clone 验证依赖、Keychain、权限和账号固定。
- 为每台机器独立准备读取器，不复制当前用户的密钥和数据库。
- 记录微信版本兼容性和读取器二进制 SHA-256。
- 验证失败时输出匿名错误码，不收集真实聊天样本。

### P4：审查、提交与推送

- 做最终代码 review、隐私 review 和 tracked-file 扫描。
- 确认 `.local-debug/`、密钥、密码、真实聊天数据、账号目录和数据库没有进入 Git。
- 使用 Conventional Commit，例如 `feat: rebuild as local WeChat dashboard`。
- 只推送到私有 `origin`；提交和推送仍需用户明确要求。

## 13. 相关公开资料

- 原项目：<https://github.com/zjp1997720/wechat-radar>
- `wx-cli`：<https://github.com/jackwener/wx-cli>
- WCDB：<https://github.com/Tencent/wcdb>
- Frida fallback 参考：<https://github.com/huangserva/wechat-radar>
- 微信 4.1.10 CommonCrypto 研究：<https://github.com/Evanyuan-builder/wechat-4.1.10-macos-key>
- 4.1.10 静态扫描失效 issue：<https://github.com/ydotdog/wechat-export-macos/issues/5>

注意许可证：`.local-debug/` 中有研究参考脚本的本地副本，仅用于本机调试并已 gitignore。若要把任何上游脚本正式提交到私有仓库，也应先核对许可证、保留 attribution，并做独立安全审查。

## 14. 给下一位 agent 的建议开场 Prompt

```text
请先完整阅读项目根目录的 WeChat_Dashboard_Context_Handoff_OC_0809[A].md。

当前真实 reader 和安全首次导入已经打通：~/.wx-cli/all_keys.json 有 21 个已验证映射，Dashboard 已固定当前活跃账号，562 个会话元数据和真实消息已经以字段级密文写入本机数据库。不要运行 wx init，也不要高频重启或登录微信。

当前版本已经完成 Codex Skill、30 分钟配置、Luna Max 多轮真实分析、Terra Max 回退验收、逐群汇总、重点关注提示、加密导入和按需临时服务。旧 Codex Automation 已删除，旧 LaunchAgent 已卸载并禁止重新安装。按需 start、任意页面 heartbeat、显式 stop、restart 和当前 Luna scheduled 循环均已真实通过；活跃任务使用 35 分钟 Skill 上限，页面心跳在该上限内滚动 3 分钟短租约，并只在 30 分钟到期时触发本机同步。过期租约不会被心跳复活，失败读取采用 30 分钟退避；任务结束前停止或缩短到 10 分钟。私有根目录、DB/WAL/SHM、日志、租约和备份 staging 均拒绝符号链接或异常所有者，最终代码审查和安全审查已经批准。不要扩大私信范围，不要运行 wx init，不要重启或重签微信，不把 .local-debug、密钥、密码、账号目录、临时上下文或真实截图提交到 Git。完成修改后运行 ESLint、TypeScript、production build、Skill quick_validate、session:verify、security:verify、intelligence:verify 和真实浏览器验收。
```

## 15. 最终状态清单

| 项目 | 状态 |
|---|---|
| 私有独立 GitHub 仓库 | 已完成 |
| 微信 4.1.11 调试 entitlement | 已完成 |
| SIP 保持启用 | 已确认 |
| 当前活跃账号目录识别 | 已完成 |
| 21 个数据库密钥匹配 | 已完成 |
| `wx sessions` 真实读取 | 已完成 |
| `wx history` 真实读取 | 已完成 |
| Dashboard 只监听 loopback | 已完成 |
| 旧 AI / 搜索 / 链接功能移除 | 已完成，未提交 |
| ESLint / TypeScript / production build | 已通过 |
| 安全分阶段 bootstrap | 已完成并真实验证 |
| 首次真实 Dashboard 数据导入 | 已完成；消息计数需接手时重新匿名回读 |
| 群聊优先与私信 unsupported 策略 | 已完成并真实验证 |
| 30 分钟增量逻辑 | 已更新并通过真实周期入口验收 |
| 30 分钟 Codex 语义分析 | 当前任务内运行；无 Automation |
| Luna Max 主分析 | 已完成；两轮真实循环通过 |
| Terra Max 回退 | 已完成真实契约与导入验收 |
| 逐群汇总 | 已完成；6 条汇总对应 6 个不同群 |
| 重点关注提示 | 已完成；真实导入 1 条 |
| evidence ID 与结构校验 | 已完成并真实验证 |
| LaunchAgent 后台常驻 | 已卸载；安装入口已禁用 |
| 按需服务与双重租约 | start / heartbeat / stop / restart、600 / 180 秒上限回读及真实硬上限自然到期清理均通过 |
| 连续增量去重 | 已完成，第二次 0 / 0 |
| Keychain 字段加密与文件权限 | 已完成并现场审计；私有路径与备份 staging 安全测试通过 |
| Chrome 真实界面验收 | 已打开并验证本地 API |
| README / PRIVACY / SECURITY / 迁移文档 | 已完成 |
| AGENTS.md / CLAUDE.md | 已完成 |
| lockfile 清理 | 已完成，frozen offline 校验通过 |
| 群聊监控规则层 | 已完成，作为语义模型的候选信号层 |
| commit / push | 未完成 |
