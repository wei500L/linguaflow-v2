import { useEffect, useRef, useState } from 'react';
import { apiOrigin } from './lib/api';
import { PHONE_QUERY, useMediaQuery } from './lib/breakpoints';
import { tr, useLang } from './lib/i18n';
import { LanguageToggle } from './language-toggle';
import { ThemeToggle } from './theme-toggle';
import { gapCaption, renderSummary } from './transcript-panel';

type CaptionView = 'both' | 'translation' | 'source';
type ShareSegment = { id: string; speaker: string | null; language?: string | null; sourceText: string; translationText: string; startMs: number | null; endMs?: number | null };
type ShareData = {
  title: string;
  mode?: string;
  languageA?: string;
  languageB?: string;
  createdAt?: string;
  durationMs?: number;
  expiresAt?: string | null;
  scope?: string;
  tasks?: Array<{ id: string; text: string; done: boolean }>;
  summaryMarkdown: string | null;
  audioUrl: string | null;
  segments: ShareSegment[];
  gaps?: Array<{ id: string; source: string; precision: string; wallStartMs?: number | null; wallEndMs?: number | null; audioStartMs?: number | null; audioEndMs?: number | null }>;
  summaryCitationHashes?: Record<string, string> | null;
  summaryCitationsVerified?: boolean;
};

function formatClockMs(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const clock = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${clock}` : clock;
}

function formatDurationMs(ms: number) {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} ${tr('秒')}`;
  const minutes = Math.round(ms / 60000);
  if (minutes < 60) return `${minutes} ${tr('分钟')}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours} ${tr('小时')} ${rest} ${tr('分钟')}` : `${hours} ${tr('小时')}`;
}

