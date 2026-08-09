'use client';

import { useEffect, useState } from 'react';
import { CheckCircle2, Clock3, Database, ShieldCheck, Wrench } from 'lucide-react';

type SetupStatus = {
  ok: boolean;
  dataDir: string;
  configured: boolean;
  config: {
    demoMode: boolean;
    privacyConfirmed: boolean;
    defaultSyncDays: number;
    autoSyncMinutes: number;
    myNicknames: string[];
  };
  checks: {
    wxInstalled: boolean;
    wxReaderReady: boolean;
    wxDaemonRunning: boolean;
    wxDaemonPid: number | null;
    readerCachePrivate: boolean;
    activeAccountDirectory: string | null;
  };
};

export default function SetupPage() {
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [demoMode, setDemoMode] = useState(false);
  const [privacyConfirmed, setPrivacyConfirmed] = useState(false);
  const [defaultSyncDays, setDefaultSyncDays] = useState(7);
  const [myNicknames, setMyNicknames] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const response = await fetch('/api/setup', { cache: 'no-store' });
      const data = (await response.json()) as SetupStatus;
      setStatus(data);
      setDemoMode(data.config.demoMode);
      setPrivacyConfirmed(data.config.privacyConfirmed);
      setDefaultSyncDays(data.config.defaultSyncDays ?? 7);
      setMyNicknames((data.config.myNicknames ?? []).join('、'));
    })();
  }, []);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/setup', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          myNicknames: myNicknames
            .split(/[、,，\n]/)
            .map((name) => name.trim())
            .filter(Boolean),
          demoMode,
          privacyConfirmed,
          defaultSyncDays,
        }),
      });
      const data = (await response.json()) as { ok: boolean; error?: string };
      if (!response.ok || !data.ok) throw new Error(data.error ?? '保存失败');
      window.location.href = '/';
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '保存失败');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-[var(--bg)] px-6 py-8 text-[var(--text)]">
      <div className="mx-auto max-w-4xl">
        <div className="report-kicker">WeChat Dashboard Setup</div>
        <h1 className="mt-2 text-[29px] font-semibold">配置本机微信 Dashboard</h1>
        <p className="mt-2 max-w-2xl text-[14px] leading-relaxed text-[var(--text-2)]">
          只读取这台 Mac 上的微信群聊与私信，生成本地 SQLite 快照。按需启动且 Chrome 页面打开期间，每 30 分钟自动增量同步一次。
        </p>

        <div className="mt-6 grid grid-cols-1 gap-4 lg:grid-cols-2">
          <section className="card p-5">
            <SectionTitle icon={<Wrench size={15} />} title="读取器状态" />
            <CheckRow
              label="wx-cli"
              ok={status?.checks.wxInstalled ?? false}
              detail={status?.checks.wxInstalled ? '项目内已安装' : '尚未安装'}
            />
            <CheckRow
              label="真实数据"
              ok={status?.checks.wxReaderReady ?? false}
              detail={
                status?.checks.wxReaderReady
                  ? '本地会话可读取'
                  : '密钥初始化尚未完成'
              }
            />
            <CheckRow
              label="缓存权限"
              ok={status?.checks.readerCachePrivate ?? false}
              detail={
                status?.checks.readerCachePrivate
                  ? '仅当前用户可访问'
                  : '请先收紧 ~/.wx-cli 权限'
              }
            />
            <CheckRow
              label="当前账号"
              ok={Boolean(status?.checks.activeAccountDirectory)}
              detail={status?.checks.activeAccountDirectory ?? '尚未识别'}
            />
            <CheckRow label="数据目录" ok detail={status?.dataDir ?? '加载中'} />
          </section>

          <section className="card p-5">
            <SectionTitle icon={<Clock3 size={15} />} title="同步范围" />
            <p className="mt-3 text-[13px] leading-relaxed text-[var(--text-3)]">
              首次只导入会话元数据，再读取最近 2 小时的少量活跃会话；当天消息按批次继续补齐。之后页面打开时每 30 分钟只读取新增消息，每小时做一次时间戳对账。
            </p>
            <div className="mt-4 rounded-md bg-[var(--surface-2)] px-3 py-2 text-[12px] leading-relaxed text-[var(--text-3)]">
              最近 2 小时：快速同步 · 今日：每批最多 20 个会话 · 7 / 30 天：后续手动补齐
            </div>
          </section>

          <section className="card p-5">
            <SectionTitle icon={<CheckCircle2 size={15} />} title="@ 我的识别名" />
            <p className="mt-3 text-[13px] leading-relaxed text-[var(--text-3)]">
              填写你在工作群里可能出现的昵称或别名，用顿号或逗号分隔。Codex 只在消息明确 @ 到这些名字时生成“@ 我”提醒。
            </p>
            <input
              className="control-surface mt-4 w-full rounded-md px-3 py-2 text-[14px]"
              value={myNicknames}
              onChange={(event) => setMyNicknames(event.target.value)}
              placeholder="例如：Lens、苗老师"
              autoComplete="off"
            />
          </section>

          <section className="card p-5">
            <SectionTitle icon={<Database size={15} />} title="数据模式" />
            <label className="mt-4 flex items-start gap-2 text-[14px]">
              <input
                className="mt-0.5"
                type="checkbox"
                checked={demoMode}
                onChange={(event) => setDemoMode(event.target.checked)}
              />
              <span>
                使用示例数据
                <span className="mt-1 block text-[12px] text-[var(--text-3)]">
                  适合先检查界面，不读取真实微信。
                </span>
              </span>
            </label>
          </section>

          <section className="card p-5">
            <SectionTitle icon={<ShieldCheck size={15} />} title="本机隐私边界" />
            <label className="mt-4 flex items-start gap-2 text-[14px] leading-relaxed">
              <input
                className="mt-1"
                type="checkbox"
                checked={privacyConfirmed}
                onChange={(event) => setPrivacyConfirmed(event.target.checked)}
              />
              <span>
                我理解 Dashboard 会把群聊与私信加密存入本机 SQLite，主密钥保存在 macOS Keychain；数据不会由本项目上传。
              </span>
            </label>
          </section>
        </div>

        {error && <div className="mt-4 text-[14px] text-[var(--danger)]">{error}</div>}

        <div className="mt-6 flex justify-end gap-2">
          {status?.configured && (
            <button className="btn" onClick={() => (window.location.href = '/')}>返回 Dashboard</button>
          )}
          <button
            className="btn btn-primary"
            disabled={
              busy ||
              !privacyConfirmed ||
              (!demoMode &&
                (!status?.checks.wxReaderReady ||
                  !status?.checks.readerCachePrivate ||
                  !status?.checks.activeAccountDirectory))
            }
            onClick={submit}
          >
            {busy ? '保存中…' : '保存并打开 Dashboard'}
          </button>
        </div>
      </div>
    </main>
  );
}

function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="flex items-center gap-1.5 text-[15px] font-semibold text-[var(--text)]">
      {icon}
      {title}
    </div>
  );
}

function CheckRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className="mt-3 flex items-center justify-between gap-3 text-[14px]">
      <span className="text-[var(--text-2)]">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-right text-[13px] text-[var(--text-3)]">
        <CheckCircle2
          size={13}
          className={ok ? 'text-[var(--accent)]' : 'text-[var(--danger)]'}
        />
        <span className="truncate">{detail}</span>
      </span>
    </div>
  );
}
