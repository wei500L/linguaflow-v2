import { StrictMode, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { acceptLiveEvent, createCaptionFold, ingestCaptionTokens, projectCaptionTurns, PLANS, reconnectDelayMs, reconnectExhausted, type Entitlement, type RealtimeEvent, type TranscriptToken } from '@linguaflow/shared';
import { api, ApiError, clearToken, getToken, isTokenExpired, openSocket, setToken, tokenExpiresWithin } from './lib/api';
import { shouldRefreshAccessToken } from './lib/session';
import { PHONE_QUERY, useMediaQuery, useViewportHeight } from './lib/breakpoints';
import { createPcmStream, listAudioInputs, trimQueuedAudio, type AudioSource } from './lib/audio';
import { VoiceBoost } from './lib/voice-boost';
import { languageNative } from './lib/glossary';
import { lockProgrammaticScroll, nudgeToBottom } from './lib/follow-scroll';
import { InvitePanel } from './invite-panel';
import { captureInvite } from './lib/invite';
import { getLang, tr, useLang } from './lib/i18n';
import { alignSentAudio, commitSentChunk, createLatencyClock, emptyLatencySamples, latencySampleProps, observeTranscript, pushLatencySample, readLatency, sameReadout, stampChunk, startMeasuring, type LatencyClock, type LatencyReadout } from './lib/latency';
import { CourseBar } from './course-bar';
import { HelpPage } from './help-page';
import { LegalPage, MarketingPage } from './marketing';
import { SharePage } from './share-page';
import { TranscriptPanel } from './transcript-panel';
import { FirstRun } from './first-run';
import { LivePage } from './live-page';
import { Topbar, type Panel, type ServiceStatus } from './workspace-topbar';
import { CaptionStage, CaptionToolbar, type CaptionView, type Segment, type SessionStatus } from './caption-stage';
import { ControlDock } from './control-dock';
import { LatencyBadge } from './latency-badge';
import { SessionNotices, type Notice } from './session-notices';
import './styles.css';

import { AccountPanel } from './account-panel';
import { AdminPanel } from './admin-panel';
import { AuthScreen } from './auth-screen';
import { formatRemain, usableSeconds } from './format';
import { GlossaryPanel, type Glossary } from './glossary-panel';
import { PricingPanel } from './pricing-panel';


type Profile = { id: string; email: string; displayName?: string | null; role: string };

const CAPTION_PAGE = 80;
const NO_LATENCY: LatencyReadout = { recognition: null, translation: null };
const SESSION_PATH = /^\/session\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?$/i;
type ActiveSession = { id: string; mode: 'one_way' | 'two_way'; status: string; title: string | null; languageA: string; languageB: string | null; targetLanguage: string | null };
type SessionLink = ActiveSession & { endedAt: string | null; transcriptId: string | null };

function sessionIdFromPath(path: string) {
  return path.match(SESSION_PATH)?.[1] ?? null;
}

function App() {
  useLang();
  useViewportHeight();
  const inviteCaptured = useRef(false);
  if (!inviteCaptured.current) { inviteCaptured.current = true; captureInvite(); }
  const phone = useMediaQuery(PHONE_QUERY);
  const [authenticated, setAuthenticated] = useState(Boolean(getToken()) && !isTokenExpired());
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null); const [panel, setPanel] = useState<Panel>('none');
  const [mode, setMode] = useState<'one_way' | 'two_way'>('one_way');
  const [languageA, setLanguageA] = useState(() => localStorage.getItem('linguaflow_lang_a') || 'ru'); const [languageB, setLanguageB] = useState(() => localStorage.getItem('linguaflow_lang_b') || 'zh');
  const [glossaryId, setGlossaryId] = useState(() => localStorage.getItem('linguaflow_glossary') || ''); const [glossaryChoices, setGlossaryChoices] = useState<Glossary[]>([]);
  const [languages, setLanguages] = useState<Array<{ code: string; nativeName: string; englishName: string }>>([]);
  const [audioSource, setAudioSource] = useState<AudioSource>('microphone'); const [recordAudio, setRecordAudio] = useState(() => localStorage.getItem('linguaflow_record_audio') !== '0'); const [voiceBoost, setVoiceBoost] = useState(() => localStorage.getItem('linguaflow_voice_boost') === '1'); const voiceBoostOn = useRef(voiceBoost); const [booster] = useState(() => new VoiceBoost()); const [dockOpen, setDockOpen] = useState(false); const [captionOpen, setCaptionOpen] = useState(false); const [showJump, setShowJump] = useState(false); const stageRef = useRef<HTMLDivElement>(null); const followLatest = useRef(true); const scrolling = useRef(false); const captionFold = useRef(createCaptionFold()); const captionLimitRef = useRef(CAPTION_PAGE); const windowEndRef = useRef(0); const scrollAnchor = useRef(0);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('idle'); const [serviceStatus, setServiceStatus] = useState<ServiceStatus>('checking'); const [segments, setSegments] = useState<Segment[]>([]); const [error, setError] = useState(''); const [recovery, setRecovery] = useState<null | 'quota' | 'device'>(null);
  function showProblem(message: string, next: null | 'quota' | 'device' = null) { setRecovery(message ? next : null); setError(message); }
  const [remainingSeconds, setRemainingSeconds] = useState<number | null>(null); const [endedTranscriptId, setEndedTranscriptId] = useState<string | null>(null); const [focusTranscriptId, setFocusTranscriptId] = useState<string | null>(null);
  const [recordAck, setRecordAck] = useState(() => localStorage.getItem('linguaflow_record_ack') === '1');
  const [conflictSession, setConflictSession] = useState<ActiveSession | null>(null); const [routeEnded, setRouteEnded] = useState<{ id: string; transcriptId: string | null } | null>(null); const [captionLimit, setCaptionLimit] = useState(CAPTION_PAGE); const [windowEnd, setWindowEnd] = useState(0); const [paused, setPaused] = useState(false); const pausedRef = useRef(false);
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const sync = () => setPath(window.location.pathname);
    window.addEventListener('popstate', sync);
    return () => window.removeEventListener('popstate', sync);
  }, []);
  function replacePath(next: string) {
    if (window.location.pathname !== next) window.history.replaceState({ linguaflow: next }, '', next);
    setPath(next);
  }
  const [captionSize, setCaptionSize] = useState(() => localStorage.getItem('linguaflow_caption_size') || 'md'); const [glossaryDropped, setGlossaryDropped] = useState(0); const [glossaryDroppedTerms, setGlossaryDroppedTerms] = useState<string[]>([]); const [glossaryUsed, setGlossaryUsed] = useState(0); const [glossaryAligned, setGlossaryAligned] = useState(true); const [fullscreen, setFullscreen] = useState(false);
  const [sessionTitle, setSessionTitle] = useState(''); const [closePrompt, setClosePrompt] = useState(false); const [liveSessionId, setLiveSessionId] = useState<string | null>(null);
  const [showGuide, setShowGuide] = useState(() => localStorage.getItem('linguaflow_seen_guide') !== '1'); const [captionView, setCaptionView] = useState<CaptionView>(() => { const saved = localStorage.getItem('linguaflow_caption_view'); return saved === 'translation' || saved === 'source' ? saved : 'both'; });
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({}); const [namingSpeaker, setNamingSpeaker] = useState<string | null>(null); const [speakerDraft, setSpeakerDraft] = useState('');
  const [mics, setMics] = useState<Array<{ id: string; label: string }>>([]); const [micId, setMicId] = useState(() => localStorage.getItem('linguaflow_mic') || ''); const [liveNotice, setLiveNotice] = useState(''); const [savedNote, setSavedNote] = useState(''); const [savedThrough, setSavedThrough] = useState<string | null>(null); const [saveState, setSaveState] = useState<'saved' | 'failed' | 'pending'>('pending'); const [liveGaps, setLiveGaps] = useState<string[]>([]);
  const [audioStalled, setAudioStalled] = useState(false); const sessionReady = useRef(false);
  const acceptAudio = useRef(false); const userStop = useRef(false); const recoverLock = useRef(false); const readyWait = useRef<((ok: boolean) => void) | null>(null); const speakerNamesRef = useRef<Record<string, string>>({}); const closeTitleRef = useRef('');
  const limitSeconds = useRef<number | null>(null); const readyAt = useRef<number | null>(null); const savedTranscriptId = useRef<string | null>(null); const finishOutcome = useRef<string | null>(null); const stopLock = useRef<Promise<void> | null>(null);
  const statusRef = useRef<SessionStatus>('idle'); const generation = useRef(0); const authToken = useRef(getToken()); const sessionId = useRef<string | null>(null); const socket = useRef<WebSocket | null>(null); const audio = useRef<{ stop: () => Promise<void> } | null>(null); const keepalive = useRef<number | null>(null); const startupTimer = useRef<number | null>(null); const drain = useRef<(() => void) | null>(null); const upstreamDone = useRef(false); const audioQueue = useRef<Array<{ pcm: ArrayBuffer; durationMs: number; capturedAt: number }>>([]); const latencyClock = useRef<LatencyClock>(createLatencyClock()); const latencySamples = useRef(emptyLatencySamples()); const [latency, setLatency] = useState<LatencyReadout>(NO_LATENCY);
  const running = sessionStatus === 'running'; const busySession = sessionStatus !== 'idle';
  function updateSessionStatus(next: SessionStatus) { statusRef.current = next; setSessionStatus(next); }
  useEffect(() => { const expire = () => { void stop(); clearToken(); setAuthenticated(false); }; window.addEventListener('linguaflow:auth-expired', expire); const timer = window.setInterval(() => { if (getToken() && isTokenExpired()) expire(); }, 30_000); return () => { window.removeEventListener('linguaflow:auth-expired', expire); window.clearInterval(timer); }; }, []);
  useEffect(() => { let alive = true; async function check() { try { const response = await fetch((import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3000' : '')) + '/health'); if (alive) setServiceStatus(response.ok ? 'online' : 'offline'); } catch { if (alive) setServiceStatus('offline'); } } void check(); const timer = window.setInterval(() => void check(), 30_000); return () => { alive = false; window.clearInterval(timer); }; }, []);

  useEffect(() => { document.documentElement.lang = getLang() === 'en' ? 'en' : 'zh-CN'; document.title = getLang() === 'en' ? 'LinguaFlow · Live Translation' : 'LinguaFlow · 实时双语翻译'; if (authenticated) { api<Entitlement>('/v1/me/entitlement').then(setEntitlement).catch((error) => { if (error instanceof ApiError && error.status === 401) setAuthenticated(false); }); api<Profile>('/v1/me/profile').then(setProfile).catch(() => undefined); api<Array<{ code: string; nativeName: string; englishName: string }>>('/v1/me/languages').then((items) => { setLanguages(items); if (!items.some((item) => item.code === languageA)) setLanguageA(items[0]?.code ?? 'zh'); if (!items.some((item) => item.code === languageB)) setLanguageB(items[1]?.code ?? items[0]?.code ?? 'en'); }).catch(() => undefined); } }, [authenticated]);
  useEffect(() => { authToken.current = getToken(); }, [authenticated]);
  useEffect(() => { localStorage.setItem('linguaflow_lang_a', languageA); localStorage.setItem('linguaflow_lang_b', languageB); }, [languageA, languageB]);
  useEffect(() => { localStorage.setItem('linguaflow_record_audio', recordAudio ? '1' : '0'); }, [recordAudio]);
  useEffect(() => { voiceBoostOn.current = voiceBoost; localStorage.setItem('linguaflow_voice_boost', voiceBoost ? '1' : '0'); }, [voiceBoost]);
  useEffect(() => { localStorage.setItem('linguaflow_glossary', glossaryId); }, [glossaryId]);
  useEffect(() => { localStorage.setItem('linguaflow_caption_size', captionSize); }, [captionSize]);
  useEffect(() => { localStorage.setItem('linguaflow_caption_view', captionView); }, [captionView]);
  useEffect(() => {
    if (sessionStatus !== 'running' && sessionStatus !== 'reconnecting') return;
    const handle = window.setTimeout(() => {
      const title = sessionTitle.trim().slice(0, 120);
      if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'title', title }));
    }, 400);
    return () => window.clearTimeout(handle);
  }, [sessionTitle, sessionStatus]);
  useEffect(() => { localStorage.setItem('linguaflow_mic', micId); }, [micId]);
  /* A phone that dims its screen also suspends the mic, so keep it awake while a
     session is live. The lock drops whenever the tab hides and is retaken on return. */
  const sessionLive = sessionStatus === 'running' || sessionStatus === 'reconnecting';
  useEffect(() => {
    if (!sessionLive) return;
    type ScreenLock = { release: () => Promise<void>; addEventListener?: (type: 'release', listener: () => void) => void };
    const nav = navigator as Navigator & { wakeLock?: { request: (type: 'screen') => Promise<ScreenLock> } };
    let lock: ScreenLock | null = null;
    let stopped = false;
    async function acquire() {
      if (stopped || lock || document.visibilityState !== 'visible' || !nav.wakeLock) return;
      try {
        const next = await nav.wakeLock.request('screen');
        if (stopped) { void next.release().catch(() => undefined); return; }
        lock = next;
        next.addEventListener?.('release', () => { if (lock === next) lock = null; });
      } catch { lock = null; }
    }
    const onVisible = () => { if (document.visibilityState === 'visible') void acquire(); };
    void acquire();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      document.removeEventListener('visibilitychange', onVisible);
      void lock?.release().catch(() => undefined);
      lock = null;
    };
  }, [sessionLive]);
  useEffect(() => { if (!authenticated) return; void listAudioInputs().then(setMics).catch(() => undefined); }, [authenticated, dockOpen, sessionStatus]);
  useEffect(() => { const onChange = () => setFullscreen(Boolean(document.fullscreenElement)); document.addEventListener('fullscreenchange', onChange); return () => document.removeEventListener('fullscreenchange', onChange); }, []);
  useEffect(() => { if (!authenticated) return; let alive = true; api<{ session: ActiveSession | null }>('/v1/realtime/sessions/active').then((result) => { if (alive && result.session && statusRef.current === 'idle') setConflictSession(result.session); }).catch(() => undefined); return () => { alive = false; }; }, [authenticated]);
  useEffect(() => {
    const id = sessionIdFromPath(path);
    if (!id) { setRouteEnded(null); return; }
    if (!authenticated || statusRef.current !== 'idle' || sessionId.current) return;
    let alive = true;
    api<{ session: SessionLink }>(`/v1/realtime/sessions/${id}`).then((result) => {
      if (!alive || statusRef.current !== 'idle' || sessionId.current) return;
      const session = result.session;
      if (session.endedAt) {
        setRouteEnded({ id: session.id, transcriptId: session.transcriptId });
        setConflictSession((current) => current?.id === session.id ? null : current);
        return;
      }
      setRouteEnded(null);
      const active: ActiveSession = { id: session.id, mode: session.mode === 'two_way' ? 'two_way' : 'one_way', status: session.status, title: session.title, languageA: session.languageA, languageB: session.languageB, targetLanguage: session.targetLanguage };
      setConflictSession(active);
      applyActiveSession(active);
    }).catch((err) => {
      if (!alive || statusRef.current !== 'idle') return;
      if (err instanceof ApiError && err.status === 404) {
        setRouteEnded(null);
        showProblem(tr('找不到这场翻译。'));
        replacePath('/');
      }
    });
    return () => { alive = false; };
  }, [authenticated, path]);
  useEffect(() => {
    if (!authenticated || !glossaryId) { setGlossaryDropped(0); setGlossaryDroppedTerms([]); setGlossaryUsed(0); setGlossaryAligned(true); return; }
    const params = new URLSearchParams({ type: mode, languageA });
    if (mode === 'one_way') params.set('targetLanguage', languageB); else params.set('languageB', languageB);
    let alive = true;
    api<{ used?: number; dropped: number; droppedTerms?: string[]; aligned?: boolean }>(`/v1/me/glossaries/${glossaryId}/coverage?${params}`).then((result) => { if (alive) { setGlossaryUsed(result.used ?? 0); setGlossaryDropped(result.dropped); setGlossaryDroppedTerms(result.droppedTerms ?? []); setGlossaryAligned(result.aligned !== false); } }).catch(() => { if (alive) { setGlossaryDropped(0); setGlossaryDroppedTerms([]); setGlossaryUsed(0); setGlossaryAligned(true); } });
    return () => { alive = false; };
  }, [authenticated, glossaryId, mode, languageA, languageB]);
  useEffect(() => {
    if (!shouldRefreshAccessToken(sessionStatus === 'running', true)) return;
    const timer = window.setInterval(() => {
      if (!shouldRefreshAccessToken(true, tokenExpiresWithin(2 * 60 * 60 * 1000))) return;
      void api<{ token: string }>('/v1/auth/refresh', { method: 'POST' }).then((result) => setToken(result.token)).catch(() => undefined);
    }, 60_000);
    return () => window.clearInterval(timer);
  }, [sessionStatus]);
  useEffect(() => {
    if (sessionStatus !== 'running') return;
    const tick = () => {
      const limit = limitSeconds.current;
      const started = readyAt.current;
      if (limit === null || started === null) return;
      setRemainingSeconds(Math.max(0, limit - Math.floor((Date.now() - started) / 1000)));
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [sessionStatus]);
  /* Results arrive several times a second. The badge reads the clock at a steady rate so it can also rise during a stall. */
  useEffect(() => {
    if (!sessionLive) return;
    const tick = () => {
      const next = readLatency(latencyClock.current, performance.now(), !paused && !audioStalled);
      pushLatencySample(latencySamples.current, next);
      setLatency((current) => sameReadout(current, next) ? current : next);
    };
    tick();
    const timer = window.setInterval(tick, 250);
    return () => window.clearInterval(timer);
  }, [sessionLive, paused, audioStalled]);
  useEffect(() => { if (!authenticated) return; let alive = true; api<Glossary[]>('/v1/me/glossaries').then((rows) => { if (!alive) return; setGlossaryChoices(rows); if (glossaryId && !rows.some((row) => row.id === glossaryId)) setGlossaryId(''); }).catch(() => undefined); return () => { alive = false; }; }, [authenticated, panel]);
  function rememberCaptionLimit(next: number) {
    captionLimitRef.current = next;
    setCaptionLimit(next);
  }
  function publishCaptions(interim: TranscriptToken[] = [], pinToEnd = followLatest.current) {
    const next = projectCaptionTurns(captionFold.current, interim);
    if (pinToEnd) {
      windowEndRef.current = next.length;
      setWindowEnd(next.length);
    }
    setSegments(next);
  }
  function showEarlierCaptions() {
    const end = Math.min(windowEndRef.current, segments.length);
    if (end <= captionLimitRef.current) return;
    followLatest.current = false;
    setShowJump(true);
    const el = stageRef.current;
    if (el) scrollAnchor.current = el.scrollHeight;
    rememberCaptionLimit(Math.min(end, captionLimitRef.current + CAPTION_PAGE));
  }
  useLayoutEffect(() => {
    const el = stageRef.current;
    if (!el) return;
    if (followLatest.current) {
      scrollAnchor.current = 0;
      nudgeToBottom(el, scrolling);
      return;
    }
    const before = scrollAnchor.current;
    if (!before) return;
    scrollAnchor.current = 0;
    const delta = el.scrollHeight - before;
    if (delta <= 0) return;
    scrolling.current = true;
    el.scrollTop += delta;
    lockProgrammaticScroll(scrolling);
  }, [segments, captionLimit, windowEnd, sessionStatus, dockOpen]);
  function onStageScroll() {
    if (scrolling.current) return;
    const el = stageRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const next = distance < 48;
    followLatest.current = next;
    setShowJump(!next && el.scrollHeight > el.clientHeight);
    if (next) {
      if (captionLimitRef.current !== CAPTION_PAGE) rememberCaptionLimit(CAPTION_PAGE);
      if (windowEndRef.current !== segments.length) {
        windowEndRef.current = segments.length;
        setWindowEnd(segments.length);
      }
      return;
    }
    if (el.scrollTop < 72 && el.scrollHeight > el.clientHeight + 8) showEarlierCaptions();
  }
  function jumpLatest() {
    followLatest.current = true;
    setShowJump(false);
    windowEndRef.current = segments.length;
    setWindowEnd(segments.length);
    if (captionLimitRef.current !== CAPTION_PAGE) rememberCaptionLimit(CAPTION_PAGE);
    const el = stageRef.current;
    if (!el) return;
    nudgeToBottom(el, scrolling);
  }
  const currentLabel = useMemo(() => mode === 'one_way' ? `${languageA.toUpperCase()} → ${languageB.toUpperCase()}` : `${languageA.toUpperCase()} ↔ ${languageB.toUpperCase()}`, [mode, languageA, languageB]);
  const activeGlossary = glossaryChoices.find((item) => item.id === glossaryId) ?? null;
  const glossaryPairLabel = activeGlossary ? `${languageNative(activeGlossary.languageA)} → ${languageNative(activeGlossary.languageB)}` : '';
  const sessionPairLabel = `${languageNative(languageA)} ${mode === 'one_way' ? '→' : '↔'} ${languageNative(languageB)}`;

  function consumeTokens(tokens: TranscriptToken[]) {
    const interim: TranscriptToken[] = [];
    const finals: TranscriptToken[] = [];
    for (const token of tokens) {
      if (token.text === '<end>' || token.is_final) finals.push(token);
      else interim.push(token);
    }
    if (finals.length) ingestCaptionTokens(captionFold.current, finals);
    publishCaptions(interim);
  }

  const sameLanguage = languageA.toLowerCase().split('-')[0] === languageB.toLowerCase().split('-')[0];
  function pumpAudio(socket: WebSocket | null) {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    while (audioQueue.current.length && socket.bufferedAmount < 262_144) {
      const next = audioQueue.current.shift();
      if (!next) continue;
      socket.send(next.pcm);
      sentAudioMs.current += next.durationMs;
      commitSentChunk(latencyClock.current, next);
    }
  }
  async function flushQueuedAudio(socket: WebSocket | null) {
    const started = Date.now();
    while (socket && socket.readyState === WebSocket.OPEN && audioQueue.current.length && Date.now() - started < 2_000) {
      pumpAudio(socket);
      if (!audioQueue.current.length) return;
      await new Promise((resolve) => window.setTimeout(resolve, 40));
    }
  }
  function sendChunk(chunk: ArrayBuffer, capturedAt = performance.now()) {
    /* Keep the filter and the noise floor in step with the mic while paused.
       Dropping the chunk first left a stale filter, which thumped on resume. */
    const pcm = booster.process(chunk, voiceBoostOn.current);
    if (pausedRef.current) return;
    const stamped = stampChunk(pcm.byteLength, capturedAt);
    audioQueue.current.push({ pcm, ...stamped });
    const queuedBefore = audioQueue.current.reduce((sum, item) => sum + item.durationMs, 0);
    trimQueuedAudio(audioQueue.current);
    const droppedMs = queuedBefore - audioQueue.current.reduce((sum, item) => sum + item.durationMs, 0);
    const audioAt = sentAudioMs.current;
    if (droppedMs > 0) sendControl({ type: 'gap', id: crypto.randomUUID(), source: 'queue_overflow', wallStartMs: wallClock(), wallEndMs: wallClock(), audioStartMs: audioAt, audioEndMs: audioAt + droppedMs, precision: 'estimated' });
    if (acceptAudio.current) pumpAudio(socket.current);
  }
  function bindSocket(ws: WebSocket) {
    socket.current = ws;
    ws.onmessage = (event) => {
      if (socket.current !== ws) return;
      try {
        const data = JSON.parse(event.data) as RealtimeEvent;
        if (!acceptLiveEvent({ currentSocket: true, userStop: userStop.current, type: data.type })) return;
        if (data.type === 'save_status') {
          setSavedThrough(data.savedThrough);
          setSaveState(data.status);
          if (data.status === 'failed') showProblem(tr('字幕暂时没能保存。请结束这次翻译，已收到的内容会按最后一次成功保存处理。'));
          return;
        }
        if (data.type === 'marker_ack' || data.type === 'gap_ack') {
          const label = controlLabels.current.get(data.id);
          controlLabels.current.delete(data.id);
          if (data.type === 'gap_ack' && data.ok && label) setLiveGaps((current) => current.includes(label) ? current : [...current, label]);
          setLiveNotice(data.ok ? (data.type === 'marker_ack' ? tr('标记已保存。') : tr('缺口已记录。')) : tr('没有保存成功，请再试一次。'));
          return;
        }
        if (data.type === 'ready') {
          if (wallOrigin.current == null) wallOrigin.current = Date.now();
          if (typeof data.allowedSeconds === 'number') { limitSeconds.current = data.allowedSeconds; readyAt.current = Date.now(); }
          if (typeof data.receivedAudioMs === 'number') alignSentAudio(latencyClock.current, data.receivedAudioMs);
          if (!sessionReady.current) startMeasuring(latencyClock.current, performance.now());
          sessionReady.current = true;
          acceptAudio.current = true;
          const queued = pendingControls.current.splice(0);
          for (const item of queued) ws.send(JSON.stringify(item));
          pumpAudio(ws);
          if (keepalive.current !== null) window.clearInterval(keepalive.current);
          keepalive.current = window.setInterval(() => { if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'keepalive' })); }, 10_000);
          if (startupTimer.current !== null) window.clearTimeout(startupTimer.current); startupTimer.current = null;
          showProblem('');
          updateSessionStatus('running');
          readyWait.current?.(true);
          readyWait.current = null;
        }
        if (data.type === 'snapshot') {
          captionFold.current = createCaptionFold();
          ingestCaptionTokens(captionFold.current, data.tokens);
          if (data.speakerNames) { speakerNamesRef.current = data.speakerNames; setSpeakerNames(data.speakerNames); }
          followLatest.current = true;
          publishCaptions([], true);
        }
        if (data.type === 'transcript') {
          if (data.tokens.length) consumeTokens(data.tokens);
          observeTranscript(latencyClock.current, data, performance.now());
        }
        if (data.type === 'error') { showProblem(data.code === 'quota_exhausted' ? tr('额度已用完，本次会话已结束。') : data.code === 'session_limit_reached' ? tr('单次时长已到，本次会话已结束。') : data.message ?? data.code, data.code === 'quota_exhausted' ? 'quota' : null); if (data.code === 'quota_exhausted' || data.code === 'session_limit_reached') void stop(); else { releaseUpstream(); void stop({ alreadyFinished: true }); } }
        if (data.type === 'finished') {
          const expired = data.reason === 'expired';
          finishOutcome.current = data.outcome ?? null;
          if (data.transcriptId) savedTranscriptId.current = data.transcriptId;
          if (expired && data.transcriptId) setSavedNote(tr('长时间没有活动，这场翻译已结束。'));
          else if (expired) showProblem(tr('长时间没有活动，这场翻译已结束。'));
          releaseUpstream();
          if (!userStop.current) void stop({ alreadyFinished: true });
        }
      } catch { showProblem(tr('收到无法识别的实时消息。')); releaseUpstream(); void stop({ alreadyFinished: true }); }
    };
    ws.onerror = () => { if (socket.current === ws && sessionReady.current && !userStop.current) showProblem(tr('连接中断，正在恢复…')); };
    ws.onclose = (event) => {
      if (socket.current !== ws) return;
      readyWait.current?.(false);
      readyWait.current = null;
      if (userStop.current || statusRef.current === 'stopping' || statusRef.current === 'idle') return;
      if (upstreamDone.current) { void stop({ alreadyFinished: true }); return; }
      /* Nothing to resume if the very first connection never got ready. Retrying
         it as a dropped session only hid the real cause behind "reconnecting". */
      if (!sessionReady.current && statusRef.current === 'connecting') {
        showProblem(!navigator.onLine ? tr('手机没有联网，请检查网络后重试。') : event.code === 1008 ? tr('翻译服务拒绝了这次连接，请重新开始。') : tr('实时连接失败，请检查网络后重试。'));
        releaseUpstream();
        void stop({ alreadyFinished: true });
        return;
      }
      if (!recoverLock.current) void recover();
    };
  }
  async function recover() {
    if (recoverLock.current || userStop.current) return;
    const current = sessionId.current;
    if (!current) return;
    recoverLock.current = true;
    acceptAudio.current = false;
    updateSessionStatus('reconnecting');
    showProblem(tr('连接中断，正在恢复…'));
    let restored = false;
    const started = Date.now();
    let attempt = 0;
    const online = new Promise<void>((resolve) => {
      const listener = () => { window.removeEventListener('online', listener); resolve(); };
      window.addEventListener('online', listener);
    });
    while (!userStop.current && !reconnectExhausted(started, Date.now())) {
      try {
        const session = await api<{ websocketUrl: string; websocketProtocols: string[] }>(`/v1/realtime/sessions/${current}/reconnect`, { method: 'POST' });
        if (userStop.current) break;
        const opened = new Promise<boolean>((resolve) => {
          const timer = window.setTimeout(() => resolve(false), 4_000);
          readyWait.current = (ok) => { window.clearTimeout(timer); resolve(ok); };
        });
        bindSocket(openSocket(session.websocketUrl, session.websocketProtocols));
        restored = await Promise.race([opened, online.then(() => false)]);
        if (restored) break;
      } catch (err) {
        readyWait.current = null;
        if (err instanceof ApiError && (err.status === 404 || err.status === 409)) break;
      }
      await new Promise((resolve) => window.setTimeout(resolve, reconnectDelayMs(attempt)));
      attempt += 1;
    }
    if (!restored && !userStop.current && statusRef.current !== 'idle' && statusRef.current !== 'stopping' && statusRef.current !== 'saving') {
      userStop.current = true;
      recoverLock.current = false;
      showProblem(tr('无法恢复连接，会话已结束。'));
      releaseUpstream();
      void stop({ alreadyFinished: true });
      return;
    }
    recoverLock.current = false;
  }
  async function ensureAudio(gen: number) {
    if (audio.current) return true;
    booster.reset();
    const stream = await createPcmStream(sendChunk, audioSource, () => { if (generation.current === gen) { showProblem(tr('音频来源已结束，会话已停止。')); void stop(); } }, audioSource === 'microphone' ? micId || undefined : undefined, (stalled) => { if (generation.current === gen) setAudioStalled(stalled); });
    if (generation.current !== gen) { await stream.stop(); return false; }
    audio.current = stream;
    void listAudioInputs().then(setMics).catch(() => undefined);
    return true;
  }
  async function start(course?: { id: string; mode: 'one_way' | 'two_way'; languageA: string; languageB: string; glossaryId?: string | null; recordAudio: boolean; title?: string | null }) {
    if (statusRef.current !== 'idle') return;
    const nextMode = course?.mode ?? mode;
    const nextA = course?.languageA ?? languageA;
    const nextB = course?.languageB ?? languageB;
    const nextRecord = course?.recordAudio ?? recordAudio;
    const nextGlossary = course ? (course.glossaryId ?? '') : glossaryId;
    if (nextA.toLowerCase().split('-')[0] === nextB.toLowerCase().split('-')[0]) { showProblem(tr('源语言和目标语言不能相同。')); return; }
    if (course) { setMode(nextMode); setLanguageA(nextA); setLanguageB(nextB); setRecordAudio(nextRecord); setGlossaryId(nextGlossary); if (course.title) setSessionTitle(course.title); }
    const id = ++generation.current;
    userStop.current = false;
    acceptAudio.current = false;
    sessionReady.current = false;
    setAudioStalled(false);
    speakerNamesRef.current = {};
    setSpeakerNames({}); setNamingSpeaker(null); setLiveNotice(''); setClosePrompt(false); closeTitleRef.current = sessionTitle.trim().slice(0, 120);
    showProblem(''); setSavedNote(''); setSegments([]); setDockOpen(false); setShowJump(false); setEndedTranscriptId(null); setRemainingSeconds(null); setPaused(false); pausedRef.current = false; setConflictSession(null); followLatest.current = true; captionFold.current = createCaptionFold(); windowEndRef.current = 0; setWindowEnd(0); if (captionLimitRef.current !== CAPTION_PAGE) rememberCaptionLimit(CAPTION_PAGE); upstreamDone.current = false; audioQueue.current = []; latencyClock.current = createLatencyClock(); setLatency(NO_LATENCY); savedTranscriptId.current = null; limitSeconds.current = null; readyAt.current = null; wallOrigin.current = null; sentAudioMs.current = 0; pendingControls.current = []; latencySamples.current = emptyLatencySamples(); setLiveGaps([]);
    updateSessionStatus('opening');
    try {
      if (!await ensureAudio(id)) return;
      updateSessionStatus('connecting');
      startupTimer.current = window.setTimeout(() => { if (generation.current === id && (statusRef.current === 'connecting' || statusRef.current === 'opening')) { showProblem(tr('连接超时，请重试。')); void stop(); } }, 15_000);
      const glossary = nextGlossary ? { glossaryId: nextGlossary } : {};
      const named = (course?.title || sessionTitle).trim().slice(0, 120);
      const title = named ? { title: named } : {};
      const courseField = course ? { courseId: course.id } : {};
      const session = await api<{ sessionId: string; websocketUrl: string; websocketProtocols: string[] }>('/v1/realtime/sessions', { method: 'POST', body: JSON.stringify(nextMode === 'one_way' ? { type: 'one_way', languageA: nextA, targetLanguage: nextB, recordAudio: nextRecord, shareIntent: 'personal', ...glossary, ...title, ...courseField } : { type: 'two_way', languageA: nextA, languageB: nextB, recordAudio: nextRecord, shareIntent: 'personal', ...glossary, ...title, ...courseField }) });
      if (generation.current !== id) { setLiveSessionId(null); void api(`/v1/realtime/sessions/${session.sessionId}`, { method: 'DELETE', headers: authToken.current ? { authorization: `Bearer ${authToken.current}` } : undefined }).catch(() => undefined); return; }
      sessionId.current = session.sessionId;
      setLiveSessionId(session.sessionId);
      setRouteEnded(null);
      replacePath(`/session/${session.sessionId}`);
      bindSocket(openSocket(session.websocketUrl, session.websocketProtocols));
    } catch (err) {
      if (generation.current !== id) return;
      const cause = err as DOMException;
      if (err instanceof ApiError && err.code === 'session_conflict') { showProblem(tr('上一场翻译还在占用额度。')); const fallbackId = err.sessionId ?? null; if (fallbackId) setConflictSession({ id: fallbackId, mode, status: 'active', title: null, languageA: '', languageB: null, targetLanguage: null }); void api<{ session: ActiveSession | null }>('/v1/realtime/sessions/active').then((result) => { if (statusRef.current !== 'idle' || sessionId.current) return; if (result.session) setConflictSession(result.session); }).catch(() => undefined); }
      else if (err instanceof ApiError && err.code === 'quota_exhausted') showProblem(tr('额度已用完，无法开始新的翻译。'), 'quota');
      else if (err instanceof ApiError && err.code === 'free_device_blocked' && err.reason === 'domain') showProblem(tr('这个邮箱域名不能再领取免费额度。开通套餐后可以继续使用。'), 'device');
      else if (err instanceof ApiError && err.code === 'free_device_blocked') showProblem(tr('这台设备已经使用过免费额度，新的免费账号不能再开始翻译。开通套餐后可以继续使用。'), 'device');
      else if (err instanceof ApiError && err.code === 'device_required') showProblem(tr('无法识别这台设备，请刷新页面后再试。'));
      else if (cause.name === 'NotAllowedError') showProblem(tr('音频权限被拒绝，请在浏览器中允许访问后重试。'));
      else if (cause.name === 'NotFoundError' || cause.name === 'OverconstrainedError') { setMicId(''); showProblem(tr('当前设备打不开所选麦克风，请改用系统默认麦克风后重试。')); }
      else showProblem(err instanceof Error && err.message ? tr(err.message) : tr('无法开始翻译'));
      void stop();
    }
  }
  function releaseUpstream() { upstreamDone.current = true; drain.current?.(); }
  async function readSavedSession(id: string) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const result = await api<{ session: { transcriptId: string | null; endedAt: string | null; recordStatus: string | null; saveStatus: string } }>(`/v1/realtime/sessions/${id}`);
        if (result.session.endedAt || result.session.transcriptId) return result.session;
      } catch { /* The session may still be finishing. */ }
      await new Promise((resolve) => window.setTimeout(resolve, 400));
    }
    return null;
  }
  async function stop(options?: { alreadyFinished?: boolean }) {
    if (stopLock.current) return stopLock.current;
    const run = finishStop(options);
    stopLock.current = run;
    try { await run; } finally { stopLock.current = null; }
  }
  async function finishStop(options?: { alreadyFinished?: boolean }) {
    if (statusRef.current === 'idle' || statusRef.current === 'stopping' || statusRef.current === 'saving') return;
    userStop.current = true;
    acceptAudio.current = false;
    closeOpenPause();
    if (suspendStarted.current != null) {
      sendControl({ type: 'gap', id: crypto.randomUUID(), source: 'system_suspend', wallStartMs: suspendStarted.current, wallEndMs: wallClock(), audioStartMs: sentAudioMs.current, audioEndMs: sentAudioMs.current, precision: 'estimated' });
      suspendStarted.current = null;
    }
    setClosePrompt(false);
    readyWait.current?.(false);
    readyWait.current = null;
    updateSessionStatus('saving');
    if (startupTimer.current !== null) window.clearTimeout(startupTimer.current); startupTimer.current = null;
    if (keepalive.current !== null) window.clearInterval(keepalive.current); keepalive.current = null;
    const ws = socket.current;
    const stream = audio.current; audio.current = null;
    await stream?.stop().catch(() => undefined);
    if (!options?.alreadyFinished && !upstreamDone.current && ws?.readyState === WebSocket.OPEN) {
      await flushQueuedAudio(ws);
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'speakers', names: speakerNamesRef.current }));
        ws.send(JSON.stringify({ type: 'stop', title: closeTitleRef.current || undefined }));
      }
      await new Promise<void>((resolve) => {
        const timer = window.setTimeout(resolve, 8_000);
        drain.current = () => { window.clearTimeout(timer); resolve(); };
      });
      drain.current = null;
    }
    ++generation.current;
    socket.current = null;
    if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) ws.close();
    const id = sessionId.current; sessionId.current = null;
    const latencyProps = latencySampleProps(latencySamples.current);
    latencySamples.current = emptyLatencySamples();
    if (id && latencyProps && getToken()) void api('/v1/events', { method: 'POST', body: JSON.stringify({ name: 'latency_sample', dedupeKey: `latency:${id}`, props: { sessionId: id, ...latencyProps } }) }).catch(() => undefined);
    let confirmed = id && getToken() ? await readSavedSession(id) : null;
    if (id && getToken() && !confirmed?.endedAt) {
      await api(`/v1/realtime/sessions/${id}`, { method: 'DELETE' }).catch(() => undefined);
      confirmed = await readSavedSession(id);
    }
    if (getToken()) void api<Entitlement>('/v1/me/entitlement').then(setEntitlement).catch(() => undefined);
    const saved = savedTranscriptId.current ?? confirmed?.transcriptId ?? null;
    const outcome = finishOutcome.current;
    savedTranscriptId.current = null;
    finishOutcome.current = null;
    limitSeconds.current = null;
    readyAt.current = null;
    setRemainingSeconds(null);
    setAudioStalled(false);
    sessionReady.current = false;
    updateSessionStatus('idle');
    closeTitleRef.current = '';
    setLiveSessionId(null);
    replacePath('/');
    if (outcome === 'failed' || (confirmed?.saveStatus === 'failed' && !saved)) showProblem(tr('保存失败。已收到的字幕没有完整写入，请重试确认。'));
    else if (!saved) setSavedNote(tr('这次没有可保存的内容。'));
    else if (outcome === 'partial' || confirmed?.recordStatus === 'incomplete') setSavedNote(tr('记录已部分保存，并标为中断。'));
    else setSavedNote(tr('记录已保存。'));
    if (saved) { setEndedTranscriptId(saved); setSessionTitle(''); }
  }
  function requestClose() {
    if (statusRef.current !== 'running' && statusRef.current !== 'reconnecting') { void stop(); return; }
    if (sessionTitle.trim()) { confirmClose(); return; }
    setClosePrompt(true);
  }
  function confirmClose() {
    closeTitleRef.current = sessionTitle.trim().slice(0, 120);
    setClosePrompt(false);
    void stop();
  }
  async function logout() { await stop(); clearToken(); setAuthenticated(false); }
  async function endConflict(thenStart = false) {
    const id = conflictSession?.id;
    if (!id) return;
    await api(`/v1/realtime/sessions/${id}`, { method: 'DELETE' }).catch(() => undefined);
    setConflictSession(null); showProblem('');
    if (sessionIdFromPath(window.location.pathname) === id) replacePath('/');
    if (thenStart) await start();
  }
  function applyActiveSession(session: ActiveSession) {
    if (!session.languageA) return;
    setMode(session.mode === 'two_way' ? 'two_way' : 'one_way');
    setLanguageA(session.languageA);
    const paired = session.mode === 'two_way' ? session.languageB : session.targetLanguage ?? session.languageB;
    if (paired) setLanguageB(paired);
    setSessionTitle(session.title ?? '');
  }
  async function resumeConflict() {
    const pending = conflictSession;
    if (!pending || statusRef.current !== 'idle') return;
    replacePath(`/session/${pending.id}`);
    userStop.current = false;
    acceptAudio.current = false;
    setConflictSession(null); showProblem(''); setLiveNotice('');
    followLatest.current = true;
    const gen = ++generation.current;
    sessionId.current = pending.id;
    setLiveSessionId(pending.id);
    captionFold.current = createCaptionFold();
    windowEndRef.current = 0;
    setWindowEnd(0);
    setSegments([]);
    applyActiveSession(pending);
    updateSessionStatus('opening');
    let session = pending;
    try {
      const result = await api<{ session: ActiveSession | null }>('/v1/realtime/sessions/active');
      if (generation.current !== gen) return;
      if (result.session?.id === pending.id) session = result.session;
    } catch { /* Use the session captured when the conflict was detected. */ }
    if (generation.current !== gen) return;
    applyActiveSession(session);
    try {
      if (!await ensureAudio(gen)) return;
      await recover();
    } catch (err) {
      showProblem(err instanceof Error ? tr(err.message) : tr('无法恢复连接，会话已结束。'));
      void stop();
    }
  }
  function liveText() {
    return segments.filter((segment) => !segment.interim && (segment.source || segment.translation)).map((segment) => {
      const who = segment.speaker ? speakerNames[segment.speaker] ?? segment.speaker : '';
      const source = segment.source;
      const translation = segment.translation;
      const body = captionView === 'source' ? source : captionView === 'translation' ? (translation || source) : [translation, source].filter(Boolean).join('\n');
      return who ? `${who}\n${body}` : body;
    }).join('\n\n');
  }
  async function copyLive() {
    try { await navigator.clipboard.writeText(liveText()); setLiveNotice(tr('已复制当前字幕。')); }
    catch { showProblem(tr('当前浏览器不允许复制，请手动选择文本。')); }
  }
  function exportLive() {
    const blob = new Blob([liveText()], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement('a');
    anchor.href = url; anchor.download = `${sessionTitle.trim() || 'linguaflow'}.txt`; document.body.append(anchor); anchor.click(); anchor.remove();
    URL.revokeObjectURL(url);
  }
  function renameLiveSpeaker() {
    if (!namingSpeaker || !speakerDraft.trim()) return;
    const next = { ...speakerNamesRef.current, [namingSpeaker]: speakerDraft.trim() };
    speakerNamesRef.current = next;
    setSpeakerNames(next);
    setNamingSpeaker(null);
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: 'speakers', names: next }));
  }
  const pauseStarted = useRef<number | null>(null);
  const wallOrigin = useRef<number | null>(null);
  const sentAudioMs = useRef(0);
  const pendingControls = useRef<Array<Record<string, unknown>>>([]);
  const controlLabels = useRef(new Map<string, string>());
  const suspendStarted = useRef<number | null>(null);
  function wallClock() { return wallOrigin.current == null ? null : Date.now() - wallOrigin.current; }
  function sendControl(payload: Record<string, unknown>) {
    if (payload.type === 'gap' && typeof payload.id === 'string') {
      const source = payload.source === 'user_pause' ? tr('主动暂停') : payload.source === 'system_suspend' ? tr('系统暂停') : tr('内容缺口');
      controlLabels.current.set(payload.id, source);
    }
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(payload));
    else pendingControls.current.push(payload);
  }
  function closeOpenPause() {
    if (pauseStarted.current == null) return;
    sendControl({ type: 'gap', id: crypto.randomUUID(), source: 'user_pause', wallStartMs: pauseStarted.current, wallEndMs: wallClock(), audioStartMs: sentAudioMs.current, audioEndMs: sentAudioMs.current, precision: wallClock() == null ? 'unknown' : 'exact' });
    pauseStarted.current = null;
  }
  function togglePause() {
    const next = !pausedRef.current;
    pausedRef.current = next;
    setPaused(next);
    if (next) pauseStarted.current = wallClock();
    else closeOpenPause();
  }
  function addMarker(kind: 'important' | 'unclear' | 'assignment') {
    sendControl({ type: 'marker', id: crypto.randomUUID(), kind, wallMs: wallClock(), audioMs: sentAudioMs.current });
    setLiveNotice(tr('正在保存标记…'));
  }
  useEffect(() => {
    if (!sessionLive) return;
    if (audioStalled) { suspendStarted.current = wallClock(); return; }
    if (suspendStarted.current == null) return;
    sendControl({ type: 'gap', id: crypto.randomUUID(), source: 'system_suspend', wallStartMs: suspendStarted.current, wallEndMs: wallClock(), audioStartMs: sentAudioMs.current, audioEndMs: sentAudioMs.current, precision: 'estimated' });
    suspendStarted.current = null;
  }, [audioStalled, sessionLive]);
  async function toggleFullscreen() {
    const node = stageRef.current?.parentElement;
    if (!node) return;
    if (document.fullscreenElement) await document.exitFullscreen();
    else await node.requestFullscreen();
  }
  async function reloadProfile() { const next = await api<Profile>('/v1/me/profile'); setProfile(next); }
  const captionEnd = Math.min(windowEnd, segments.length);
  const hiddenCaptions = Math.max(0, captionEnd - captionLimit);
  const visibleCaptions = segments.slice(hiddenCaptions, captionEnd);
  const routeSessionId = sessionIdFromPath(path);
  const rejoin = Boolean(routeSessionId && conflictSession?.id === routeSessionId && sessionStatus === 'idle');
  if (path === '/help' || path === '/en/help') return <HelpPage />;
  if (path === '/privacy' || path === '/en/privacy') return <LegalPage kind="privacy" />;
  if (path === '/terms' || path === '/en/terms') return <LegalPage kind="terms" />;
  const shareToken = path.match(/^\/s\/([^/]+)\/?$/)?.[1];
  if (shareToken) return <SharePage token={decodeURIComponent(shareToken)} />;
  const liveToken = path.match(/^\/live\/([^/]+)\/?$/)?.[1];
  if (liveToken) return <LivePage token={decodeURIComponent(liveToken)} />;
  if (!authenticated && path !== '/' && !routeSessionId) return <MarketingPage />;
  if (!authenticated) return <AuthScreen onLogin={() => setAuthenticated(true)} />;
  const captionsVisible = segments.length > 0 || running || sessionStatus === 'reconnecting';
  const timeWarning = running && remainingSeconds !== null && remainingSeconds <= 60;
  const remainingLabel = running && remainingSeconds !== null ? ` · ${remainingSeconds <= 60 ? tr('即将结束') : tr('剩余')} ${formatRemain(remainingSeconds)}` : '';
  const glossaryHint = glossaryId && (glossaryUsed > 0 || !glossaryAligned || glossaryDropped > 0)
    ? <p className="audio-hint">
        {glossaryUsed > 0 && <>{tr('本次会注入 {count} 条。').replace('{count}', String(glossaryUsed))} </>}
        {!glossaryAligned && <>{tr('这个术语库是 {glossary}，这场是 {session}。译法仍按词库方向注入。').replace('{glossary}', glossaryPairLabel).replace('{session}', sessionPairLabel)} </>}
        {glossaryDropped > 0 && <>{tr('有 {count} 条术语超出上限，本次不会注入。').replace('{count}', String(glossaryDropped))}{glossaryDroppedTerms.length ? ` ${glossaryDroppedTerms.slice(0, 6).join('、')}` : ''} {tr('可把必须使用的词标为优先。')}</>}
      </p>
    : null;

  /* Highest priority first. SessionNotices renders only the first one. */
  const notices: Array<Notice | null> = [
    closePrompt ? { id: 'close', node: <form className="close-title" onSubmit={(event) => { event.preventDefault(); confirmClose(); }}><label>{tr('这场翻译的名称')}<input value={sessionTitle} onChange={(event) => setSessionTitle(event.target.value)} maxLength={120} placeholder={tr('可选，方便以后查找')} aria-label={tr('这场翻译的名称')} autoFocus /></label><button className="primary-button" type="submit">{tr('保存并结束')}</button><button type="button" className="link-button" onClick={() => setClosePrompt(false)}>{tr('继续翻译')}</button></form> } : null,
    namingSpeaker ? { id: 'speaker', node: <form className="speaker-rename-form" onSubmit={(event) => { event.preventDefault(); renameLiveSpeaker(); }}><label>{tr('改名为')}<input value={speakerDraft} onChange={(event) => setSpeakerDraft(event.target.value)} aria-label={tr('说话人名称')} autoFocus /></label><button className="secondary-button" type="submit">{tr('保存')}</button><button type="button" className="secondary-button" onClick={() => setNamingSpeaker(null)}>{tr('取消')}</button></form> } : null,
    error ? { id: 'error', node: <div className={`error-banner${recovery ? ' has-actions' : ''}`} role="alert"><span>{error}</span>{recovery && <><button type="button" className="primary-button" onClick={() => setPanel('pricing')}>{tr('打开套餐与激活码')}</button><button type="button" className="link-button" onClick={() => setPanel('invite')}>{tr('邀请朋友')}</button></>}</div> } : null,
    audioStalled && sessionLive ? { id: 'stalled', node: <div className="error-banner time-warning-banner" role="status">{tr('收音被系统暂停了，点一下屏幕继续。')}</div> } : null,
    timeWarning ? { id: 'time', node: <div className="error-banner time-warning-banner" role="status">{tr('本次会话即将结束，剩余')} {formatRemain(remainingSeconds ?? 0)}</div> } : null,
    routeEnded && routeEnded.id === routeSessionId && sessionStatus === 'idle' ? { id: 'route-ended', node: <div className="session-saved" role="status"><span>{tr('这场翻译已经结束，无法恢复。')}</span>{routeEnded.transcriptId && <button type="button" className="primary-button" onClick={() => { setFocusTranscriptId(routeEnded.transcriptId); setPanel('transcripts'); }}>{tr('查看本次记录')}</button>}<button type="button" className="link-button" onClick={() => replacePath('/')}>{tr('回到工作区')}</button></div> } : null,
    conflictSession && sessionStatus === 'idle' ? { id: 'conflict', node: <div className="record-notice" role="status"><p>{tr('上一场翻译还在占用额度。')}</p><button type="button" className="primary-button" onClick={() => void resumeConflict()}>{tr('恢复这场')}</button><button type="button" className="secondary-button" onClick={() => void endConflict(false)}>{tr('结束上一场')}</button><button type="button" className="secondary-button" onClick={() => void endConflict(true)}>{tr('结束上一场并开始')}</button></div> } : null,
    endedTranscriptId && sessionStatus === 'idle' ? { id: 'saved', node: <div className="session-saved" role="status"><span>{savedNote || tr('本次记录已保存。')}</span><button type="button" className="primary-button" onClick={() => { setFocusTranscriptId(endedTranscriptId); setPanel('transcripts'); }}>{tr('查看本次记录')}</button><button type="button" className="link-button" onClick={() => { setEndedTranscriptId(null); setSavedNote(''); }}>{tr('关闭')}</button></div> } : null,
    sessionLive && savedThrough ? { id: 'checkpoint', node: <div className="session-saved" role="status"><span>{saveState === 'failed' ? tr('保存失败') : tr('已保存到 {time}').replace('{time}', new Date(savedThrough).toLocaleTimeString())}{liveGaps.length > 0 ? ` · ${liveGaps.join(' · ')}` : ''}</span><span className="list-item-actions"><button type="button" className="link-button" onClick={() => addMarker('important')}>{tr('重点')}</button><button type="button" className="link-button" onClick={() => addMarker('unclear')}>{tr('没听懂')}</button><button type="button" className="link-button" onClick={() => addMarker('assignment')}>{tr('作业')}</button></span></div> } : null,
    sessionLive ? { id: 'marks', node: <div className="session-saved" role="group" aria-label={tr('课堂标记')}><button type="button" className="link-button" onClick={() => addMarker('important')}>{tr('重点')}</button><button type="button" className="link-button" onClick={() => addMarker('unclear')}>{tr('没听懂')}</button><button type="button" className="link-button" onClick={() => addMarker('assignment')}>{tr('作业')}</button></div> } : null,
    sessionStatus === 'idle' && authenticated ? { id: 'courses', node: <CourseBar disabled={busySession} languageA={languageA} languageB={languageB} recordAudio={recordAudio} glossaryId={glossaryId} onStart={(course) => void start(course)} /> } : null,
    !recordAck && recordAudio && sessionStatus === 'idle' ? { id: 'record-ack', node: <div className="record-notice" role="status"><p>{tr('录音默认开启。本次语音会保存到你的字幕库，只有你可以回放和删除。如果不需要保存，请先关闭「保存本次语音」。')}</p><button type="button" className="secondary-button" onClick={() => { localStorage.setItem('linguaflow_record_ack', '1'); setRecordAck(true); }}>{tr('知道了')}</button></div> } : null,
    showGuide && sessionStatus === 'idle' && !conflictSession && !routeEnded ? { id: 'guide', node: <FirstRun pair={currentLabel} plan={entitlement?.plan.toUpperCase() ?? 'FREE'} minutesLeft={entitlement ? (usableSeconds(entitlement) >= Number.MAX_SAFE_INTEGER / 2 ? tr('无限') : `${Math.ceil(usableSeconds(entitlement) / 60)} ${tr('分钟')}`) : '…'} onOpen={() => { if (!phone) setDockOpen(true); }} onDone={() => setShowGuide(false)} /> } : null,
    liveNotice ? { id: 'live-notice', node: <p className="live-notice" role="status">{liveNotice}</p> } : null
  ];

  return <div className="app-shell">
    <Topbar
      entitlement={entitlement}
      serviceStatus={serviceStatus}
      isAdmin={profile?.role === 'admin'}
      live={phone && sessionLive ? { label: currentLabel, remaining: remainingSeconds !== null ? formatRemain(remainingSeconds) : '', warning: Boolean(timeWarning), paused } : null}
      onPanel={setPanel}
      onLogout={() => void logout()}
    />
    <main className="workspace">
      <section className="stage">
        {!phone && captionsVisible && <CaptionToolbar view={captionView} onView={setCaptionView} onCopy={() => void copyLive()} onExport={exportLive} latency={sessionLive ? <LatencyBadge readout={latency} paused={paused || audioStalled} /> : null} />}
        {phone && sessionLive && <div className="stage-latency"><LatencyBadge readout={latency} paused={paused || audioStalled} /></div>}
        <CaptionStage
          stageRef={stageRef}
          segments={segments}
          visibleCaptions={visibleCaptions}
          hiddenCaptions={hiddenCaptions}
          captionSize={captionSize}
          captionView={captionView}
          sessionStatus={sessionStatus}
          twoWay={mode === 'two_way'}
          languageB={languageB}
          speakerNames={speakerNames}
          withToolbar={!phone && captionsVisible}
          onScroll={onStageScroll}
          onShowEarlier={showEarlierCaptions}
          onRenameSpeaker={(speaker) => { setNamingSpeaker(speaker); setSpeakerDraft(speakerNames[speaker ?? ''] ?? speaker ?? ''); }}
        />
        {showJump && <button type="button" className="jump-latest" onClick={jumpLatest}>{tr('回到最新')}</button>}
      </section>
      <SessionNotices notices={notices} />
      <ControlDock
        phone={phone}
        sessionStatus={sessionStatus}
        busySession={busySession}
        running={running}
        paused={paused}
        closePrompt={closePrompt}
        dockOpen={dockOpen}
        captionOpen={captionOpen}
        mode={mode}
        languages={languages}
        languageA={languageA}
        languageB={languageB}
        sameLanguage={sameLanguage}
        glossaryId={glossaryId}
        glossaryChoices={glossaryChoices}
        glossaryHint={glossaryHint}
        audioSource={audioSource}
        mics={mics}
        micId={micId}
        recordAudio={recordAudio}
        voiceBoost={voiceBoost}
        sessionTitle={sessionTitle}
        liveSessionId={liveSessionId}
        captionView={captionView}
        captionSize={captionSize}
        fullscreen={fullscreen}
        directionLabel={currentLabel}
        remainingLabel={remainingLabel}
        timeWarning={Boolean(timeWarning)}
        hasCaptions={segments.length > 0}
        planLabel={entitlement ? `${PLANS[entitlement.plan].label} ${tr('额度')}` : ''}
        rejoin={rejoin}
        onDockOpen={(open) => { setDockOpen(open); if (open) setCaptionOpen(false); }}
        onCaptionOpen={(open) => { setCaptionOpen(open); if (open) setDockOpen(false); }}
        onMode={setMode}
        onLanguageA={setLanguageA}
        onLanguageB={setLanguageB}
        onGlossary={setGlossaryId}
        onAudioSource={setAudioSource}
        onMic={setMicId}
        onRecordAudio={setRecordAudio}
        onVoiceBoost={(value) => { voiceBoostOn.current = value; setVoiceBoost(value); }}
        onSessionTitle={setSessionTitle}
        onCaptionView={setCaptionView}
        onCaptionSize={setCaptionSize}
        onFullscreen={() => void toggleFullscreen()}
        onPause={togglePause}
        onCancel={() => { if (statusRef.current === 'opening' || statusRef.current === 'connecting') void stop(); }}
        onPrimary={() => {
          if (closePrompt) { confirmClose(); return; }
          const status = statusRef.current;
          /* Opening the mic on a phone shows a permission sheet. The tap that
             dismisses it lands on this same button and used to cancel the session
             before any audio was sent. */
          if (status === 'idle') {
            if (routeSessionId && conflictSession?.id === routeSessionId) { void resumeConflict(); return; }
            void start();
            return;
          }
          if (status === 'running' || status === 'reconnecting') requestClose();
        }}
        onCopy={() => void copyLive()}
        onExport={exportLive}
      />
    </main>
    {panel === 'transcripts' && <TranscriptPanel focusId={focusTranscriptId} onOpenAccount={() => setPanel('account')} onOpenPlans={() => setPanel('pricing')} onClose={() => { setPanel('none'); setFocusTranscriptId(null); }} />}
    {panel === 'glossary' && <GlossaryPanel languageA={languageA} languageB={languageB} activeId={glossaryId} onActive={setGlossaryId} onList={setGlossaryChoices} onClose={() => setPanel('none')} />}
    {panel === 'pricing' && <PricingPanel entitlement={entitlement} onRefresh={() => api<Entitlement>('/v1/me/entitlement').then(setEntitlement)} onOpenInvite={() => setPanel('invite')} onClose={() => setPanel('none')} />}
    {panel === 'invite' && <InvitePanel onClose={() => setPanel('none')} />}
    {panel === 'admin' && <AdminPanel onClose={() => setPanel('none')} />}
    {panel === 'account' && <AccountPanel email={profile?.email ?? ''} displayName={profile?.displayName ?? ''} onProfile={() => void reloadProfile()} onClose={() => setPanel('none')} />}
  </div>;
}

createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
