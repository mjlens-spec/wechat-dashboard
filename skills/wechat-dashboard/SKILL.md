---
name: wechat-dashboard
description: Start, open, sync, and analyze the private on-demand macOS WeChat and Feishu Dashboard. Use for dual-platform group/private summaries, attention alerts, opportunity signals, or when the user asks to start, refresh, inspect, monitor, or stop local chat analysis.
---

# WeChat × Feishu Dashboard

Run the local Dashboard only for the current user-invoked agent session. Keep every conversation separate and import validated structured results into the encrypted local database. On every invocation except an explicit stop-only request, open the Dashboard page for the user before analysis begins.

## Non-Persistent Runtime

- Do not create a Codex Automation, cron entry, heartbeat automation, LaunchAgent, or other permanent scheduler.
- Start the Dashboard with the bridge. The managed local server has a short lease and only listens on `127.0.0.1`.
- Any Dashboard page sends a local heartbeat while it is open. The heartbeat starts a due local message sync about every 30 minutes and can keep the server alive only up to the current Skill lease. After all pages close, the managed server expires within about three minutes.
- Semantic analysis can repeat only while the current Terra High-capable Codex task remains active. When the task ends, no model analysis continues in the background.
- Stop immediately when the user asks, the managed listener becomes unreachable, or the bridge reports that the Dashboard viewer is closed.

## Privacy Boundary

- Briefly tell the user that the selected bounded chat context enters the current Codex analysis session.
- Group chats are always eligible. Private chats are eligible only when the corresponding `analyzeWeChatPrivate` or `analyzeFeishuPrivate` setting is explicitly enabled.
- Never upload context to another service, paste it into a public page, commit it, or repeat full chat content in the final answer.
- Treat participant names, group names, message text, account directories, evidence identifiers, and job tokens as sensitive local data.
- Keep temporary context and result files in the private directory created by the bridge. A successful import removes them.
- Do not restart, re-sign, log out, reinitialize, or otherwise modify WeChat. Use Feishu only as the authenticated user through `lark-cli`; never fall back to bot identity.

## Choose a Mode

- Use `scheduled` by default. It updates separate per-conversation summaries,重点关注提示, and潜在商机提示 when the 30-minute semantic interval is due.
- Use `summaries` when the user asks only for conversation summaries now.
- Use `alerts` when the user asks only for重点关注提示.
- Use `opportunities` when the user asks only for潜在商机提示.
- Use active monitoring only when the user asks to start or monitor. Otherwise run one immediate cycle and hand control back.

## Start the On-Demand Session

1. Resolve this Skill directory from the loaded `SKILL.md` path.
2. Always complete this section before running an analysis cycle. Do not rely on `prepare` to start the service implicitly.
3. Run:

   `zsh <skill-dir>/scripts/run-bridge.zsh start --session-minutes 10`

4. If local execution is sandbox-blocked, request approval and rerun the same command. Do not substitute a persistent service.
5. Immediately open the returned loopback URL on every invocation, even when the user did not separately ask to see the Dashboard:
   - Prefer the host's built-in browser when it can open a local loopback page.
   - Otherwise open the URL in Google Chrome on macOS.
   - If browser-control tooling is unavailable, use the system `open -a "Google Chrome" <loopback-url>` command.
6. Treat an explicit stop-only request as the sole exception: run the Stop flow without starting a service or opening a browser.

## Run One Analysis Cycle

1. Run:

   `zsh <skill-dir>/scripts/run-bridge.zsh prepare --mode <mode> --session-minutes <10-or-35>`

   Use `10` for one immediate run and `35` when starting active monitoring.

2. Inspect the compact JSON envelope. Stop on `status: "blocked"` and report its `summary` plus `next_actions`. Return on `status: "no_work"`.
3. Use exactly Terra High: model `gpt-5.6-terra`, reasoning `high`. Do not use Luna, another model, or a lower/higher effort.
4. Prefer an isolated Terra High executor whenever the host exposes agent collaboration with model overrides:
   - Spawn one worker with `model: gpt-5.6-terra`, `reasoning_effort: high`, and `fork_turns: none`.
   - Give the worker only the absolute `context.json`, `result_template`, and [analysis-contract.md](references/analysis-contract.md) paths. Do not copy chat text into the task message.
   - Tell the worker to read the entire context and contract, analyze each conversation independently, and create the exact result JSON with `apply_patch`.
   - Wait for the worker to finish, then continue with import. The orchestrating agent must not replace or reinterpret the Terra result with another model.
