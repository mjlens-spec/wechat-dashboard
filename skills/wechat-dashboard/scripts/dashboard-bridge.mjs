#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  securePrivateDirectory,
  securePrivateFile,
} from '../../../lib/private-paths.mjs';

class BridgeFailure extends Error {
  constructor(code, message, nextActions) {
    super(message);
    this.code = code;
    this.nextActions = nextActions;
  }
}

const command = process.argv[2] ?? 'status';
const args = parseArgs(process.argv.slice(3));
const baseUrl = validatedBaseUrl(
  process.env.WECHAT_DASHBOARD_URL ?? 'http://127.0.0.1:3000',
);
const skillScriptDir = dirname(fileURLToPath(import.meta.url));
const projectRoot = resolve(skillScriptDir, '../../..');
const nextBin = join(projectRoot, 'node_modules', 'next', 'dist', 'bin', 'next');
const buildId = join(projectRoot, '.next', 'BUILD_ID');
const serviceScript = join(projectRoot, 'scripts', 'session-service.mjs');
const dataDir = join(homedir(), '.wechat-dashboard');
const leasePath = join(dataDir, 'session-lease.json');
const statePath = join(dataDir, 'session-service.json');
const DEFAULT_SESSION_MINUTES = 10;
const MAX_SESSION_MINUTES = 60;
const VIEWER_ACTIVE_WINDOW_MS = 150_000;

try {
  if (command === 'prepare') {
    const service = await ensureDashboard(
      sessionMinutes(args['session-minutes']),
      args['require-viewer'] === 'true',
    );
    await prepare(args.mode ?? 'scheduled', service);
  } else if (command === 'import') {
    await importResult(args.context, args.result);
  } else if (command === 'start' || command === 'ensure') {
    const service = await ensureDashboard(sessionMinutes(args['session-minutes']), false);
    print({
      status: 'running',
      summary: 'WeChat Dashboard 已按需启动。',
      next_actions: [
        `在 Chrome 打开 ${baseUrl.origin}。`,
        '在 Codex 中继续运行 $wechat-dashboard；关闭页面后临时服务会自动退出。',
      ],
      artifacts: [{ kind: 'dashboard_url', url: baseUrl.origin }],
      service,
    });
  } else if (command === 'stop') {
    await stopManagedSession();
  } else if (command === 'status') {
    await status();
  } else {
    fail('UNKNOWN_COMMAND', `Unknown command: ${command}`, [
      'Use start, prepare, import, status, or stop.',
    ]);
  }
} catch (error) {
  if (error instanceof BridgeFailure) {
    print({
      status: 'blocked',
      summary: error.message,
      next_actions: error.nextActions,
      artifacts: [],
      error: { code: error.code },
    });
    process.exitCode = 2;
  } else {
    print({
      status: 'blocked',
      summary: 'WeChat Dashboard bridge failed unexpectedly.',
      next_actions: ['Inspect the local Dashboard server log, then retry once.'],
      artifacts: [],
      error: { code: 'BRIDGE_FAILURE' },
    });
    process.exitCode = 2;
  }
}

async function prepare(mode, service) {
  if (!['scheduled', 'summaries', 'alerts', 'opportunities'].includes(mode)) {
    fail('INVALID_MODE', `Unsupported analysis mode: ${mode}`, [
      'Use scheduled, summaries, alerts, or opportunities.',
    ]);
  }

  const warnings = [];
  try {
    const sync = await syncLocalMessages();
    if (sync?.status === 'partial') warnings.push('最近一次双端增量同步只完成了一部分。');
  } catch (error) {
    if (error instanceof BridgeFailure && error.code === 'DASHBOARD_UNREACHABLE') throw error;
    warnings.push('本次增量同步失败，分析将使用最近一次可用的本地快照。');
  }

  const exported = await requestJson('/api/intelligence/export', {
    method: 'POST',
    body: { mode },
  });
  if (exported.status === 'no_work') {
    print({ ...exported, warnings, service });
    return;
  }
  if (exported.status !== 'ready' || !exported.context?.job?.id) {
    fail('INVALID_EXPORT_RESPONSE', 'Dashboard returned an invalid analysis export.', [
      'Check the local server log and retry once.',
    ]);
  }

  const privateDir = mkdtempSync(join(tmpdir(), 'wechat-dashboard-analysis-'));
  chmodSync(privateDir, 0o700);
  const contextPath = join(privateDir, 'context.json');
  const resultPath = join(privateDir, 'result.json');
  writePrivateJson(contextPath, exported.context);
  writePrivateJson(resultPath, {
    model: 'gpt-5.6-terra',
    reasoning_effort: 'high',
    summaries: [],
    alerts: [],
    opportunities: [],
  });

  print({
    status: 'ready',
    summary: exported.summary,
    next_actions: [
      'Read the context artifact and the skill analysis contract.',
      'Replace the result template with grounded structured analysis.',
      'Run the bridge import command.',
    ],
    artifacts: [
      { kind: 'analysis_context', path: contextPath },
      { kind: 'result_template', path: resultPath },
    ],
    job: {
      id: exported.context.job.id,
      mode: exported.context.job.mode,
      requested_outputs: exported.context.job.requested_outputs,
      conversation_count: exported.context.conversations.length,
      message_count: exported.context.conversations.reduce(
        (total, group) => total + group.context_message_count,
        0,
      ),
    },
    warnings,
    service,
  });
}

