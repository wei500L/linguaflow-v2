import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api } from './lib/api';
import { tr } from './lib/i18n';

type Audience = { token: string; includeAudio: boolean; expiresAt: string | null };
type SessionMode = 'one_way' | 'two_way';

const classStarted = new Set<string>();
const classDismissed = new Set<string>();

function revokedKey(sessionId: string) {
  return `linguaflow_audience_revoked_${sessionId}`;
}

function isRevoked(sessionId: string) {
  try { return sessionStorage.getItem(revokedKey(sessionId)) === '1'; }
  catch { return false; }
}

function markRevoked(sessionId: string) {
  classStarted.add(sessionId);
  try { sessionStorage.setItem(revokedKey(sessionId), '1'); } catch { /* Storage can be blocked. */ }
}

export function AudienceLink({ sessionId, mode }: { sessionId: string; mode: SessionMode }) {
  const classroom = mode === 'one_way';
  const [open, setOpen] = useState(false);
  const [audience, setAudience] = useState<Audience | null>(null);
  const [viewerCount, setViewerCount] = useState(0);
  const [includeAudio, setIncludeAudio] = useState(false);
  const [hours, setHours] = useState('168');
  const [qr, setQr] = useState('');
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [qrFullscreen, setQrFullscreen] = useState(false);
  const sheetRef = useRef<HTMLDivElement>(null);
  const syncedToken = useRef('');
  const bootstrapped = useRef('');
  const generation = useRef(0);
  const publishRef = useRef<(include: boolean, expiresInHours: number | null, copy: boolean, automatic?: boolean) => Promise<void>>(async () => undefined);

  async function publish(include: boolean, expiresInHours: number | null, copy: boolean, automatic = false) {
    if (automatic && isRevoked(sessionId)) return;
    const ticket = ++generation.current;
    setBusy(true); setError(''); setNotice('');
    try {
      const result = await api<{ audience: Audience }>(`/v1/realtime/sessions/${sessionId}/audience`, { method: 'POST', body: JSON.stringify({ includeAudio: include, expiresInHours }) });
      if (automatic && isRevoked(sessionId)) {
        await api(`/v1/realtime/sessions/${sessionId}/audience`, { method: 'DELETE' }).catch(() => undefined);
        if (ticket === generation.current) setAudience(null);
        return;
      }
      if (ticket !== generation.current) return;
      if (!automatic) {
        try { sessionStorage.removeItem(revokedKey(sessionId)); } catch { /* Storage can be blocked. */ }
      }
      setAudience(result.audience);
      if (!copy || !result.audience.token) return;
      const next = `${window.location.origin}/live/${result.audience.token}`;
      try { await navigator.clipboard.writeText(next); setNotice(tr('听众链接已复制。')); } catch { setNotice(''); }
    } catch (err) { if (ticket === generation.current) setError(err instanceof Error ? err.message : tr('操作失败')); }
    finally {
      if (ticket === generation.current) {
        setBusy(false);
        generation.current += 1;
      }
    }
  }
  publishRef.current = publish;

  useEffect(() => {
    const onChange = () => setQrFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  useEffect(() => {
    let alive = true;
    async function load() {
      const ticket = generation.current;
      const result = await api<{ audience: Audience | null; viewerCount?: number }>(`/v1/realtime/sessions/${sessionId}/audience`);
      if (!alive || ticket !== generation.current) return;
      if (isRevoked(sessionId)) {
        setViewerCount(0);
        setAudience(null);
        bootstrapped.current = sessionId;
        return;
      }
      setViewerCount(result.viewerCount ?? 0);
      setAudience(result.audience);
      if (result.audience && syncedToken.current !== result.audience.token) {
        syncedToken.current = result.audience.token;
        setIncludeAudio(result.audience.includeAudio);
      }
      if (!result.audience) syncedToken.current = '';
      if (bootstrapped.current === sessionId) return;
      bootstrapped.current = sessionId;
      if (!classroom || isRevoked(sessionId) || classDismissed.has(sessionId)) return;
      if (result.audience && !classStarted.has(sessionId)) return;
      if (!classStarted.has(sessionId)) {
        classStarted.add(sessionId);
        void publishRef.current(false, 168, false, true);
      }
      setOpen(true);
    }
    void load().catch(() => undefined);
    const timer = window.setInterval(() => { void load().catch(() => undefined); }, 3000);
    return () => { alive = false; window.clearInterval(timer); };
  }, [sessionId, classroom]);

  const link = audience ? `${window.location.origin}/live/${audience.token}` : '';
  useEffect(() => {
    if (!link) { setQr(''); return; }
    let alive = true;
    void QRCode.toDataURL(link, { margin: 1, width: 640 }).then((url) => { if (alive) setQr(url); }).catch(() => undefined);
    return () => { alive = false; };
  }, [link]);

  function create() {
    const hoursValue = Number(hours);
    return publish(includeAudio, hoursValue > 0 ? hoursValue : null, true);
  }
  async function revoke() {
    const ticket = ++generation.current;
    setBusy(true); setError('');
    try {
      await api(`/v1/realtime/sessions/${sessionId}/audience`, { method: 'DELETE' });
      if (ticket !== generation.current) return;
      markRevoked(sessionId);
      setAudience(null); setNotice(''); setViewerCount(0); syncedToken.current = '';
    } catch (err) { if (ticket === generation.current) setError(err instanceof Error ? err.message : tr('操作失败')); }
    finally {
      if (ticket === generation.current) {
        setBusy(false);
        generation.current += 1;
      }
    }
  }
  async function copy() {
    try { await navigator.clipboard.writeText(link); setNotice(tr('听众链接已复制。')); }
    catch { setError(tr('当前浏览器不允许复制，请手动选择文本。')); }
  }
  function dismiss() {
    classDismissed.add(sessionId);
    setOpen(false);
  }

  async function toggleQrFullscreen() {
    const node = sheetRef.current;
    if (!node) return;
    if (document.fullscreenElement) { await document.exitFullscreen(); setQrFullscreen(false); }
    else { await node.requestFullscreen(); setQrFullscreen(true); }
  }

  return <div className="audience-panel">
    <button type="button" className="audience-launch" onClick={() => setOpen(true)} aria-expanded={open}>
      <i />
      <span>{audience ? viewerCount : tr('听众')}</span>
    </button>
    {open && <div className="audience-overlay" role="presentation" onClick={(event) => { if (event.target === event.currentTarget && !document.fullscreenElement) dismiss(); }}>
      <div className={`audience-sheet${qrFullscreen ? ' is-fullscreen' : ''}`} role="dialog" aria-modal="true" aria-label={tr('听众链接')} ref={sheetRef}>
        <button type="button" className="audience-close" onClick={dismiss} aria-label={tr('关闭')}>×</button>
        <p className="audience-kicker">{classroom ? tr('给学生看') : tr('听众')}</p>
        {audience ? <>
          <p className="audience-count" role="status"><strong>{viewerCount}</strong><span>{tr('人正在看')}</span></p>
          {qr && <img className="audience-qr" src={qr} alt={tr('听众二维码')} width={360} height={360} />}
          <p className="audience-lead">{tr('扫码即可看字幕')}</p>
          <div className="audience-actions">
            <button type="button" className="primary-button" onClick={() => void toggleQrFullscreen()}>{qrFullscreen ? tr('退出全屏') : tr('全屏二维码')}</button>
            <button type="button" className="audience-text" onClick={() => void copy()}>{tr('复制链接')}</button>
          </div>
        </> : <>
          <h2>{classroom ? tr('生成一张学生能扫的二维码') : tr('听众链接')}</h2>
          <p className="audience-lead">{classroom ? tr('学生打开后只看字幕。你结束翻译后，这条链接会变成这场记录。') : tr('听众可以看到实时字幕。结束后，这条链接会变成这场记录的分享。')}</p>
          <button type="button" className="primary-button" onClick={() => void create()} disabled={busy}>{busy ? tr('生成中…') : classroom ? tr('生成二维码') : tr('创建听众链接')}</button>
        </>}
        <details className="audience-more">
          <summary>{tr('更多')}</summary>
          <label className="record-toggle"><input type="checkbox" checked={includeAudio} onChange={(event) => setIncludeAudio(event.target.checked)} /><span>{tr('结束后包含录音')}</span></label>
          <label className="audio-source">{tr('分享有效期')}<select value={hours} onChange={(event) => setHours(event.target.value)}><option value="24">{tr('24 小时')}</option><option value="72">{tr('3 天')}</option><option value="168">{tr('7 天')}</option><option value="0">{tr('永不过期')}</option></select></label>
          {audience && <button type="button" className="secondary-button" onClick={() => void create()} disabled={busy}>{tr('保存这些设置')}</button>}
          {link && <input readOnly value={link} aria-label={tr('听众链接')} onFocus={(event) => event.currentTarget.select()} />}
          {audience?.expiresAt && <p>{tr('到期')} {new Date(audience.expiresAt).toLocaleString()}</p>}
          {audience && <button type="button" className="audience-text danger" onClick={() => void revoke()} disabled={busy}>{tr('撤销听众链接')}</button>}
        </details>
        {notice && <p className="audience-lead" role="status">{notice}</p>}
        {error && <p className="form-message" role="alert">{error}</p>}
      </div>
    </div>}
  </div>;
}