5. If model override is unavailable, continue locally only when the current task is explicitly running `gpt-5.6-terra` at reasoning `high`. If the host cannot prove that condition, stop the semantic cycle with `TERRA_HIGH_UNAVAILABLE`; leave the local sync result intact.
6. Analyze each conversation independently. Never merge multiple conversations into one summary. Include a summary only when that conversation has meaningful messages, using evidence from the same conversation.
7. Use semantic judgment for alerts. Rule signals are candidate hints, not conclusions. Exclude ordinary chat, weak speculation, and issues resolved by later messages.
8. Run:

   `zsh <skill-dir>/scripts/run-bridge.zsh import --context <context-path> --result <result-path>`

9. Confirm `status: "imported"`. Report imported counts and Dashboard pages only; do not quote source messages.
10. Leave the opened Dashboard available for a short viewing window by running:

    `zsh <skill-dir>/scripts/run-bridge.zsh ensure --session-minutes 10`

    Do not stop the service immediately after a successful one-off import; it will still expire at the lease limit or shortly after all Dashboard pages close.

## Active 30-Minute Monitoring

After the first successful cycle:

1. Renew the task-scoped lease with `ensure --session-minutes 35`, then run `status`. Continue only when `service.managed` and `service.viewer_active` are both `true`.
2. Keep the current Terra High-capable Codex task active and wait 30 minutes without creating any scheduled automation.
3. Run the next cycle with:

   `zsh <skill-dir>/scripts/run-bridge.zsh prepare --mode scheduled --session-minutes 35 --require-viewer true`

4. If the bridge returns `DASHBOARD_VIEWER_CLOSED`, stop the monitoring loop and do not restart the listener automatically.
5. Otherwise analyze and import as above, then repeat while the task is active and the viewer remains open.

This loop is task-scoped. It is not an always-on background feature. If the current agent task cannot remain active for a full interval, explain that periodic semantic analysis has stopped; the local page may continue only until its short lease expires.

Before ending the Codex task, shorten the opened viewing session with `ensure --session-minutes 10`. Run `stop` instead only when the user explicitly asks to stop or the listener/viewer is no longer valid. Never leave a 35-minute monitoring lease as if the task were still active.

## Stop

When the user asks to stop, run:

`zsh <skill-dir>/scripts/run-bridge.zsh stop`

Only the verified supervisor PID for this project may be terminated. Never kill a PID whose command line does not match this Skill's session service and session ID.

## Analysis Priorities

For重点关注提示, detect only:

- `mention`: a meaningful message explicitly @mentions one of `profile.my_names`.
- `customer_emotion`: a customer or external collaborator shows clear anger, intense dissatisfaction, or aggressive language.
- `urgent`: an explicit urgent deadline, production incident, customer escalation, or situation requiring immediate action.
- `no_response`: a concrete question or request has received no meaningful response within a contextually unreasonable period.
- `conflict`: blame, confrontation, or collaboration conflict is escalating.
- `no_solution`: an important problem remains without an owner, next step, or executable solution.

Prefer precision over volume. Every alert needs an actionable `suggested_action` and one or more valid evidence IDs.

For潜在商机提示, use only `new_demand`, `budget_signal`, `collaboration`, `upsell`, `referral`, or `renewal`. Every opportunity needs a concrete business value, suggested action, confidence score, and evidence from the same conversation.

## Failure Handling

- If the production build is missing, report the bridge action to run `pnpm build`; do not start a dev server as a hidden fallback.
- If sync fails but a prior snapshot exists, the bridge may export it with a warning. Clearly label the analysis as using the latest available local snapshot.
- If Terra High is unavailable, do not import a result produced by another model or reasoning effort. Report `TERRA_HIGH_UNAVAILABLE` and keep the encrypted local snapshot available.
- If import rejects evidence or schema, correct the result once and retry. Stop after a second identical validation failure and report the exact error code.
- If the local server cannot be started without approval, pause for that approval. Do not install a persistent service.