async function importResult(contextPath, resultPath) {
  if (!contextPath || !resultPath) {
    fail('MISSING_IMPORT_PATH', 'Both --context and --result are required.', [
      'Use the paths returned by the prepare command.',
    ]);
  }
  const context = readJson(contextPath, 'analysis context');
  const analysis = readJson(resultPath, 'analysis result');
  const imported = await requestJson('/api/intelligence/import', {
    method: 'POST',
    body: {
      job_id: context?.job?.id,
      job_token: context?.job?.token,
      analysis,
    },
  });
  if (imported.status !== 'imported') {
    fail(imported.code ?? 'IMPORT_REJECTED', imported.error ?? 'Dashboard rejected the result.', [
      'Correct the result schema or evidence IDs, then retry once.',
    ]);
  }
  cleanupPrivateArtifacts(contextPath, resultPath);
  print(imported);
}

async function ensureDashboard(minutes, requireViewer) {
  const existing = readManagedState();
  if (await dashboardReachable()) {
    if (existing && processMatchesSupervisor(existing)) {
      const lease = renewLease(existing.session_id, minutes);
      const viewerActive = viewerIsActive(lease);
      if (requireViewer && !viewerActive) {
        await stopManagedSession({ quiet: true });
        fail(
          'DASHBOARD_VIEWER_CLOSED',
          'Dashboard 页面已关闭或不再发送本机心跳，本轮监控已停止。',
          ['需要继续时，在 Codex 中重新调用 $wechat-dashboard。'],
        );
      }
      return serviceEnvelope(existing, true, viewerActive, lease.expires_at);
    }
    if (requireViewer) {
      fail(
        'DASHBOARD_SESSION_UNMANAGED',
        '当前 Dashboard 由外部进程启动，Skill 无法确认页面是否仍然打开。',
        ['停止外部 Dashboard，再用 dashboard-bridge.mjs start 按需启动。'],
      );
    }
    return {
      managed: false,
      viewer_active: null,
      url: baseUrl.origin,
      expires_at: null,
    };
  }

  if (requireViewer) {
    if (existing && processMatchesSupervisor(existing)) {
      await stopManagedSession({ quiet: true });
    }
    fail(
      'DASHBOARD_VIEWER_CLOSED',
      'Dashboard 页面或本机监听服务已关闭，本轮监控已停止。',
      ['需要继续时，在 Codex 中重新调用 $wechat-dashboard。'],
    );
  }

  if (existing && processMatchesSupervisor(existing)) {
    const lease = renewLease(existing.session_id, minutes);
    if (await waitForDashboard(12_000)) {
      return serviceEnvelope(existing, true, viewerIsActive(lease), lease.expires_at);
    }
    fail('DASHBOARD_START_TIMEOUT', '按需 Dashboard 进程尚未能监听本机端口。', [
      `检查 ${join(dataDir, 'logs', 'session.err.log')} 后重试一次。`,
    ]);
  }

  cleanupStaleSessionFiles(existing?.session_id);
  validateOnDemandRuntime();
  secureDataDirectory();

  const sessionId = randomUUID();
  const lease = writeLease({
    version: 1,
    session_id: sessionId,
    project_root: projectRoot,
    created_at: Date.now(),
    skill_expires_at: Date.now() + minutes * 60_000,
    expires_at: Date.now() + minutes * 60_000,
    last_skill_heartbeat_at: Date.now(),
    last_viewer_heartbeat_at: null,
  });
  const child = spawn(
    process.execPath,
    [
      serviceScript,
      '--session-id',
      sessionId,
      '--port',
      effectivePort(baseUrl),
    ],
    {
      cwd: projectRoot,
      detached: true,
      stdio: 'ignore',
      env: { ...process.env, NODE_ENV: 'production' },
    },
  );
  child.unref();

  if (!(await waitForDashboard(20_000))) {
    const state = readManagedState();
    if (state && processMatchesSupervisor(state)) process.kill(state.supervisor_pid, 'SIGTERM');
    fail('DASHBOARD_START_FAILED', '按需 Dashboard 启动失败。', [
      `检查 ${join(dataDir, 'logs', 'session.err.log')}。`,
      '确认已运行 pnpm build，然后重试一次。',
    ]);
  }

  const state = readManagedState();
  if (!state || state.session_id !== sessionId || !processMatchesSupervisor(state)) {
    fail('DASHBOARD_STATE_INVALID', 'Dashboard 已监听端口，但按需会话状态无法验证。', [
      '运行 dashboard-bridge.mjs stop，再重试一次。',
    ]);
  }
  return serviceEnvelope(state, true, viewerIsActive(lease), lease.expires_at);
}

