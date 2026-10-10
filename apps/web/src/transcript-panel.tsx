import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { extractActionItems, LANGUAGE_OPTIONS, type Entitlement } from '@linguaflow/shared';
import { api, ApiError, apiOrigin, apiResponse } from './lib/api';
import { PHONE_QUERY, useMediaQuery } from './lib/breakpoints';
import { glossaryDirection, glossaryOptionLabel } from './lib/glossary';
import { tr } from './lib/i18n';
import { ListSkeleton, PanelShell } from './panel-shell';
import { BookIcon, ChevronLeftIcon, ChevronRightIcon, EditIcon } from './icons';

type TranscriptItem = {
  id: string;
  title: string;
  languageA: string;
  languageB: string;
  durationMs: number;
  mode?: string;
  starred?: boolean;
  tags?: string[] | null;
  folderId?: string | null;
  createdAt: string;
  summaryStatus: string;
  summaryError: string | null;
  audioStatus: string;
};
type TranscriptDetail = TranscriptItem & {
  summaryMarkdown: string | null;
  summaryTemplate: string | null;
  summaryLanguage: string | null;
  summaryModel: string | null;
  summaryEditedAt: string | null;
  summaryChecks?: string[] | null;
  tasks?: Array<{ id: string; text: string; done: boolean }>;
  audioFormat: string | null;
  audioError: string | null;
  audioPlaybackToken: string | null;
  summaryStale?: boolean;
  summaryQuoteSeconds?: number;
  segments: Array<{ id: string; sourceText: string; translationText: string; startMs: number | null; endMs?: number | null; speaker?: string | null }>;
};
type ShareLink = { id: string; token: string | null; includeAudio: boolean; createdAt: string; expiresAt: string | null; revokedAt: string | null; hasPassword?: boolean; viewCount?: number; scope?: string };

function formatDurationMs(ms: number) {
  if (ms < 60_000) return `${Math.max(0, Math.round(ms / 1000))} ${tr('秒')}`;
  return `${Math.round(ms / 60000)} ${tr('分钟')}`;
}

function formatClockMs(ms: number) {
  const total = Math.max(0, Math.floor(ms / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const clock = `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  return hours > 0 ? `${hours}:${clock}` : clock;
}
type Provider = { configured: boolean; platformAvailable?: boolean; apiBase?: string; model?: string; hasKey?: boolean; keyHint?: string; keyUnreadable?: boolean };

function message(error: unknown, fallback: string) {
  if (error instanceof ApiError && error.code === 'free_device_blocked') return tr('这台设备已经使用过免费额度，新的免费账号不能再开始翻译。开通套餐后可以继续使用。');
  if (error instanceof ApiError && error.code === 'device_required') return tr('无法识别这台设备，请刷新页面后再试。');
  return tr(error instanceof Error ? error.message : fallback);
}

function inlineText(text: string) {
  return text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index}>{part.slice(1, -1)}</code>;
    return <span key={index}>{part}</span>;
  });
}

export function renderSummary(markdown: string) {
  const blocks: Array<{ type: 'h' | 'ul' | 'p' | 'code'; text?: string; items?: string[]; level?: number }> = [];
  const lines = markdown.split('\n');
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? '';
    if (!line.trim()) { index += 1; continue; }
    if (line.startsWith('```')) {
      const code: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) { code.push(lines[index] ?? ''); index += 1; }
      if (index < lines.length) index += 1;
      blocks.push({ type: 'code', text: code.join('\n') });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: 'h', level: heading[1].length, text: heading[2] });
      index += 1;
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (index < lines.length && /^[-*]\s+/.test(lines[index] ?? '')) {
        items.push((lines[index] ?? '').replace(/^[-*]\s+/, ''));
        index += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] ?? '').trim() && !/^(#{1,3})\s+/.test(lines[index] ?? '') && !/^[-*]\s+/.test(lines[index] ?? '') && !(lines[index] ?? '').startsWith('```')) {
      paragraph.push(lines[index] ?? '');
      index += 1;
    }
    blocks.push({ type: 'p', text: paragraph.join('\n') });
  }
  return blocks.map((block, blockIndex) => {
    if (block.type === 'h') {
      const Tag = block.level === 1 ? 'h3' : block.level === 2 ? 'h4' : 'h5';
      return <Tag key={blockIndex}>{inlineText(block.text ?? '')}</Tag>;
    }
    if (block.type === 'ul') return <ul key={blockIndex}>{block.items?.map((item, itemIndex) => <li key={itemIndex}>{inlineText(item)}</li>)}</ul>;
    if (block.type === 'code') return <pre key={blockIndex}><code>{block.text}</code></pre>;
    return <p key={blockIndex}>{inlineText(block.text ?? '')}</p>;
  });
}

function ActionList({ markdown, checks, onToggle, onCopy }: { markdown: string; checks: string[]; onToggle: (item: string) => void; onCopy: () => void }) {
  const items = extractActionItems(markdown);
  if (!items.length) return null;
  return <div className="task-box"><div className="task-head"><strong>{tr('待办')}</strong><button type="button" className="link-button" onClick={() => { void navigator.clipboard.writeText(items.map((item) => `- ${item}`).join('\n')).then(onCopy).catch(() => undefined); }}>{tr('复制待办')}</button></div>{items.map((item, index) => <label key={`${item}-${index}`}><input type="checkbox" checked={checks.includes(item)} onChange={() => onToggle(item)} /><span>{item}</span></label>)}</div>;
}

