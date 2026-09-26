import { useEffect, useRef, useState } from 'react';
import { foldCaptionTurns, type TranscriptToken } from '@linguaflow/shared';
import { apiOrigin } from './lib/api';
import { tr, useLang } from './lib/i18n';
import { LanguageToggle } from './language-toggle';

type LiveMeta = { title: string; mode: string; languageA: string; languageB: string; phase: string; empty?: boolean; websocketUrl?: string; websocketProtocols?: string[] };
type CaptionView = 'both' | 'translation' | 'source';
type CaptionSize = 'sm' | 'md' | 'lg' | 'xl';
type ScreenLock = { release: () => Promise<void> };

const viewKey = 'linguaflow_live_view';
const sizeKey = 'linguaflow_live_size';
const readingQuery = '(max-width: 1099px)';

function storedView(): CaptionView | null {
  try {
    const saved = localStorage.getItem(viewKey);
    return saved === 'both' || saved === 'translation' || saved === 'source' ? saved : null;
  } catch { return null; }
}

function storedSize(): CaptionSize {
  try {
    const saved = localStorage.getItem(sizeKey);
    return saved === 'sm' || saved === 'md' || saved === 'lg' || saved === 'xl' ? saved : 'lg';
  } catch { return 'lg'; }
}

function useReadingLayout() {
  const [reading, setReading] = useState(() => window.matchMedia(readingQuery).matches);
  useEffect(() => {
    const media = window.matchMedia(readingQuery);
    const onChange = () => setReading(media.matches);
    onChange();
    media.addEventListener('change', onChange);
    return () => media.removeEventListener('change', onChange);
  }, []);
  return reading;
}

