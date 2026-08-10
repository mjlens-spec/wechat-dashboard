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
    <main className="setup-page">
      <div className="setup-shell">
        <header className="setup-header">
        <div className="flex items-center gap-2"><span className="brand-mark" /><div className="report-kicker">WeChat Dashboard Setup</div></div>
        <h1>配置本机微信 Dashboard</h1>
        <p>
          只读取这台 Mac 上的微信群聊与私信，生成本地 SQLite 快照。按需启动且 Chrome 页面打开期间，每 30 分钟自动增量同步一次。
        </p>
        </header>

        <div className="setup-grid">
          <section className="setup-section">
            <SectionTitle icon={<Wrench size={15} />} title="读取器状态 · 本机检查" />
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
              label="读取服务"
              ok={status?.checks.wxDaemonRunning ?? false}
              detail={status?.checks.wxDaemonRunning ? `运行中 · PID ${status.checks.wxDaemonPid ?? '—'}` : '尚未运行'}
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

          <section className="setup-section">
            <SectionTitle icon={<Clock3 size={15} />} title="同步范围" />
            <p className="mt-3 text-[13px] leading-relaxed text-[var(--text-3)]">
              首次只导入会话元数据，再读取最近 2 小时的少量活跃会话；当天消息按批次继续补齐。之后页面打开时每 30 分钟只读取新增消息，每小时做一次时间戳对账。
            </p>
            <div className="setup-ledger">
              <div><span>最近 2 小时</span><span>快速同步</span></div>
              <div><span>今日</span><span>每批最多 20 个会话</span></div>
              <div><span>7 / 30 天</span><span>后续手动补齐</span></div>
            </div>
          </section>

          <section className="setup-section">
            <SectionTitle icon={<CheckCircle2 size={15} />} title="@ 我的识别名" />
            <p className="mt-3 text-[13px] leading-relaxed text-[var(--text-3)]">
              填写你在工作群里可能出现的昵称或别名，用顿号或逗号分隔。Codex 只在消息明确 @ 到这些名字时生成“@ 我”提醒。
            </p>
            <input
              className="setup-input"
              value={myNicknames}
              onChange={(event) => setMyNicknames(event.target.value)}
              placeholder="例如：Lens、苗老师"
              autoComplete="off"
            />
          </section>

          <section className="setup-section">
            <SectionTitle icon={<Database size={15} />} title="数据模式" />
            <div className="mt-4 flex flex-col gap-3">
            <label className="flex items-start gap-2 text-[14px]">
              <input
                className="mt-0.5"
                type="radio"
                name="data-mode"
                checked={demoMode}
                onChange={() => setDemoMode(true)}
              />
              <span>
                使用示例数据
                <span className="mt-1 block text-[12px] text-[var(--text-3)]">
                  适合先检查界面，不读取真实微信。
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-[14px]">
              <input
                className="mt-0.5"
                type="radio"
                name="data-mode"
                checked={!demoMode}
                onChange={() => setDemoMode(false)}
              />
              <span>
                读取本机真实微信
                <span className="mt-1 block text-[12px] text-[var(--text-3)]">
                  需要读取器、读取服务与缓存权限全部通过。
                </span>
              </span>
            </label>
            </div>
          </section>

          <section className="setup-privacy">
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
            <div className="privacy-ledger">
              <span>AES-256-GCM 加密正文、群名、摘要与提示</span>
              <span>目录权限基线 0700 · 文件 0600</span>
              <span>服务只监听 127.0.0.1 · 页面全部关闭约 3 分钟后退出</span>
            </div>
          </section>
        </div>

        {error && <div className="mt-4 text-[14px] text-[var(--danger)]">{error}</div>}

        <div className="setup-footer">
          <span>本机检查未通过时无法保存真实数据模式。</span>
          <div className="flex gap-2">
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
      </div>
    </main>
  );
}

function SectionTitle({ icon, title }: { icon: React.ReactNode; title: string }) {
  return (
    <div className="setup-section-title">
      {icon}
      {title}
    </div>
  );
}

function CheckRow({ label, ok, detail }: { label: string; ok: boolean; detail: string }) {
  return (
    <div className={`setup-check ${ok ? '' : 'setup-check-failed'}`}>
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