async function stopManagedSession(options = {}) {
  const state = readManagedState();
  if (!state) {
    cleanupStaleSessionFiles();
    if (!options.quiet) {
      print({
        status: 'stopped',
        summary: '没有正在运行的按需 Dashboard 会话。',
        next_actions: [],
        artifacts: [],
      });
    }
    return;
  }
  if (!processIsAlive(state.supervisor_pid)) {
    cleanupStaleSessionFiles(state.session_id);
    if (!options.quiet) {
      print({
        status: 'stopped',
        summary: '按需 Dashboard 进程已经退出，遗留会话状态已清理。',
        next_actions: [],
        artifacts: [],
      });
    }
    return;
  }
  if (!processMatchesSupervisor(state)) {
    fail('SESSION_PROCESS_MISMATCH', '会话 PID 与本项目的按需服务不匹配，已拒绝终止。', [
      '检查 session-service.json 和本机进程后再处理。',
    ]);
  }

  process.kill(state.supervisor_pid, 'SIGTERM');
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && processIsAlive(state.supervisor_pid)) {
    await delay(200);
  }
  if (processIsAlive(state.supervisor_pid)) {
    fail('SESSION_STOP_TIMEOUT', '按需 Dashboard 尚未在安全等待时间内退出。', [
      '稍后重试 stop；不要终止其他本机进程。',
    ]);
  }
  cleanupStaleSessionFiles(state.session_id);
  if (!options.quiet) {
    print({
      status: 'stopped',
      summary: 'WeChat Dashboard 按需会话已停止。',
      next_actions: ['需要继续时，在 Codex 中重新调用 $wechat-dashboard。'],
      artifacts: [],
    });
  }
}

async function status() {
  const reachable = await dashboardReachable();
  const state = readManagedState();
  const managed = Boolean(state && processMatchesSupervisor(state));
  const lease = managed && state ? readLease(state.session_id) : null;
  let result = null;
  if (reachable) {
    try {
      result = await requestJson('/api/intelligence/status');
    } catch {
      result = null;
    }
  }
  print({
    status: reachable ? 'running' : 'stopped',
    summary: reachable
      ? result?.latest_job
        ? `Dashboard 正在运行；最近分析任务：${result.latest_job.status}。`
        : 'Dashboard 正在运行，尚无分析任务。'
      : 'Dashboard 当前未运行。',
    next_actions: reachable ? [] : ['Run start, or invoke $wechat-dashboard.'],
    artifacts: [],
    service: {
      managed,
      viewer_active: lease ? viewerIsActive(lease) : null,
      url: baseUrl.origin,
      expires_at: lease?.expires_at ?? null,
    },
    latest_job: result?.latest_job ?? null,
  });
}