export function LivePage({ token }: { token: string }) {
  useLang();
  const reading = useReadingLayout();
  const [meta, setMeta] = useState<LiveMeta | null>(null);
  const [error, setError] = useState('');
  const [reconnecting, setReconnecting] = useState(false);
  const [segments, setSegments] = useState<Array<{ source: string; translation: string; speaker?: string; language?: string; interim?: boolean }>>([]);
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});
  const viewChosen = useRef(storedView() !== null);
  const [view, setView] = useState<CaptionView>(() => storedView() ?? 'translation');
  const [size, setSize] = useState<CaptionSize>(storedSize);
  const [fullscreen, setFullscreen] = useState(false);
  const [controlsOpen, setControlsOpen] = useState(false);
  const [showJump, setShowJump] = useState(false);
  const pageRef = useRef<HTMLElement>(null);
  const stackRef = useRef<HTMLDivElement>(null);
  const followLatest = useRef(true);
  const scrolling = useRef(false);

  useEffect(() => {
    if (viewChosen.current || meta?.mode !== 'one_way') return;
    setView('both');
  }, [meta?.mode]);

  useEffect(() => {
    let alive = true;
    let socket: WebSocket | null = null;
    let timer = 0;
    let ignoreClose = false;
    let failures = 0;
    let seenMeta = false;
    const finals: TranscriptToken[] = [];
    const paint = (interim: TranscriptToken[] = []) => { if (alive) setSegments(foldCaptionTurns(finals, interim)); };
    let dead = false;
    const expire = () => {
      if (!alive || dead) return;
      dead = true;
      window.clearTimeout(timer);
      setReconnecting(false);
      setError(tr('分享链接已失效。'));
      const current = socket;
      socket = null;
      current?.close();
    };
    const retry = (delay: number) => {
      if (!alive || dead) return;
      window.clearTimeout(timer);
      setReconnecting(true);
      timer = window.setTimeout(() => void load(), delay);
    };

    async function load() {
      let response: Response;
      try { response = await fetch(`${apiOrigin}/v1/live/${encodeURIComponent(token)}`); }
      catch {
        if (!alive) return;
        if (!seenMeta) { expire(); return; }
        failures += 1;
        if (failures > 5) { expire(); return; }
        retry(1000);
        return;
      }
      if (!alive || dead) return;
      if (!response.ok) {
        if (!seenMeta) { expire(); return; }
        failures += 1;
        if (failures > 5) { expire(); return; }
        retry(1000);
        return;
      }
      const payload = await response.json() as LiveMeta;
      if (payload.phase === 'ended' && !payload.empty) {
        window.location.replace(`/s/${encodeURIComponent(token)}`);
        return;
      }
      seenMeta = true;
      setMeta(payload);
      setError('');
      if (payload.phase === 'waiting') {
        setReconnecting(false);
        window.clearTimeout(timer);
        timer = window.setTimeout(() => void load(), 2000);
      }
      if (payload.phase === 'live' && payload.websocketUrl && !socket) {
        window.clearTimeout(timer);
        if (failures === 0) setReconnecting(false);
        socket = new WebSocket(payload.websocketUrl, payload.websocketProtocols);
        socket.onmessage = (event) => {
          if (!alive) return;
          let data: { type?: string; tokens?: TranscriptToken[]; speakerNames?: Record<string, string>; names?: Record<string, string>; title?: string };
          try { data = JSON.parse(String(event.data)); }
          catch { return; }
          if (data.type === 'snapshot') {
            finals.splice(0, finals.length, ...(data.tokens ?? []).filter((item) => item.text === '<end>' || item.is_final));
            if (data.speakerNames) setSpeakerNames(data.speakerNames);
            if (typeof data.title === 'string') setMeta((current) => current ? { ...current, title: data.title ?? '' } : current);
            paint();
          }
          if (data.type === 'transcript' && data.tokens) {
            const interim: TranscriptToken[] = [];
            for (const item of data.tokens) {
              if (item.text === '<end>' || item.is_final) finals.push(item);
              else interim.push(item);
            }
            paint(interim);
          }
          if (data.type === 'speakers' && data.names) setSpeakerNames(data.names);
          if (data.type === 'title' && typeof data.title === 'string') setMeta((current) => current ? { ...current, title: data.title ?? '' } : current);
          if (data.type === 'finished') { ignoreClose = true; void load(); socket?.close(); }
        };
        socket.onopen = () => { failures = 0; if (alive) setReconnecting(false); };
        socket.onclose = () => {
          socket = null;
          if (!alive || ignoreClose || dead) return;
          failures += 1;
          if (failures > 5) { expire(); return; }
          retry(1000);
        };
      }
    }
    void load();
    return () => { alive = false; window.clearTimeout(timer); socket?.close(); };
  }, [token]);

  useEffect(() => {
    if (meta?.phase !== 'live') return;
    let lock: ScreenLock | null = null;
    let stopped = false;
    const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<ScreenLock> } };
    async function acquire() {
      if (stopped || document.visibilityState !== 'visible' || !nav.wakeLock) return;
      try { lock = await nav.wakeLock.request('screen'); }
      catch { lock = null; }
    }
    const onVisible = () => { if (document.visibilityState === 'visible') void acquire(); };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => undefined);
    };
  }, [meta?.phase]);

  useEffect(() => {
    const onChange = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);

  useEffect(() => {
    if (!reading) { setShowJump(false); return; }
    if (!followLatest.current) return;
    const node = stackRef.current;
    if (!node) return;
    scrolling.current = true;
    node.scrollTop = node.scrollHeight;
    requestAnimationFrame(() => { scrolling.current = false; });
  }, [segments, reading]);

  function onStackScroll() {
    if (!reading || scrolling.current) return;
    const node = stackRef.current;
    if (!node) return;
    const near = node.scrollHeight - node.scrollTop - node.clientHeight < 48;
    followLatest.current = near;
    setShowJump(!near && node.scrollHeight > node.clientHeight);
  }
  function jumpLatest() {
    const node = stackRef.current;
    followLatest.current = true;
    setShowJump(false);
    if (!node) return;
    scrolling.current = true;
    node.scrollTop = node.scrollHeight;
    requestAnimationFrame(() => { scrolling.current = false; });
  }
  function chooseView(next: CaptionView) {
    viewChosen.current = true;
    setView(next);
    try { localStorage.setItem(viewKey, next); } catch { /* Storage can be blocked. */ }
  }
  function chooseSize(next: CaptionSize) {
    setSize(next);
    try { localStorage.setItem(sizeKey, next); } catch { /* Storage can be blocked. */ }
  }
  async function toggleFullscreen() {
    const node = pageRef.current;
    if (!node) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else { await node.requestFullscreen(); setControlsOpen(false); }
  }

  const title = meta?.title?.trim() || tr('这场翻译正在进行');
  const direction = meta ? `${meta.languageA.toUpperCase()} ${meta.mode === 'two_way' ? '↔' : '→'} ${meta.languageB.toUpperCase()}` : '';
  const waitingCopy = meta?.mode === 'two_way' ? tr('等待讲者开始…') : tr('老师还没开始，留在这个页面');
  return <main ref={pageRef} className={`projection-page caption-${size}${reading ? ' is-reading' : ''}${controlsOpen ? ' controls-open' : ''}`}>
    <div className="projection-edge">
      <span>{segments.length ? title : 'LinguaFlow'}</span>
      <span>{direction}</span>
    </div>
    {reconnecting && segments.length > 0 && <p className="projection-status" role="status">{tr('连接中断，正在恢复…')}</p>}
    {error && <p className="projection-error" role="alert">{error}</p>}
    {!meta && !error && <div className="projection-wait" role="status"><i /><em>{tr('正在连接这场翻译…')}</em></div>}
    {meta?.phase === 'ended' && meta.empty && <div className="projection-wait"><strong>{title}</strong><em>{tr('这场翻译已结束，还没有可看的字幕。')}</em></div>}
    {meta && meta.phase !== 'ended' && <section className="projection-stage">
      <div className="projection-stack" ref={stackRef} onScroll={onStackScroll}>
        {segments.length === 0 && <div className="projection-wait" role="status"><strong>{title}</strong><span>{direction}</span><em>{reconnecting ? tr('连接中断，正在恢复…') : meta.phase === 'waiting' ? waitingCopy : tr('正在聆听')}</em></div>}
        {reading && segments.length > 0 && <div className="projection-spacer" />}
        {segments.map((segment, index) => {
          const big = view === 'source' ? (segment.source || segment.translation) : (segment.translation || segment.source);
          const small = view === 'both' && segment.translation && segment.source ? segment.source : '';
          const speakerName = segment.speaker ? speakerNames[segment.speaker] ?? `${tr('说话人')} ${segment.speaker}` : '';
          const current = index === segments.length - 1;
          return <article className={`projection-line${current ? ' current' : ''}${segment.interim ? ' interim' : ''}`} key={segment.interim ? 'live' : `line-${index}`}>
            {speakerName && <span>{speakerName}</span>}
            <p>{big || '…'}</p>
            {small && <small>{small}</small>}
          </article>;
        })}
      </div>
      <button type="button" className="projection-reveal" onClick={() => setControlsOpen((open) => !open)}>{controlsOpen ? tr('收起') : tr('控制')}</button>
    </section>}
    {reading && showJump && <button type="button" className="projection-jump" onClick={jumpLatest}>{tr('回到最新')}</button>}
    {controlsOpen && <div className="projection-drawer">
      <div className="projection-control-group" role="group" aria-label={tr('字幕显示')}>
        <button type="button" className={view === 'translation' ? 'active' : ''} onClick={() => chooseView('translation')}>{tr('译文')}</button>
        <button type="button" className={view === 'both' ? 'active' : ''} onClick={() => chooseView('both')}>{tr('双语')}</button>
        <button type="button" className={view === 'source' ? 'active' : ''} onClick={() => chooseView('source')}>{tr('原文')}</button>
      </div>
      <div className="projection-control-group" role="group" aria-label={tr('字号')}>
        <button type="button" aria-label={tr('小')} className={size === 'sm' ? 'active' : ''} onClick={() => chooseSize('sm')}>A</button>
        <button type="button" aria-label={tr('中')} className={`size-md${size === 'md' ? ' active' : ''}`} onClick={() => chooseSize('md')}>A</button>
        <button type="button" aria-label={tr('大')} className={`size-lg${size === 'lg' ? ' active' : ''}`} onClick={() => chooseSize('lg')}>A</button>
        <button type="button" aria-label={tr('特大')} className={`size-xl${size === 'xl' ? ' active' : ''}`} onClick={() => chooseSize('xl')}>A</button>
      </div>
      <button type="button" onClick={() => void toggleFullscreen()}>{fullscreen ? tr('退出全屏') : tr('全屏')}</button>
      <LanguageToggle className="projection-lang" />
    </div>}
  </main>;
}