export function TranscriptPanel({ onClose, focusId = null, onOpenAccount }: { onClose: () => void; focusId?: string | null; onOpenAccount?: () => void }) {
  const [items, setItems] = useState<TranscriptItem[]>([]);
  const [selected, setSelected] = useState<TranscriptDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [detailLoading, setDetailLoading] = useState(false);
  const [error, setError] = useState('');
  const [detailError, setDetailError] = useState('');
  const [notice, setNotice] = useState('');
  const [exporting, setExporting] = useState('');
  const [title, setTitle] = useState('');
  const [platformAvailable, setPlatformAvailable] = useState(false);
  const [providerLoaded, setProviderLoaded] = useState(false);
  const [byokReady, setByokReady] = useState(false);
  const [providerChoice, setProviderChoice] = useState<'platform' | 'byok'>('byok');
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [segmentEdit, setSegmentEdit] = useState<{ id: string; source: string; translation: string; speaker: string; originalSpeaker: string } | null>(null);
  const [shares, setShares] = useState<ShareLink[]>([]);
  const [includeAudioShare, setIncludeAudioShare] = useState(false);
  const [entitlement, setEntitlement] = useState<Entitlement | null>(null);
  const [template, setTemplate] = useState<'meeting' | 'classroom' | 'interview' | 'briefing'>('meeting');
  const [outputLanguage, setOutputLanguage] = useState('中文');
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [audioUrl, setAudioUrl] = useState('');
  const [busy, setBusy] = useState('');
  const [query, setQuery] = useState('');
  const [audioFilter, setAudioFilter] = useState('');
  const [summaryFilter, setSummaryFilter] = useState('');
  const [languageFilter, setLanguageFilter] = useState('');
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  const [glossaries, setGlossaries] = useState<Array<{ id: string; name: string; languageA: string; languageB: string }>>([]);
  const [termDraft, setTermDraft] = useState<{ segmentId: string; glossaryId: string; source: string; target: string } | null>(null);
  const [shareHours, setShareHours] = useState('168');
  const [sharePassword, setSharePassword] = useState('');
  const [shareScope, setShareScope] = useState<'full' | 'summary'>('full');
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [folderFilter, setFolderFilter] = useState('');
  const [starredOnly, setStarredOnly] = useState(false);
  const [tagFilter, setTagFilter] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [tagDraft, setTagDraft] = useState('');
  const [speakerFrom, setSpeakerFrom] = useState('');
  const [speakerTo, setSpeakerTo] = useState('');
  const [playheadMs, setPlayheadMs] = useState<number | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [openId, setOpenId] = useState<string | null>(focusId);
  const phone = useMediaQuery(PHONE_QUERY);
  const detailScreen = phone && openId !== null && (selected !== null || detailLoading || detailError !== '');
  const rootRef = useRef<HTMLDivElement>(null);
  const listScroll = useRef(0);
  const detailHistory = useRef(false);
  const audioRef = useRef<HTMLAudioElement>(null);
  const activeRowRef = useRef<HTMLButtonElement>(null);
  const listGeneration = useRef(0);
  const listAbort = useRef<AbortController | null>(null);

  function listParams(cursor?: string | null) {
    const params = new URLSearchParams();
    if (query.trim()) params.set('q', query.trim());
    if (audioFilter) params.set('audio', audioFilter);
    if (summaryFilter) params.set('summary', summaryFilter);
    if (languageFilter.trim()) params.set('language', languageFilter.trim().toLowerCase());
    if (fromDate) params.set('from', new Date(`${fromDate}T00:00:00`).toISOString());
    if (toDate) params.set('to', new Date(`${toDate}T23:59:59.999`).toISOString());
    if (folderFilter) params.set('folder', folderFilter);
    if (starredOnly) params.set('starred', '1');
    if (tagFilter.trim()) params.set('tag', tagFilter.trim());
    if (cursor) params.set('cursor', cursor);
    return params;
  }
  function beginListRequest() {
    listAbort.current?.abort();
    const controller = new AbortController();
    listAbort.current = controller;
    listGeneration.current += 1;
    return { requestId: listGeneration.current, signal: controller.signal };
  }
  async function runList(cursor: string | null | undefined, requestId: number, signal?: AbortSignal) {
    const appending = Boolean(cursor);
    if (!appending) setLoading(true);
    setError('');
    try {
      const page = await api<{ items: TranscriptItem[]; nextCursor: string | null }>(`/v1/transcripts?${listParams(cursor)}`, { signal });
      if (requestId !== listGeneration.current) return;
      setItems((current) => appending ? [...current, ...page.items] : page.items);
      setNextCursor(page.nextCursor);
    } catch (err) {
      if (requestId !== listGeneration.current) return;
      if (err instanceof Error && err.name === 'AbortError') return;
      setError(message(err, '字幕加载失败'));
    } finally { if (requestId === listGeneration.current && !appending) setLoading(false); }
  }
  async function refresh(cursor?: string | null) {
    if (cursor) { await runList(cursor, listGeneration.current, listAbort.current?.signal); return; }
    const request = beginListRequest();
    await runList(undefined, request.requestId, request.signal);
  }
  async function loadShares(id: string) {
    try { setShares(await api<ShareLink[]>(`/v1/transcripts/${id}/shares`)); return true; }
    catch { return false; }
  }
  async function reload(id: string, syncTitle = false) {
    const detail = await api<TranscriptDetail>(`/v1/transcripts/${id}`);
    setSelected(detail);
    if (syncTitle) setTitle(detail.title);
    setItems((current) => current.map((item) => item.id === id ? { ...item, title: detail.title, summaryStatus: detail.summaryStatus, summaryError: detail.summaryError, audioStatus: detail.audioStatus } : item));
    return detail;
  }
  useEffect(() => {
    const request = beginListRequest();
    const timer = window.setTimeout(() => { void runList(undefined, request.requestId, request.signal); }, 250);
    return () => window.clearTimeout(timer);
  }, [query, audioFilter, summaryFilter, languageFilter, fromDate, toDate, folderFilter, starredOnly, tagFilter]);
  useEffect(() => () => listAbort.current?.abort(), []);
  useEffect(() => { void api<Array<{ id: string; name: string }>>('/v1/transcript-folders').then(setFolders).catch(() => undefined); void api<Array<{ id: string; name: string; languageA: string; languageB: string }>>('/v1/me/glossaries').then(setGlossaries).catch(() => undefined); }, []);
  useEffect(() => { void api<Provider>('/v1/me/summary-provider').then((value) => { setByokReady(value.configured); setPlatformAvailable(Boolean(value.platformAvailable)); if (value.platformAvailable) setProviderChoice('platform'); }).catch(() => undefined).finally(() => setProviderLoaded(true)); void api<Entitlement>('/v1/me/entitlement').then(setEntitlement).catch(() => undefined); }, []);
  useEffect(() => {
    if (selected?.summaryStatus !== 'running' && selected?.audioStatus !== 'encoding') return;
    const id = selected.id;
    const timer = window.setInterval(() => { void reload(id).catch((err) => setDetailError(message(err, '字幕详情加载失败'))); }, 2000);
    return () => window.clearInterval(timer);
  }, [selected?.id, selected?.summaryStatus, selected?.audioStatus]);
  useEffect(() => {
    const playable = selected?.audioStatus === 'ready' || selected?.audioStatus === 'encoding';
    if (!selected || !playable || !selected.audioPlaybackToken) { setAudioUrl(''); return; }
    setAudioUrl(`${apiOrigin}/v1/transcripts/${selected.id}/audio?playback=${encodeURIComponent(selected.audioPlaybackToken)}`);
    setPlayheadMs(null);
  }, [selected?.id, selected?.audioStatus, selected?.audioFormat, selected?.audioPlaybackToken]);
  useEffect(() => {
    if (!focusId) return;
    let alive = true;
    setOpenId(focusId);
    setDetailLoading(true); setDetailError(''); setNotice(''); setEditing(false); setPlayheadMs(null);
    void reload(focusId, true).then((detail) => {
      if (!alive) return;
      if (detail.summaryTemplate === 'classroom' || detail.summaryTemplate === 'meeting' || detail.summaryTemplate === 'interview' || detail.summaryTemplate === 'briefing') setTemplate(detail.summaryTemplate);
      if (detail.summaryLanguage) setOutputLanguage(detail.summaryLanguage);
    }).catch((err) => { if (alive) setDetailError(message(err, '字幕详情加载失败')); }).finally(() => { if (alive) setDetailLoading(false); });
    return () => { alive = false; };
  }, [focusId]);
  useEffect(() => { activeRowRef.current?.scrollIntoView({ block: 'nearest' }); }, [playheadMs, selected?.id]);
  useLayoutEffect(() => {
    const body = rootRef.current?.closest<HTMLElement>('.panel-body');
    if (!body || !phone) return;
    if (detailScreen) { body.scrollTop = 0; return; }
    body.scrollTop = listScroll.current;
    if (openId) rootRef.current?.querySelector<HTMLElement>(`[data-transcript-id="${openId}"]`)?.focus({ preventScroll: true });
  }, [detailScreen]);

  function closeDetail() {
    setSelected(null); setSegmentEdit(null); setTermDraft(null); setDetailError(''); setNotice(''); setPlayheadMs(null);
  }
  /* On a phone the detail screen owns a history entry, so the system back gesture
     returns to the list instead of leaving the page. */
  useEffect(() => {
    if (detailScreen && !detailHistory.current) {
      window.history.pushState({ ...(window.history.state ?? {}), transcriptDetail: true }, '');
      detailHistory.current = true;
    } else if (!detailScreen && detailHistory.current) {
      detailHistory.current = false;
      window.history.back();
    }
  }, [detailScreen]);
  useEffect(() => {
    const onPop = () => {
      if (!detailHistory.current) return;
      detailHistory.current = false;
      closeDetail();
    };
    window.addEventListener('popstate', onPop);
    return () => {
      window.removeEventListener('popstate', onPop);
      if (detailHistory.current) { detailHistory.current = false; window.history.back(); }
    };
  }, []);
  function leaveDetail() {
    if (detailHistory.current) window.history.back();
    else closeDetail();
  }

  function syncPlayhead() {
    const node = audioRef.current;
    if (!node) return;
    setPlayheadMs(node.currentTime * 1000);
  }
  function seekTo(startMs: number | null) {
    const node = audioRef.current;
    if (!node || startMs === null) return;
    const target = startMs / 1000;
    setPlayheadMs(startMs);
    const play = () => { void node.play().catch(() => undefined); };
    if (Math.abs(node.currentTime - target) < 0.05) { play(); return; }
    node.addEventListener('seeked', play, { once: true });
    node.currentTime = target;
  }
  async function select(item: TranscriptItem) {
    const body = rootRef.current?.closest<HTMLElement>('.panel-body');
    if (body && !detailScreen) listScroll.current = body.scrollTop;
    setOpenId(item.id);
    setDetailLoading(true); setDetailError(''); setNotice(''); setEditing(false); setPlayheadMs(null);
    try {
      const detail = await reload(item.id, true);
      if (detail.summaryTemplate === 'classroom' || detail.summaryTemplate === 'meeting' || detail.summaryTemplate === 'interview' || detail.summaryTemplate === 'briefing') setTemplate(detail.summaryTemplate);
      if (detail.summaryLanguage) setOutputLanguage(detail.summaryLanguage);
      if (!await loadShares(item.id)) setShares([]);
    } catch (err) { setDetailError(message(err, '字幕详情加载失败')); }
    finally { setDetailLoading(false); }
  }
  async function saveTitle() {
    if (!selected || !title.trim() || title.trim() === selected.title) return;
    setBusy('title');
    try { const saved = await api<{ id: string }>(`/v1/transcripts/${selected.id}`, { method: 'PATCH', body: JSON.stringify({ title: title.trim() }) }); await reload(saved.id, true); setNotice(tr('标题已保存。')); }
    catch (err) { setDetailError(message(err, '保存标题失败')); }
    finally { setBusy(''); }
  }
  async function exportTranscript(format: 'txt' | 'srt' | 'vtt' | 'md' | 'pdf', scope?: 'summary' | 'full') {
    if (!selected) return;
    const key = `${format}-${scope ?? 'full'}`;
    setExporting(key); setDetailError('');
    try {
      const response = await apiResponse(`/v1/transcripts/${selected.id}/export?format=${format}${scope ? `&scope=${scope}` : ''}`);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = `${selected.title}${scope === 'summary' ? '-summary' : ''}.${format}`;
      document.body.append(anchor); anchor.click(); anchor.remove();
      URL.revokeObjectURL(url);
    } catch (err) { setDetailError(message(err, '导出失败')); }
    finally { setExporting(''); }
  }
  async function generate() {
    if (!selected) return;
    setBusy('summary'); setDetailError(''); setNotice(''); setEditing(false);
    try { await api(`/v1/transcripts/${selected.id}/summary`, { method: 'POST', body: JSON.stringify({ template, outputLanguage, provider: providerChoice }) }); await reload(selected.id); }
    catch (err) { setDetailError(message(err, '生成纪要失败')); }
    finally { setBusy(''); }
  }
  async function cancel() {
    if (!selected) return;
    setBusy('cancel');
    try { await api(`/v1/transcripts/${selected.id}/summary/cancel`, { method: 'POST' }); await reload(selected.id); }
    catch (err) { setDetailError(message(err, '取消失败')); }
    finally { setBusy(''); }
  }
  async function saveSummary() {
    if (!selected) return;
    setBusy('edit');
    try { await reload((await api<TranscriptDetail>(`/v1/transcripts/${selected.id}/summary`, { method: 'PATCH', body: JSON.stringify({ markdown: draft }) })).id); setEditing(false); setNotice(tr('纪要已保存。')); }
    catch (err) { setDetailError(message(err, '保存纪要失败')); }
    finally { setBusy(''); }
  }
  async function removeSelected() {
    if (!selected || !window.confirm(tr('确定删除这条会议记录吗？录音和纪要会一起删除。'))) return;
    try { await api(`/v1/transcripts/${selected.id}`, { method: 'DELETE' }); setItems((current) => current.filter((item) => item.id !== selected.id)); setSelected(null); setOpenId(null); }
    catch (err) { setDetailError(message(err, '删除失败')); }
  }
  async function copySelected() {
    if (!selected) return;
    const value = selected.segments.map((segment) => `${segment.sourceText}\n${segment.translationText}`).join('\n\n');
    try { await navigator.clipboard.writeText(value); setNotice(tr('已复制字幕内容。')); }
    catch { setDetailError(tr('当前浏览器不允许复制，请手动选择文本。')); }
  }

  const segments = selected?.segments;
  const nextStarts = useMemo(() => {
    const result: Array<number | undefined> = [];
    let next: number | undefined;
    for (let index = (segments?.length ?? 0) - 1; index >= 0; index -= 1) {
      result[index] = next;
      const start = segments?.[index]?.startMs;
      if (start !== null && start !== undefined) next = start;
    }
    return result;
  }, [segments]);
  const speakers = useMemo(() => Array.from(new Set((segments ?? []).flatMap((segment) => segment.speaker ? [segment.speaker] : []))), [segments]);
  const running = selected?.summaryStatus === 'running';
  const visible = items;
  const usable = entitlement && entitlement.remainingSeconds < Number.MAX_SAFE_INTEGER / 2 ? entitlement.remainingSeconds + entitlement.addonSeconds : Number.MAX_SAFE_INTEGER;
  const platformShort = providerChoice === 'platform' && (selected?.summaryQuoteSeconds ?? 0) > usable;
  const needsKey = providerLoaded && providerChoice === 'byok' && !byokReady;
  async function saveSegment() {
    if (!selected || !segmentEdit) return;
    setBusy('segment');
    try {
      await api(`/v1/transcripts/${selected.id}/segments/${segmentEdit.id}`, { method: 'PATCH', body: JSON.stringify({ sourceText: segmentEdit.source, translationText: segmentEdit.translation, speaker: segmentEdit.speaker || null }) });
      setSegmentEdit(null); await reload(selected.id); setNotice(tr('字幕已保存。'));
    } catch (err) { setDetailError(message(err, '保存字幕失败')); }
    finally { setBusy(''); }
  }
  async function renameSpeaker() {
    if (!selected || !segmentEdit?.originalSpeaker || !segmentEdit.speaker || segmentEdit.speaker === segmentEdit.originalSpeaker) return;
    setBusy('segment');
    try {
      await api(`/v1/transcripts/${selected.id}/speakers`, { method: 'POST', body: JSON.stringify({ from: segmentEdit.originalSpeaker, to: segmentEdit.speaker }) });
      setSegmentEdit(null); await reload(selected.id); setNotice(tr('字幕已保存。'));
    } catch (err) { setDetailError(message(err, '保存字幕失败')); }
    finally { setBusy(''); }
  }
  async function renameRoster() {
    if (!selected || !speakerFrom || !speakerTo.trim() || speakerFrom === speakerTo.trim()) return;
    setBusy('segment');
    try {
      await api(`/v1/transcripts/${selected.id}/speakers`, { method: 'POST', body: JSON.stringify({ from: speakerFrom, to: speakerTo.trim() }) });
      setSpeakerTo(''); await reload(selected.id); setNotice(tr('字幕已保存。'));
    } catch (err) { setDetailError(message(err, '保存字幕失败')); }
    finally { setBusy(''); }
  }
  async function createShare() {
    if (!selected) return;
    setDetailError('');
    try {
      const hours = Number(shareHours);
      const share = await api<ShareLink>(`/v1/transcripts/${selected.id}/shares`, { method: 'POST', body: JSON.stringify({ includeAudio: includeAudioShare && shareScope === 'full', expiresInHours: hours > 0 ? hours : null, password: sharePassword.trim() || undefined, scope: shareScope }) });
      const listed = await loadShares(selected.id);
      if (!listed) setShares((current) => current.some((item) => item.id === share.id) ? current : [...current, share]);
      const url = `${window.location.origin}/s/${share.token}`;
      try {
        await navigator.clipboard.writeText(url);
        setNotice(tr('分享链接已复制。'));
      } catch {
        setNotice(tr('分享链接已创建。'));
        setDetailError(tr('当前浏览器不允许复制，请手动选择文本。'));
      }
    } catch (err) { setDetailError(message(err, '导出失败')); }
  }
  async function revokeShare(shareId: string) {
    if (!selected) return;
    await api(`/v1/transcripts/${selected.id}/shares/${shareId}`, { method: 'DELETE' });
    await loadShares(selected.id);
  }
  async function reissueShare(shareId: string) {
    if (!selected) return;
    const share = await api<{ token: string }>(`/v1/transcripts/${selected.id}/shares/${shareId}/reissue`, { method: 'POST' });
    await navigator.clipboard.writeText(`${window.location.origin}/s/${share.token}`).catch(() => undefined);
    setNotice(tr('分享链接已复制。'));
    await loadShares(selected.id);
  }
  async function toggleTask(task: { id: string; done: boolean }) {
    if (!selected) return;
    const next = selected.tasks?.map((item) => item.id === task.id ? { ...item, done: !task.done } : item) ?? [];
    setSelected({ ...selected, tasks: next });
    try { await api(`/v1/transcripts/${selected.id}/tasks/${task.id}`, { method: 'PATCH', body: JSON.stringify({ done: !task.done }) }); }
    catch (err) { setDetailError(message(err, '保存纪要失败')); }
  }
  async function saveMeta(patch: { folderId?: string | null; starred?: boolean; tags?: string[] }) {
    if (!selected) return;
    const saved = await api<TranscriptDetail>(`/v1/transcripts/${selected.id}`, { method: 'PATCH', body: JSON.stringify(patch) });
    await reload(saved.id);
  }
  async function addTag(event: React.FormEvent) {
    event.preventDefault();
    if (!selected || !tagDraft.trim()) return;
    const tags = [...new Set([...(selected.tags ?? []), tagDraft.trim()])];
    setTagDraft('');
    await saveMeta({ tags });
  }
  async function runBatch(action: 'delete' | 'star' | 'unstar' | 'move' | 'export', folderId?: string | null) {
    if (!picked.length) return;
    if (action === 'delete' && !window.confirm(tr('确定删除选中的记录吗？录音和纪要会一起删除。'))) return;
    if (action === 'export') {
      const response = await apiResponse('/v1/transcripts/batch', { method: 'POST', body: JSON.stringify({ ids: picked, action }) });
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url; anchor.download = 'linguaflow-transcripts.md'; document.body.append(anchor); anchor.click(); anchor.remove();
      URL.revokeObjectURL(url);
      return;
    }
    await api('/v1/transcripts/batch', { method: 'POST', body: JSON.stringify({ ids: picked, action, folderId }) });
    const touchesOpen = selected !== null && picked.includes(selected.id);
    if (action === 'delete') {
      setItems((current) => current.filter((item) => !picked.includes(item.id)));
      if (openId && picked.includes(openId)) { closeDetail(); setOpenId(null); }
    } else if (touchesOpen && selected) {
      await reload(selected.id).catch(() => undefined);
    }
    setPicked([]);
    await refresh();
  }
  async function createFolder() {
    const name = window.prompt(tr('文件夹名称'));
    if (!name?.trim()) return;
    const folder = await api<{ id: string; name: string }>('/v1/transcript-folders', { method: 'POST', body: JSON.stringify({ name: name.trim() }) });
    setFolders((current) => [...current, folder].sort((a, b) => a.name.localeCompare(b.name)));
  }
  async function toggleCheck(item: string) {
    if (!selected) return;
    const current = selected.summaryChecks ?? [];
    const next = current.includes(item) ? current.filter((entry) => entry !== item) : [...current, item];
    setSelected({ ...selected, summaryChecks: next });
    try { await api(`/v1/transcripts/${selected.id}/summary-checks`, { method: 'PATCH', body: JSON.stringify({ checks: next }) }); }
    catch (err) { setDetailError(message(err, '保存纪要失败')); }
  }
  function orientTerm(glossaryId: string, source: string, target: string) {
    const glossary = glossaries.find((item) => item.id === glossaryId);
    if (!glossary || !selected) return { source, target };
    const direction = glossaryDirection(glossary, selected.languageA, selected.languageB);
    return direction === 'reversed' ? { source: target, target: source } : { source, target };
  }
  function beginTerm(segment: TranscriptDetail['segments'][number]) {
    if (!glossaries.length || !selected) { setDetailError(tr('请先新建一个术语库。')); return; }
    const ranked = [...glossaries].sort((left, right) => {
      const score = (item: typeof left) => { const direction = glossaryDirection(item, selected.languageA, selected.languageB); return direction === 'forward' ? 2 : direction === 'reversed' ? 1 : 0; };
      return score(right) - score(left);
    });
    const match = ranked[0];
    const source = segment.sourceText.slice(0, 200);
    const target = segment.translationText.slice(0, 200);
    const oriented = orientTerm(match.id, source, target);
    setTermDraft({ segmentId: segment.id, glossaryId: match.id, ...oriented });
  }
  async function saveCaptionTerm(event: React.FormEvent) {
    event.preventDefault();
    const draft = termDraft;
    if (!draft?.source.trim() || !draft.target.trim()) return;
    setBusy('term'); setDetailError('');
    try {
      await api(`/v1/me/glossaries/${draft.glossaryId}/terms`, { method: 'POST', body: JSON.stringify({ source: draft.source.trim(), target: draft.target.trim() }) });
      setTermDraft(null); setNotice(tr('已加入术语库。'));
    } catch (err) { setDetailError(message(err, '添加术语失败')); }
    finally { setBusy(''); }
  }
  const activeFilters = [audioFilter, summaryFilter, languageFilter, fromDate, toDate, folderFilter, tagFilter.trim(), starredOnly].filter(Boolean).length;
  function clearFilters() {
    setAudioFilter(''); setSummaryFilter(''); setLanguageFilter(''); setFromDate(''); setToDate(''); setFolderFilter(''); setTagFilter(''); setStarredOnly(false);
  }
  return <PanelShell title={tr('字幕库')} onClose={onClose} wide><div className="transcript-library" ref={rootRef}>{!detailScreen && <div className="transcript-list-view"><div className="term-form transcript-search"><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={tr('搜索标题、语言或字幕内容')} aria-label={tr('搜索字幕')} /><details className="transcript-filter-toggle" open={!phone || filtersOpen} onToggle={(event) => setFiltersOpen(event.currentTarget.open)}><summary>{tr('筛选')}{activeFilters > 0 && <span className="filter-count">{activeFilters}</span>}<ChevronRightIcon size={16} className="fold-chevron" /></summary><div className="transcript-filters"><select value={audioFilter} onChange={(event) => setAudioFilter(event.target.value)} aria-label={tr('只看有录音')}><option value="">{tr('全部录音')}</option><option value="ready">{tr('只看有录音')}</option></select><select value={summaryFilter} onChange={(event) => setSummaryFilter(event.target.value)} aria-label={tr('只看有纪要')}><option value="">{tr('全部纪要')}</option><option value="ready">{tr('只看有纪要')}</option></select><select value={languageFilter} onChange={(event) => setLanguageFilter(event.target.value)} aria-label={tr('全部语言')}><option value="">{tr('全部语言')}</option>{LANGUAGE_OPTIONS.map((option) => <option value={option.code} key={option.code}>{option.nativeName}</option>)}</select><input type="date" value={fromDate} onChange={(event) => setFromDate(event.target.value)} aria-label={tr('起始日期')} /><input type="date" value={toDate} onChange={(event) => setToDate(event.target.value)} aria-label={tr('结束日期')} /><select value={folderFilter} onChange={(event) => setFolderFilter(event.target.value)} aria-label={tr('文件夹')}><option value="">{tr('全部文件夹')}</option><option value="none">{tr('未分组')}</option>{folders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}</select><input value={tagFilter} onChange={(event) => setTagFilter(event.target.value)} placeholder={tr('标签')} aria-label={tr('标签')} /><label className="record-toggle"><input type="checkbox" checked={starredOnly} onChange={(event) => setStarredOnly(event.target.checked)} /><span>{tr('只看星标')}</span></label>{activeFilters > 0 && <button type="button" className="link-button filter-clear" onClick={clearFilters}>{tr('清除筛选')}</button>}</div></details></div>{picked.length > 0 && <div className="list-item-actions batch-bar"><span>{tr('已选 {count} 条').replace('{count}', String(picked.length))}</span><button className="secondary-button" onClick={() => void runBatch('star')}>{tr('加星')}</button><button className="secondary-button" onClick={() => void runBatch('unstar')}>{tr('取消星标')}</button><select aria-label={tr('移入文件夹')} onChange={(event) => { const value = event.target.value; event.target.value = ''; if (value === 'new') { void createFolder(); return; } if (value) void runBatch('move', value === 'none' ? null : value); }}><option value="">{tr('移入文件夹')}</option><option value="none">{tr('未分组')}</option>{folders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}<option value="new">{tr('新建文件夹')}</option></select><button className="secondary-button" onClick={() => void runBatch('export')}>{tr('导出选中')}</button><button className="danger-button" onClick={() => void runBatch('delete')}>{tr('删除选中')}</button></div>}<div className="panel-list">{loading && <ListSkeleton label={tr('正在加载字幕…')} />}{!loading && error && <div className="panel-empty" role="alert">{error}<button className="link-button" onClick={() => void refresh()}>{tr('重试')}</button></div>}{!loading && !error && items.length === 0 && <div className="panel-empty">{tr('完成一次翻译后，字幕会自动保存在这里。')}</div>}{!loading && !error && items.length > 0 && visible.length === 0 && <div className="panel-empty">{tr('没有匹配的记录。')}</div>}{visible.map((item) => { const open = item.id === openId; const isPicked = picked.includes(item.id); const badges = [...(item.tags ?? []).map((tag) => `#${tag}`), item.audioStatus === 'ready' ? tr('有录音') : '', item.audioStatus === 'encoding' ? tr('正在保存录音') : '', item.summaryStatus === 'ready' ? tr('已总结') : ''].filter(Boolean); return <div className={`panel-list-item transcript-row${open ? ' selected' : ''}${isPicked ? ' picked' : ''}`} key={item.id}><label className="record-toggle record-pick"><input type="checkbox" checked={isPicked} onChange={(event) => setPicked((current) => event.target.checked ? [...current, item.id] : current.filter((id) => id !== item.id))} aria-label={item.title} /></label><button className="panel-list-item" data-transcript-id={item.id} aria-current={open ? 'true' : undefined} onClick={() => void select(item)} disabled={detailLoading}><span className="record-text"><strong>{item.starred ? '★ ' : ''}{item.title}</strong><small>{item.languageA.toUpperCase()} {item.mode === 'two_way' ? '↔' : '→'} {item.languageB.toUpperCase()} · {item.mode === 'two_way' ? tr('对话模式') : tr('课堂模式')} · {formatDurationMs(item.durationMs)}</small>{badges.length > 0 && <span className="record-badges">{badges.map((badge) => <span className="record-badge" key={badge}>{badge}</span>)}</span>}</span><ChevronRightIcon className="list-chevron" /></button></div>; })}</div>{nextCursor && <button className="secondary-button" onClick={() => void refresh(nextCursor)}>{tr('加载更多')}</button>}</div>}{detailScreen && <div className="detail-backbar"><button type="button" className="link-button detail-back" onClick={leaveDetail}><ChevronLeftIcon size={16} />{tr('返回列表')}</button></div>}{detailLoading && <ListSkeleton label={tr('正在加载详情…')} rows={2} />}{notice && <div className="form-message success-message" role="status">{notice}</div>}{detailError && <div className="form-message" role="status">{detailError}</div>}{selected && <div className="transcript-detail"><section className="detail-section"><h3 className="detail-heading">{tr('记录信息')}</h3><div className="title-row"><span className="provider-note">{selected.mode === 'two_way' ? tr('对话模式') : tr('课堂模式')}</span><input value={title} onChange={(event) => setTitle(event.target.value)} aria-label={tr('标题')} /><button className="secondary-button" onClick={() => void saveTitle()} disabled={busy === 'title'}>{tr('保存标题')}</button><button className="secondary-button" onClick={() => void saveMeta({ starred: !selected.starred })}>{selected.starred ? tr('取消星标') : tr('加星')}</button><select value={selected.folderId ?? ''} aria-label={tr('文件夹')} onChange={(event) => void saveMeta({ folderId: event.target.value || null })}><option value="">{tr('未分组')}</option>{folders.map((folder) => <option value={folder.id} key={folder.id}>{folder.name}</option>)}</select></div><form className="term-form" onSubmit={(event) => void addTag(event)}><input value={tagDraft} onChange={(event) => setTagDraft(event.target.value)} placeholder={tr('添加标签')} aria-label={tr('标签')} />{(selected.tags ?? []).map((tag) => <button type="button" className="secondary-button" key={tag} onClick={() => void saveMeta({ tags: (selected.tags ?? []).filter((item) => item !== tag) })}>{tag} ×</button>)}<button className="secondary-button" type="submit">{tr('添加标签')}</button></form></section>{(selected.audioStatus === 'ready' || selected.audioStatus === 'encoding') && <section className="detail-section meeting-audio"><h3 className="detail-heading">{tr('录音')}</h3>{audioUrl ? <audio ref={audioRef} controls src={audioUrl} onTimeUpdate={syncPlayhead} onSeeked={syncPlayhead} onEnded={() => setPlayheadMs(null)} /> : <p className="provider-note">{tr('正在加载录音…')}</p>}{audioUrl && <p className="provider-note">{tr('点击一句字幕，录音会跳到对应时间。')}</p>}{selected.audioStatus === 'encoding' && <p className="provider-note">{tr('正在转换为 MP3')}</p>}{audioUrl && <a className="secondary-button audio-download" href={`${audioUrl}&download=1`}>{tr('下载录音')}</a>}{selected.audioError && <p className="provider-note">{tr(selected.audioError)}</p>}</section>}{selected.audioStatus === 'failed' && <p className="provider-note">{tr(selected.audioError || '录音保存失败')}</p>}<section className="detail-section"><h3 className="detail-heading">{tr('纪要')}</h3><div className="summary-controls"><label>{tr('纪要模板')}<select value={template} onChange={(event) => setTemplate(event.target.value as 'meeting' | 'classroom' | 'interview' | 'briefing')} disabled={running}><option value="meeting">{tr('会议纪要')}</option><option value="classroom">{tr('课堂笔记')}</option><option value="interview">{tr('访谈纪要')}</option><option value="briefing">{tr('简报')}</option></select></label><label>{tr('输出语言')}<select value={outputLanguage} onChange={(event) => setOutputLanguage(event.target.value)} disabled={running}>{LANGUAGE_OPTIONS.map((option) => <option value={option.nativeName} key={option.code}>{option.nativeName}</option>)}</select></label>{providerChoice === 'platform' && <span className="provider-note">{(selected.summaryQuoteSeconds ?? 0) > 0 ? tr('预计消耗 {count} 分钟').replace('{count}', String(Math.ceil((selected.summaryQuoteSeconds ?? 0) / 60))) : tr('不消耗会员分钟')}</span>}{needsKey && <span className="provider-note">{tr('纪要需要平台模型，或在账户里保存自己的密钥。')}</span>}{selected.summaryStale && <span className="provider-note">{tr('字幕已修改，可重新生成纪要。')}</span>}{needsKey ? <button type="button" className="primary-button" onClick={() => onOpenAccount?.()}>{tr('去账户保存密钥')}</button> : <button className="primary-button" onClick={() => void generate()} disabled={!providerLoaded || running || busy === 'summary' || (providerChoice === 'platform' && (!platformAvailable || platformShort))}>{running ? tr('纪要生成中…') : selected.summaryMarkdown ? tr('重新生成') : tr('生成纪要')}</button>}{running && <button className="secondary-button" onClick={() => void cancel()} disabled={busy === 'cancel'}>{tr('取消生成')}</button>}<details className="summary-advanced"><summary>{tr('更换总结模型')}</summary><label>{tr('总结模型')}<select value={providerChoice} onChange={(event) => setProviderChoice(event.target.value as 'platform' | 'byok')} disabled={running}><option value="byok">{tr('我的模型')}</option>{platformAvailable && <option value="platform">{tr('平台模型')}</option>}</select></label></details></div>{selected.summaryError && selected.summaryStatus === 'failed' && <p className="form-message" role="alert">{tr(selected.summaryError)}</p>}{(selected.tasks?.length ?? 0) > 0 && <div className="task-box"><div className="task-head"><strong>{tr('待办')}</strong><button type="button" className="link-button" onClick={() => { void navigator.clipboard.writeText((selected.tasks ?? []).map((item) => `- ${item.text}`).join('\n')).then(() => setNotice(tr('待办已复制。'))).catch(() => setDetailError(tr('当前浏览器不允许复制，请手动选择文本。'))); }}>{tr('复制待办')}</button></div>{selected.tasks?.map((task) => <label key={task.id}><input type="checkbox" checked={task.done} onChange={() => void toggleTask(task)} /><span>{task.text}</span></label>)}</div>}{selected.summaryMarkdown && !(selected.tasks?.length) && <ActionList markdown={selected.summaryMarkdown} checks={selected.summaryChecks ?? []} onToggle={(item) => void toggleCheck(item)} onCopy={() => setNotice(tr('待办已复制。'))} />}<div className="summary-view">{editing ? <textarea className="summary-editor" value={draft} onChange={(event) => setDraft(event.target.value)} /> : selected.summaryMarkdown ? renderSummary(selected.summaryMarkdown) : <p>{tr('尚未生成纪要')}</p>}{selected.summaryEditedAt && !editing && <p className="provider-note">{tr('这份纪要已手动编辑。')}</p>}<div className="detail-actions">{selected.summaryMarkdown && !editing && <button className="secondary-button" onClick={() => { setDraft(selected.summaryMarkdown ?? ''); setEditing(true); }}>{tr('编辑纪要')}</button>}{editing && <button className="secondary-button" onClick={() => void saveSummary()} disabled={busy === 'edit'}>{tr('保存纪要')}</button>}{editing && <button className="secondary-button" onClick={() => setEditing(false)}>{tr('取消编辑')}</button>}</div></div></section><details className="detail-fold"><summary>{tr('导出')}<ChevronRightIcon size={16} className="fold-chevron" /></summary><div className="export-grid"><button className="secondary-button" onClick={() => void copySelected()}>{tr('复制')}</button><button className="secondary-button" onClick={() => void exportTranscript('md')} disabled={Boolean(exporting)}>{exporting === 'md-full' ? tr('导出中…') : tr('导出 Markdown')}</button><button className="secondary-button" onClick={() => void exportTranscript('pdf', 'summary')} disabled={Boolean(exporting) || !selected.summaryMarkdown}>{exporting === 'pdf-summary' ? tr('导出中…') : tr('导出 PDF 纪要')}</button><button className="secondary-button" onClick={() => void exportTranscript('pdf', 'full')} disabled={Boolean(exporting)}>{exporting === 'pdf-full' ? tr('导出中…') : tr('导出 PDF 全文')}</button><button className="secondary-button" onClick={() => void exportTranscript('txt')} disabled={Boolean(exporting)}>TXT</button><button className="secondary-button" onClick={() => void exportTranscript('srt')} disabled={Boolean(exporting)}>SRT</button><button className="secondary-button" onClick={() => void exportTranscript('vtt')} disabled={Boolean(exporting)}>VTT</button></div></details><details className="detail-fold"><summary>{tr('分享')}<ChevronRightIcon size={16} className="fold-chevron" /></summary><div className="share-box"><label className="record-toggle"><input type="checkbox" checked={includeAudioShare} onChange={(event) => setIncludeAudioShare(event.target.checked)} disabled={shareScope === 'summary'} /><span>{tr('包含录音')}</span></label><label>{tr('分享内容')}<select value={shareScope} onChange={(event) => setShareScope(event.target.value as 'full' | 'summary')}><option value="full">{tr('全文')}</option><option value="summary">{tr('只发纪要')}</option></select></label><label>{tr('分享密码')}<input value={sharePassword} onChange={(event) => setSharePassword(event.target.value)} placeholder={tr('留空则不需要密码')} autoComplete="off" /></label><label>{tr('分享有效期')}<select value={shareHours} onChange={(event) => setShareHours(event.target.value)}><option value="720">{tr('30 天')}</option><option value="24">{tr('24 小时')}</option><option value="72">{tr('3 天')}</option><option value="168">{tr('7 天')}</option></select></label><button className="secondary-button" onClick={() => void createShare()}>{tr('创建分享链接')}</button>{shares.filter((share) => !share.revokedAt).length === 0 && <p className="provider-note">{tr('尚未创建分享链接。')}</p>}{shares.filter((share) => !share.revokedAt).map((share) => <div className="share-link" key={share.id}><span>{share.scope === 'summary' ? tr('只发纪要') : tr('全文')} · {share.includeAudio ? tr('含录音') : tr('不含录音')}{share.hasPassword ? ` · ${tr('有密码')}` : ''} · {tr('查看 {count} 次').replace('{count}', String(share.viewCount ?? 0))} · {tr('创建于')} {new Date(share.createdAt).toLocaleString()}{share.expiresAt ? ` · ${tr('到期')} ${new Date(share.expiresAt).toLocaleString()}` : ` · ${tr('永不过期')}`}</span>{share.token ? <button className="link-button" onClick={() => void navigator.clipboard.writeText(`${window.location.origin}/s/${share.token}`).then(() => setNotice(tr('分享链接已复制。'))).catch(() => setDetailError(tr('当前浏览器不允许复制，请手动选择文本。')))}>{tr('复制链接')}</button> : <button className="link-button" onClick={() => void reissueShare(share.id)}>{tr('重新签发')}</button>}<button className="link-button" onClick={() => void revokeShare(share.id)}>{tr('撤销')}</button></div>)}</div></details><section className="detail-section"><div className="detail-heading-row"><h3 className="detail-heading">{tr('字幕')}</h3><span className="caption-count">{selected.segments.length}</span></div>{speakers.length > 0 && <details className="detail-fold speaker-fold"><summary>{tr('把这个说话人全部改名')}<ChevronRightIcon size={16} className="fold-chevron" /></summary><form className="speaker-roster" onSubmit={(event) => { event.preventDefault(); void renameRoster(); }}><select value={speakerFrom} onChange={(event) => setSpeakerFrom(event.target.value)} aria-label={tr('说话人')}><option value="">{tr('说话人')}</option>{speakers.map((speaker) => <option value={speaker} key={speaker}>{speaker}</option>)}</select><input value={speakerTo} onChange={(event) => setSpeakerTo(event.target.value)} placeholder={tr('全部改为')} aria-label={tr('全部改为')} /><button className="secondary-button" type="submit" disabled={busy === 'segment' || !speakerFrom || !speakerTo.trim()}>{tr('全部改名')}</button></form></details>}<div className="caption-list">{selected.segments.map((segment, index) => { const nextStart = nextStarts[index]; const clock = playheadMs === null ? null : playheadMs + 200; const active = clock !== null && segment.startMs !== null && segment.startMs <= clock && (nextStart === undefined || clock < nextStart); const seekable = Boolean(audioUrl) && segment.startMs !== null; const meta = [segment.speaker ? `${tr('说话人')} ${segment.speaker}` : '', segment.startMs !== null ? formatClockMs(segment.startMs) : ''].filter(Boolean).join(' · '); const editingRow = segmentEdit?.id === segment.id; const body = editingRow && segmentEdit ? <div className="term-form"><input value={segmentEdit.source} onChange={(event) => setSegmentEdit({ ...segmentEdit, source: event.target.value })} aria-label={tr('原文术语')} /><input value={segmentEdit.translation} onChange={(event) => setSegmentEdit({ ...segmentEdit, translation: event.target.value })} aria-label={tr('指定译法')} /><input value={segmentEdit.speaker} onChange={(event) => setSegmentEdit({ ...segmentEdit, speaker: event.target.value })} aria-label={tr('说话人')} /><button className="secondary-button" onClick={() => void saveSegment()} disabled={busy === 'segment'}>{tr('保存字幕')}</button>{segmentEdit.originalSpeaker && segmentEdit.speaker !== segmentEdit.originalSpeaker && <button className="secondary-button" onClick={() => void renameSpeaker()} disabled={busy === 'segment'}>{tr('全部改名')}</button>}<button className="secondary-button" onClick={() => setSegmentEdit(null)}>{tr('取消')}</button></div> : <><p>{segment.sourceText}</p><strong>{segment.translationText}</strong></>; const head = <div className="caption-head"><span className="caption-meta">{meta}</span><span className="caption-actions"><button type="button" className="icon-button caption-action" onClick={() => setSegmentEdit({ id: segment.id, source: segment.sourceText, translation: segment.translationText, speaker: segment.speaker ?? '', originalSpeaker: segment.speaker ?? '' })} aria-label={tr('编辑字幕')} title={tr('编辑字幕')}><EditIcon size={16} /></button><button type="button" className="icon-button caption-action" onClick={() => beginTerm(segment)} aria-label={tr('加入术语库')} title={tr('加入术语库')}><BookIcon size={16} /></button></span></div>; const glossaryForm = termDraft?.segmentId === segment.id ? <form className="term-form" onSubmit={(event) => void saveCaptionTerm(event)}><select value={termDraft.glossaryId} onChange={(event) => { const nextId = event.target.value; const previous = glossaries.find((item) => item.id === termDraft.glossaryId); const next = glossaries.find((item) => item.id === nextId); const previousReversed = Boolean(previous && selected && glossaryDirection(previous, selected.languageA, selected.languageB) === 'reversed'); const nextReversed = Boolean(next && selected && glossaryDirection(next, selected.languageA, selected.languageB) === 'reversed'); const swap = previousReversed !== nextReversed; setTermDraft({ ...termDraft, glossaryId: nextId, source: swap ? termDraft.target : termDraft.source, target: swap ? termDraft.source : termDraft.target }); }} aria-label={tr('选择术语库')}>{glossaries.map((item) => <option value={item.id} key={item.id}>{glossaryOptionLabel(item)}</option>)}</select><input value={termDraft.source} maxLength={200} onChange={(event) => setTermDraft({ ...termDraft, source: event.target.value })} aria-label={tr('原文术语')} /><input value={termDraft.target} maxLength={200} onChange={(event) => setTermDraft({ ...termDraft, target: event.target.value })} aria-label={tr('指定译法')} /><button className="secondary-button" type="submit" disabled={busy === 'term'}>{tr('保存到术语库')}</button><button type="button" className="secondary-button" onClick={() => setTermDraft(null)}>{tr('取消')}</button></form> : null; return <div className="caption-edit" key={segment.id}>{!editingRow && head}{glossaryForm}{seekable && !editingRow ? <button type="button" className={`caption-row seekable${active ? ' active' : ''}`} ref={active ? activeRowRef : undefined} onClick={() => seekTo(segment.startMs)}>{body}</button> : <div className={`caption-row${active ? ' active' : ''}`}>{body}</div>}</div>; })}</div></section><div className="detail-actions detail-danger"><button className="danger-button" onClick={() => void removeSelected()}>{tr('删除这条记录')}</button></div></div>}</div></PanelShell>;
}