function readManagedState() {
  try {
    if (!securePrivateFile(statePath, { allowMissing: true })) return null;
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    if (
      state?.version !== 1 ||
      state.project_root !== projectRoot ||
      typeof state.session_id !== 'string' ||
      !Number.isInteger(state.supervisor_pid) ||
      !Number.isInteger(state.server_pid) ||
      !Number.isInteger(state.port)
    ) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function readLease(sessionId) {
  try {
    if (!securePrivateFile(leasePath, { allowMissing: true })) return null;
    const lease = JSON.parse(readFileSync(leasePath, 'utf8'));
    if (
      lease?.version !== 1 ||
      lease.project_root !== projectRoot ||
      typeof lease.session_id !== 'string' ||
      (sessionId && lease.session_id !== sessionId) ||
      !Number.isFinite(lease.skill_expires_at) ||
      !Number.isFinite(lease.expires_at)
    ) {
      return null;
    }
    return lease;
  } catch {
    return null;
  }
}

function renewLease(sessionId, minutes) {
  const current = readLease(sessionId);
  const now = Date.now();
  return writeLease({
    version: 1,
    session_id: sessionId,
    project_root: projectRoot,
    created_at: current?.created_at ?? now,
    skill_expires_at: now + minutes * 60_000,
    expires_at: now + minutes * 60_000,
    last_skill_heartbeat_at: now,
    last_viewer_heartbeat_at: current?.last_viewer_heartbeat_at ?? null,
  });
}

function writeLease(value) {
  secureDataDirectory();
  writePrivateJsonAtomic(leasePath, value);
  return value;
}

function viewerIsActive(lease) {
  const timestamp = lease?.last_viewer_heartbeat_at;
  if (!Number.isFinite(timestamp)) return false;
  const age = Date.now() - timestamp;
  return age >= 0 && age <= VIEWER_ACTIVE_WINDOW_MS;
}

function processMatchesSupervisor(state) {
  if (!processIsAlive(state.supervisor_pid)) return false;
  try {
    const commandLine = execFileSync(
      '/bin/ps',
      ['-p', String(state.supervisor_pid), '-o', 'command='],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim();
    return (
      commandLine.includes(serviceScript) &&
      commandLine.includes('--session-id') &&
      commandLine.includes(state.session_id)
    );
  } catch {
    return false;
  }
}

function processIsAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function cleanupStaleSessionFiles(sessionId) {
  removeOwnedFile(statePath, sessionId);
  removeOwnedFile(leasePath, sessionId);
}

function removeOwnedFile(path, sessionId) {
  try {
    if (!securePrivateFile(path, { allowMissing: true })) return;
    const value = JSON.parse(readFileSync(path, 'utf8'));
    if (
      value.project_root === projectRoot &&
      (!sessionId || value.session_id === sessionId)
    ) {
      unlinkSync(path);
    }
  } catch {
    // Only exact, valid files owned by this project are removed.
  }
}

function validateOnDemandRuntime() {
  if (process.platform !== 'darwin') {
    fail('UNSUPPORTED_PLATFORM', '按需 Dashboard 服务目前只支持 macOS。', []);
  }
  if (!existsSync(nextBin)) {
    fail('DEPENDENCIES_MISSING', '项目依赖尚未安装。', ['在项目目录运行 pnpm install。']);
  }
  if (!existsSync(buildId)) {
    fail('PRODUCTION_BUILD_MISSING', '本机缺少可启动的 production build。', [
      '在项目目录运行 pnpm build，然后重新调用 $wechat-dashboard。',
    ]);
  }
  if (!existsSync(serviceScript)) {
    fail('SESSION_SERVICE_MISSING', '按需服务脚本缺失。', ['重新安装本项目 Skill。']);
  }
}

function secureDataDirectory() {
  securePrivateDirectory(dataDir, { create: true });
}

async function dashboardReachable() {
  try {
    const response = await fetch(new URL('/api/intelligence/status', baseUrl), {
      cache: 'no-store',
      signal: AbortSignal.timeout(1_500),
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => null);
    return body?.ok === true;
  } catch {
    return false;
  }
}

async function waitForDashboard(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await dashboardReachable()) return true;
    await delay(250);
  }
  return false;
}

function serviceEnvelope(state, managed, viewerActive, expiresAt) {
  return {
    managed,
    viewer_active: viewerActive,
    url: baseUrl.origin,
    expires_at: expiresAt,
    session_id: state.session_id,
  };
}

function sessionMinutes(value) {
  if (value === undefined) return DEFAULT_SESSION_MINUTES;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 2 || parsed > MAX_SESSION_MINUTES) {
    fail('INVALID_SESSION_DURATION', '按需会话时长必须是 2 到 60 分钟的整数。', [
      '省略 --session-minutes 可使用默认 10 分钟启动宽限期。',
    ]);
  }
  return parsed;
}

function effectivePort(url) {
  const port = Number(url.port || '80');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    fail('UNSAFE_DASHBOARD_PORT', '按需 Dashboard 端口必须在 1024 到 65535 之间。', [
      '使用默认地址 http://127.0.0.1:3000。',
    ]);
  }
  return String(port);
}