function formatWhen(iso: string) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(document.documentElement.lang === 'en' ? 'en' : 'zh-CN', { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function SharePage({ token }: { token: string }) {
  useLang();
  const phone = useMediaQuery(PHONE_QUERY);
  const [data, setData] = useState<ShareData | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);
  const [exporting, setExporting] = useState('');
  const [exportError, setExportError] = useState('');
  const [notice, setNotice] = useState('');
  const [view, setView] = useState<CaptionView>('both');
  const [password, setPassword] = useState('');
  const [passwordDraft, setPasswordDraft] = useState('');
  const [needsPassword, setNeedsPassword] = useState(false);
  const [badPassword, setBadPassword] = useState(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    let alive = true;
    setLoading(true); setNotice(''); setExportError(''); setNeedsPassword(false);
    fetch(`${apiOrigin}/v1/shares/${encodeURIComponent(token)}`, { headers: password ? { 'x-share-password': password } : {} }).then(async (response) => {
      if (response.status === 401) {
        const payload = await response.json().catch(() => null) as { code?: string } | null;
        if (payload?.code === 'share_password_required') { if (alive) { setNeedsPassword(true); setBadPassword(Boolean(password)); setData(null); } return; }
      }
      if (!response.ok) throw new Error('expired');
      const payload = await response.json() as ShareData;
      if (alive) setData(payload);
    }).catch((err: Error) => {
      if (!alive) return;
      setError(err.message === 'expired' ? tr('分享链接已失效。') : tr('无法打开这场分享。'));
    }).finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [token, password]);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: 'nearest' }); }, [playheadMs, data?.segments.length]);

  function seekTo(startMs: number | null) {
    const node = audioRef.current;
    if (!node || startMs === null) return;
    const target = startMs / 1000;
    const play = () => { void node.play().catch(() => undefined); };
    setPlayheadMs(startMs);
    if (Math.abs(node.currentTime - target) < 0.05) { play(); return; }
    node.addEventListener('seeked', play, { once: true });
    node.currentTime = target;
  }

  async function exportShare(format: 'txt' | 'md' | 'srt' | 'vtt' | 'pdf', scope: 'summary' | 'full' = 'full') {
    const key = `${format}-${scope}`;
    setExporting(key); setExportError('');
    try {
      const response = await fetch(`${apiOrigin}/v1/shares/${encodeURIComponent(token)}/export?format=${format}&scope=${scope}`, { headers: password ? { 'x-share-password': password } : {} });
      if (!response.ok) {
        const payload = await response.json().catch(() => null) as { message?: string } | null;
        throw new Error(payload?.message || tr('导出失败'));
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${data?.title || 'linguaflow'}${scope === 'summary' ? '-summary' : ''}.${format}`;
      document.body.append(anchor); anchor.click(); anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) { setExportError(err instanceof Error ? tr(err.message) : tr('导出失败')); }
    finally { setExporting(''); }
  }

  async function copyCaptions() {
    if (!data) return;
    const text = data.segments.map((segment) => {
      const source = segment.sourceText.trim();
      const translation = segment.translationText.trim();
      const body = view === 'source' ? source : view === 'translation' ? (translation || source) : [translation, source].filter(Boolean).join('\n');
      const who = segment.speaker ? `${segment.speaker}\n` : '';
      return `${who}${body}`;
    }).filter((line) => line.trim()).join('\n\n');
    try { await navigator.clipboard.writeText(text); setNotice(tr('已复制当前字幕。')); }
    catch { setExportError(tr('当前浏览器不允许复制，请手动选择文本。')); }
  }

  const tasks = data?.tasks ?? [];
  const summaryOnly = data?.scope === 'summary';
  const classroom = data?.mode === 'one_way';
  const meta = data ? [
    data.languageA && data.languageB ? `${data.languageA.toUpperCase()} ${data.mode === 'two_way' ? '↔' : '→'} ${data.languageB.toUpperCase()}` : '',
    data.mode ? tr(data.mode === 'two_way' ? '对话模式' : '课堂模式') : '',
    data.createdAt ? formatWhen(data.createdAt) : '',
    typeof data.durationMs === 'number' && data.durationMs > 0 ? formatDurationMs(data.durationMs) : ''
  ].filter(Boolean).join(' · ') : '';

  const exportTools = data ? <div className="share-tools">
    <button type="button" className="secondary-button" disabled={Boolean(exporting)} onClick={() => void exportShare('txt')}>{exporting === 'txt-full' ? tr('导出中…') : 'TXT'}</button>
    <button type="button" className="secondary-button" disabled={Boolean(exporting)} onClick={() => void exportShare('md')}>{exporting === 'md-full' ? tr('导出中…') : tr('导出 Markdown')}</button>
    {!summaryOnly && <button type="button" className="secondary-button" disabled={Boolean(exporting)} onClick={() => void exportShare('srt')}>SRT</button>}
    {!summaryOnly && <button type="button" className="secondary-button" disabled={Boolean(exporting)} onClick={() => void exportShare('vtt')}>VTT</button>}
    {!summaryOnly && <button type="button" className="secondary-button" disabled={Boolean(exporting)} onClick={() => void exportShare('pdf', 'full')}>{exporting === 'pdf-full' ? tr('导出中…') : tr('导出 PDF 全文')}</button>}
    {data.summaryMarkdown && <button type="button" className="secondary-button" disabled={Boolean(exporting)} onClick={() => void exportShare('pdf', 'summary')}>{exporting === 'pdf-summary' ? tr('导出中…') : tr('导出 PDF 纪要')}</button>}
    {data.audioUrl && <a className="secondary-button audio-download" href={`${apiOrigin}${data.audioUrl}&download=1`}>{tr('下载录音')}</a>}
  </div> : null;

  /* Seven export buttons are a wall on a phone, so they collapse behind a summary
     the same way the classroom variant already did. */
  const exportBlock = !exportTools ? null : phone || classroom
    ? <details className="share-export"><summary>{tr('保存')}</summary>{exportTools}</details>
    : exportTools;

  const captionSection = !data || summaryOnly ? null : <section>
    <h2>{tr('字幕')}</h2>
    <div className="caption-toolbar">
      <span>{tr('字幕显示')}</span>
      <button type="button" className={view === 'both' ? 'active' : ''} onClick={() => setView('both')}>{tr('双语')}</button>
      <button type="button" className={view === 'translation' ? 'active' : ''} onClick={() => setView('translation')}>{tr('译文')}</button>
      <button type="button" className={view === 'source' ? 'active' : ''} onClick={() => setView('source')}>{tr('原文')}</button>
      <button type="button" onClick={() => void copyCaptions()}>{tr('复制字幕')}</button>
    </div>
    {data.audioUrl && <audio ref={audioRef} controls src={`${apiOrigin}${data.audioUrl}`} onTimeUpdate={() => setPlayheadMs((audioRef.current?.currentTime ?? 0) * 1000)} onSeeked={() => setPlayheadMs((audioRef.current?.currentTime ?? 0) * 1000)} onEnded={() => setPlayheadMs(null)} />}
    {data.audioUrl && <p className="provider-note">{tr('点击一句字幕，录音会跳到对应时间。')}</p>}
    {data.segments.length === 0 && <p className="share-meta">{tr('这条分享没有字幕。')}</p>}
    {data.segments.map((segment, index) => {
      const nextStart = data.segments.slice(index + 1).map((item) => item.startMs).find((value): value is number => value !== null);
      const end = segment.endMs ?? nextStart ?? null;
      const active = playheadMs !== null && segment.startMs !== null && segment.startMs <= playheadMs && (end === null || playheadMs < end);
      const spoken = (segment.language ?? '').toLowerCase().split('-')[0];
      const right = data.mode === 'two_way' && Boolean(spoken) && spoken === (data.languageB ?? '').toLowerCase().split('-')[0];
      const source = segment.sourceText.trim();
      const translation = segment.translationText.trim();
      const big = view === 'source' ? (source || translation) : (translation || source);
      const small = view === 'both' && translation && source ? source : '';
      const metaLine = [segment.speaker ? `${tr('说话人')} ${segment.speaker}` : '', segment.startMs !== null ? formatClockMs(segment.startMs) : ''].filter(Boolean).join(' · ');
      const body = <>{metaLine && <span className="caption-meta">{metaLine}</span>}<p>{big || '…'}</p>{small && <strong>{small}</strong>}</>;
      if (data.audioUrl && segment.startMs !== null) return <button type="button" data-segment={segment.id} className={`caption-row seekable${active ? ' active' : ''}${right ? ' right' : ''}`} key={segment.id} ref={active ? activeRef : undefined} onClick={() => seekTo(segment.startMs)}>{body}</button>;
      return <article data-segment={segment.id} className={`caption-row${active ? ' active' : ''}${right ? ' right' : ''}`} key={segment.id}>{body}</article>;
    })}
  </section>;

  return <main className="share-page">
    <header className="topbar"><a className="wordmark" href="/"><span className="brand-mark small">L</span><strong>LinguaFlow</strong></a><div className="topbar-actions"><ThemeToggle /><LanguageToggle /></div></header>
    {loading && <p className="share-status" role="status">{tr('正在加载分享…')}</p>}
    {needsPassword && <form className="share-card" onSubmit={(event) => { event.preventDefault(); setPassword(passwordDraft); }}><h1>{tr('分享密码')}</h1><p className="share-meta">{tr('打开这场分享需要密码。')}</p><label>{tr('分享密码')}<input type="password" value={passwordDraft} onChange={(event) => setPasswordDraft(event.target.value)} autoComplete="off" required /></label>{badPassword && <p className="form-message" role="alert">{tr('分享密码不正确。')}</p>}<button className="primary-button" type="submit">{tr('打开')}</button></form>}
    {!needsPassword && error && <p className="form-message share-status" role="alert">{error}</p>}
    {data && <section className="share-card">
      <h1>{data.title}</h1>
      {meta && <p className="share-meta">{meta}</p>}
      {data.expiresAt && <p className="share-meta">{tr('此链接将于 {time} 失效。').replace('{time}', formatWhen(data.expiresAt))}</p>}
      {!classroom && exportBlock}
      {exportError && <p className="form-message" role="alert">{exportError}</p>}
      {notice && <p className="live-notice" role="status">{notice}</p>}
      {classroom && captionSection}
        {data.summaryMarkdown && <section>
        <h2>{tr('纪要')}</h2>
        {tasks.length > 0 && <div className="task-box"><div className="task-head"><strong>{tr('待办')}</strong><button type="button" className="link-button" onClick={() => { void navigator.clipboard.writeText(tasks.map((item) => `- ${item.done ? '[x] ' : ''}${item.text}`).join('\n')).then(() => setNotice(tr('待办已复制。'))).catch(() => setExportError(tr('当前浏览器不允许复制，请手动选择文本。'))); }}>{tr('复制待办')}</button></div>{tasks.map((task) => <label key={task.id}><input type="checkbox" checked={task.done} readOnly /><span>{task.text}</span></label>)}</div>}
        <div className="summary-view">{renderSummary(data.summaryMarkdown, { segments: data.scope === 'summary' ? [] : data.segments, hashes: data.summaryCitationHashes, verified: data.summaryCitationsVerified !== false, onSeek: data.scope === 'summary' ? undefined : (_id, startMs) => seekTo(startMs) })}</div>
      </section>}
      {data.gaps?.length ? <p className="share-meta">{data.gaps.map((gap) => gapCaption(gap)).join(' · ')}</p> : null}
      {!classroom && captionSection}
      {classroom && exportBlock}
    </section>}
  </main>;
}