function writePrivateJsonAtomic(path, value) {
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
    flag: 'wx',
  });
  securePrivateFile(temporary);
  renameSync(temporary, path);
  securePrivateFile(path);
}

function delay(milliseconds) {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));
}

async function syncLocalMessages() {
  const started = await requestJson('/api/sync', {
    method: 'POST',
    body: { mode: 'latest' },
  });
  if (!started.ok || !started.run_id) {
    throw new BridgeFailure('SYNC_START_FAILED', started.error ?? 'Local sync could not start.', []);
  }
  const deadline = Date.now() + 100_000;
  while (Date.now() < deadline) {
    const state = await requestJson(`/api/sync?run_id=${encodeURIComponent(started.run_id)}`);
    if (state.run && state.run.status !== 'running') return state.run;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1_500));
  }
  return { status: 'running' };
}

async function requestJson(path, options = {}) {
  let response;
  try {
    response = await fetch(new URL(path, baseUrl), {
      method: options.method ?? 'GET',
      headers:
        options.method === 'POST'
          ? { 'content-type': 'application/json', origin: baseUrl.origin }
          : undefined,
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
      cache: 'no-store',
    });
  } catch {
    throw new BridgeFailure(
      'DASHBOARD_UNREACHABLE',
      `Local WeChat Dashboard is not reachable at ${baseUrl.origin}.`,
      [
        'Run dashboard-bridge.mjs start with local execution approval.',
        'Retry the same Skill command after the on-demand server is ready.',
      ],
    );
  }
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    throw new BridgeFailure(
      body.code ?? `HTTP_${response.status}`,
      body.error ?? `Dashboard request failed with HTTP ${response.status}.`,
      ['Inspect the local Dashboard server log and retry once.'],
    );
  }
  return body;
}

function parseArgs(raw) {
  const parsed = {};
  for (let index = 0; index < raw.length; index += 2) {
    const key = raw[index];
    const value = raw[index + 1];
    if (!key?.startsWith('--') || value === undefined) continue;
    parsed[key.slice(2)] = value;
  }
  return parsed;
}

function validatedBaseUrl(value) {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  const loopback =
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname === '0:0:0:0:0:0:0:1' ||
    hostname.startsWith('127.');
  if (url.protocol !== 'http:' || !loopback || url.username || url.password) {
    throw new BridgeFailure(
      'UNSAFE_DASHBOARD_URL',
      'WECHAT_DASHBOARD_URL must be an unauthenticated loopback HTTP URL.',
      ['Use http://127.0.0.1:3000 unless the local port was intentionally changed.'],
    );
  }
  url.pathname = '/';
  url.search = '';
  url.hash = '';
  return url;
}

function writePrivateJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: 'utf8',
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch {
    fail('INVALID_LOCAL_JSON', `Cannot read valid JSON from the ${label} file.`, [
      'Use the exact private path returned by prepare.',
    ]);
  }
}

function cleanupPrivateArtifacts(contextPath, resultPath) {
  const contextDir = resolve(dirname(contextPath));
  const resultDir = resolve(dirname(resultPath));
  const safePrefix = resolve(tmpdir());
  if (
    contextDir !== resultDir ||
    !contextDir.startsWith(`${safePrefix}/`) ||
    !basename(contextDir).startsWith('wechat-dashboard-analysis-')
  ) {
    return;
  }
  for (const path of [resolve(contextPath), resolve(resultPath)]) {
    if (dirname(path) === contextDir) {
      try {
        unlinkSync(path);
      } catch {
        // Import already succeeded; a stale private temp file is non-fatal.
      }
    }
  }
  try {
    rmdirSync(contextDir);
  } catch {
    // Keep any unexpected file rather than deleting a broader directory.
  }
}

function fail(code, message, nextActions) {
  throw new BridgeFailure(code, message, nextActions);
}

function print(value) {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
