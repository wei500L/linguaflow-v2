/** Server checkpoint promise: finals already received by this process, not audio still on the device. */
export const CHECKPOINT_WINDOW_MS = 5_000;
export const CHECKPOINT_FAILURE_STOP_MS = 15_000;
export const OWNER_STALE_MS = 45_000;
export const TRASH_RETAIN_MS = 7 * 24 * 60 * 60 * 1000;
export const RECONNECT_DEADLINE_MS = 20_000;
export const CLASS_EXAMPLE_SECONDS = 90 * 60;
export const EVENT_RETAIN_MS = 90 * 24 * 60 * 60 * 1000;

export const SUMMARY_TEMPLATE_IDS = ['meeting', 'classroom', 'interview', 'briefing'] as const;
export type SummaryTemplateId = (typeof SUMMARY_TEMPLATE_IDS)[number];
export type ShareIntent = 'personal' | 'audience';
export type RecordLifecycle = 'active' | 'incomplete' | 'complete';
export type SaveState = 'pending' | 'saved' | 'failed';
export type GapSource = 'user_pause' | 'system_suspend' | 'reconnect' | 'queue_overflow' | 'dropped';
export type GapPrecision = 'exact' | 'estimated' | 'unknown';
export type MarkerKind = 'important' | 'unclear' | 'assignment';
export type NoteAuthor = 'ai' | 'human' | 'restore';
export type SupportKind = 'feedback' | 'activation' | 'free_review';
export type SupportStatus = 'open' | 'in_progress' | 'resolved' | 'rejected';

export type AudioGap = {
  id: string;
  source: GapSource;
  wallStartMs: number | null;
  wallEndMs: number | null;
  audioStartMs: number | null;
  audioEndMs: number | null;
  precision: GapPrecision;
};

export type PersistedSegment = {
  id: string;
  source: string;
  translation: string;
  speaker: string | null;
  language: string | null;
  startMs: number | null;
  endMs: number | null;
  sourceHash: string;
};

export type FoldedTurn = {
  source: string;
  translation: string;
  speaker?: string;
  language?: string;
  startMs?: number;
  endMs?: number;
  interim: boolean;
};

export const PRODUCT_EVENTS = [
  'onboarding_started',
  'onboarding_completed',
  'session_start_attempted',
  'session_ready',
  'session_first_caption',
  'connection_interrupted',
  'connection_recovered',
  'audio_gap',
  'record_persisted',
  'record_finished',
  'record_failed',
  'record_recovered',
  'record_opened',
  'audio_playback_started',
  'export_succeeded',
  'summary_requested',
  'summary_succeeded',
  'summary_failed',
  'summary_cancelled',
  'audience_sharing_enabled',
  'audience_sharing_revoked',
  'support_submitted',
  'activation_requested',
  'latency_sample'
] as const;
export type ProductEventName = (typeof PRODUCT_EVENTS)[number];

const RECOVERABLE_STATUS = new Set(['connecting', 'active', 'reconnecting', 'stopping', 'saving']);

export function checkpointFailureAction(failures: number, elapsedMs: number) {
  if (failures >= 3 || elapsedMs >= CHECKPOINT_FAILURE_STOP_MS) return 'stop' as const;
  return 'retry' as const;
}

export function shouldRecoverSession(input: {
  endedAtMs: number | null;
  status: string;
  ownerHeartbeatMs: number | null;
  nowMs: number;
  hasLiveRoom: boolean;
}) {
  if (input.endedAtMs != null || input.hasLiveRoom) return false;
  if (!RECOVERABLE_STATUS.has(input.status)) return false;
  if (input.ownerHeartbeatMs == null) return true;
  return input.nowMs - input.ownerHeartbeatMs >= OWNER_STALE_MS;
}

/** Bill from the last live checkpoint. `nowMs` is accepted so callers cannot silently substitute cleanup time. */
export function billableSecondsFromCheckpoint(input: {
  startedAtMs: number | null;
  activeUntilMs: number | null;
  audioMs: number;
  maxSessionSeconds: number;
  reservedSeconds: number;
  nowMs?: number;
}) {
  void input.nowMs;
  const cap = Math.max(0, Math.min(input.maxSessionSeconds, input.reservedSeconds));
  if (input.startedAtMs == null || input.activeUntilMs == null) return Math.min(cap, Math.ceil(Math.max(0, input.audioMs) / 1000));
  const wall = Math.max(0, Math.ceil((input.activeUntilMs - input.startedAtMs) / 1000));
  return Math.min(cap, wall);
}

export function repairedPcmLength(fileSize: number) {
  if (!Number.isFinite(fileSize) || fileSize <= 44) return 0;
  const pcm = Math.floor(fileSize - 44);
  return pcm - (pcm % 2);
}

export function sourceHash(source: string) {
  let hash = 2166136261;
  const text = source.trim();
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function mergePersistedSegments(previous: PersistedSegment[], folded: FoldedTurn[], allocateId: () => string): PersistedSegment[] {
  const committed = folded.filter((turn) => !turn.interim && (turn.source.trim() || turn.translation.trim()));
  const used = new Set<string>();
  const result: PersistedSegment[] = [];
  let cursor = 0;
  for (const turn of committed) {
    const source = turn.source.trim();
    const translation = turn.translation.trim();
    let match: PersistedSegment | undefined;
    for (let index = cursor; index < previous.length; index += 1) {
      const candidate = previous[index];
      if (!candidate || used.has(candidate.id)) continue;
      const sameStart = candidate.startMs != null && turn.startMs != null && candidate.startMs === turn.startMs;
      const sameSource = candidate.source === source && source.length > 0;
      const extendsSource = candidate.source.length > 0 && source.startsWith(candidate.source);
      const splitSource = source.length > 0 && candidate.source.startsWith(source) && sameStart;
      if (sameSource || (sameStart && (extendsSource || splitSource || candidate.source === source)) || (extendsSource && (sameStart || candidate.startMs == null))) {
        match = candidate;
        cursor = index + 1;
        break;
      }
    }
    const id = match?.id ?? allocateId();
    used.add(id);
    result.push({
      id,
      source,
      translation: translation || match?.translation || '',
      speaker: turn.speaker ?? match?.speaker ?? null,
      language: turn.language ?? match?.language ?? null,
      startMs: turn.startMs ?? match?.startMs ?? null,
      endMs: turn.endMs ?? match?.endMs ?? null,
      sourceHash: sourceHash(source)
    });
  }
  return result;
}

export type SummarySegmentInput = {
  id: string;
  idx: number;
  speaker?: string | null;
  startMs?: number | null;
  sourceText: string;
  translationText: string;
};

export function summaryInputHash(segments: SummarySegmentInput[]) {
  const rows = [...segments].sort((left, right) => left.idx - right.idx || left.id.localeCompare(right.id));
  return sourceHash(rows.map((segment) => [segment.id, segment.idx, segment.speaker ?? '', segment.startMs ?? '', segment.sourceText, segment.translationText].join('\u001f')).join('\n'));
}

export function summaryRefreshAction(previousHash: string | null, nextHash: string) {
  if (!previousHash || previousHash === nextHash) return 'unchanged' as const;
  return 'mark_stale' as const;
}

export type SummaryQuote = {
  provider: 'platform' | 'byok';
  seconds: number;
  inputHash: string;
  inputVersion: number;
  template: SummaryTemplateId;
};

export function quoteMatches(quote: SummaryQuote, next: SummaryQuote) {
  return quote.provider === next.provider && quote.seconds === next.seconds && quote.inputHash === next.inputHash && quote.inputVersion === next.inputVersion && quote.template === next.template;
}

export function defaultSummaryTemplate(mode: 'one_way' | 'two_way', courseTemplate?: string | null): SummaryTemplateId {
  if (courseTemplate && (SUMMARY_TEMPLATE_IDS as readonly string[]).includes(courseTemplate)) return courseTemplate as SummaryTemplateId;
  return mode === 'one_way' ? 'classroom' : 'meeting';
}

export function classCoverage(spec: { monthlySeconds: number | null; maxSessionSeconds: number }) {
  const monthlySeconds = spec.monthlySeconds;
  return {
    exampleSeconds: CLASS_EXAMPLE_SECONDS,
    classes: monthlySeconds === null ? null : Math.floor(monthlySeconds / CLASS_EXAMPLE_SECONDS),
    sessionFits: spec.maxSessionSeconds >= CLASS_EXAMPLE_SECONDS,
    monthlySeconds,
    maxSessionSeconds: spec.maxSessionSeconds
  };
}

export function isIanaTimeZone(value: string) {
  if (!value || value.length > 64 || !/^[A-Za-z0-9_+/-]+$/.test(value)) return false;
  try {
    Intl.DateTimeFormat('en-US', { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

export function languageRelation(mode: string, languageA: string, languageB: string) {
  return mode === 'two_way' ? `${languageA} ↔ ${languageB}` : `${languageA} → ${languageB}`;
}

export function citationState(segmentId: string, snapshotHash: string | undefined, current: { source: string } | undefined, verified = true) {
  if (!current) return 'missing' as const;
  if (!verified) return 'unverified' as const;
  if (!snapshotHash || snapshotHash === sourceHash(current.source)) return 'ok' as const;
  return 'changed' as const;
}

/** A held summary charge is settled only when this request already wrote the note. An older ready note does not count. */
export function summaryHoldRecovery(input: {
  requestStatus: string | null;
  requestHash: string | null;
  requestCreatedAtMs: number | null;
  transcriptStatus: string | null;
  sourceHash: string | null;
  generatedAtMs: number | null;
}) {
  const produced = input.requestStatus === 'running'
    && input.transcriptStatus === 'ready'
    && input.sourceHash != null
    && input.sourceHash === input.requestHash
    && input.generatedAtMs != null
    && input.requestCreatedAtMs != null
    && input.generatedAtMs >= input.requestCreatedAtMs;
  return produced ? 'settle' as const : 'refund' as const;
}

/** A lost success can be replayed. A failed or cancelled confirmation has to start again. */
export function summaryReplay(status: string) {
  return status === 'ready' || status === 'running' ? 'return' as const : 'restart' as const;
}

const SEGMENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function shieldMathAndCode(markdown: string) {
  const slots: string[] = [];
  const shielded = markdown.replace(/```[\s\S]*?```|\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, (match) => {
    const token = `\u0000${slots.length}\u0000`;
    slots.push(match);
    return token;
  });
  return { shielded, slots };
}

export function sanitizeModelMarkdown(markdown: string, validIds: ReadonlySet<string>, hashes?: Record<string, string>, current?: Record<string, string>, annotateChanged = true) {
  const { shielded, slots } = shieldMathAndCode(markdown);
  const withoutTags = shielded
    .replace(/<script[\s\S]*?>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?>[\s\S]*?<\/style>/gi, '')
    .replace(/<\/?[a-z][^>\n]*>/gi, '');
  const noBadLinks = withoutTags.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (whole, label: string, href: string) => {
    const target = href.trim();
    if (/^https?:\/\//i.test(target)) return whole;
    return label;
  });
  return noBadLinks.replace(/\[\[seg:([^\]]+)\]\]/g, (_whole, id: string) => {
    const clean = String(id).trim();
    if (!SEGMENT_ID.test(clean) || !validIds.has(clean)) return '「来源不可用」';
    const snapshot = hashes?.[clean];
    if (snapshot && current && current[clean] === undefined) return '「来源不可用」';
    if (annotateChanged && snapshot && current && current[clean] !== undefined && snapshot !== sourceHash(current[clean] ?? '')) return `[[seg:${clean}]]（来源已变化）`;
    return `[[seg:${clean}]]`;
  }).replace(/\u0000(\d+)\u0000/g, (_whole, index: string) => slots[Number(index)] ?? '');
}

const SUPERSCRIPT: Record<string, string> = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '+': '⁺', '-': '⁻', '=': '⁼', '(': '⁽', ')': '⁾', n: 'ⁿ', i: 'ⁱ' };
const SUBSCRIPT: Record<string, string> = { '0': '₀', '1': '₁', '2': '₂', '3': '₃', '4': '₄', '5': '₅', '6': '₆', '7': '₇', '8': '₈', '9': '₉', '+': '₊', '-': '₋', '=': '₌', '(': '₍', ')': '₎', a: 'ₐ', e: 'ₑ', o: 'ₒ', x: 'ₓ', n: 'ₙ', i: 'ᵢ' };
const SYMBOLS: Record<string, string> = {
  alpha: 'α', beta: 'β', gamma: 'γ', delta: 'δ', epsilon: 'ε', theta: 'θ', lambda: 'λ', mu: 'μ', pi: 'π', sigma: 'σ', phi: 'φ', omega: 'ω',
  Gamma: 'Γ', Delta: 'Δ', Theta: 'Θ', Lambda: 'Λ', Pi: 'Π', Sigma: 'Σ', Phi: 'Φ', Omega: 'Ω',
  times: '×', cdot: '·', leq: '≤', geq: '≥', neq: '≠', infty: '∞', pm: '±', to: '→', rightarrow: '→'
};

function scriptDigits(value: string, table: Record<string, string>) {
  let out = '';
  for (const char of value) {
    const mapped = table[char];
    if (!mapped) return null;
    out += mapped;
  }
  return out;
}

/** Readable fallback. `ok` is false when a command could not be rendered; the original source is preserved by the caller. */
export function renderMathPlain(source: string): { text: string; ok: boolean } {
  let text = source.trim();
  let ok = true;
  text = text.replace(/\\frac\{([^{}]+)\}\{([^{}]+)\}/g, '($1)/($2)');
  text = text.replace(/\^\{([^{}]+)\}/g, (_, body: string) => {
    const mapped = scriptDigits(body, SUPERSCRIPT);
    if (mapped == null) { ok = false; return `^(${body})`; }
    return mapped;
  });
  text = text.replace(/_\{([^{}]+)\}/g, (_, body: string) => {
    const mapped = scriptDigits(body, SUBSCRIPT);
    if (mapped == null) { ok = false; return `_(${body})`; }
    return mapped;
  });
  text = text.replace(/\\([A-Za-z]+)/g, (whole, name: string) => {
    const mapped = SYMBOLS[name];
    if (!mapped) { ok = false; return whole; }
    return mapped;
  });
  if (/[{}\\]/.test(text)) ok = false;
  return { text, ok };
}

export type RichInline =
  | { type: 'text'; text: string }
  | { type: 'strong'; text: string }
  | { type: 'code'; text: string }
  | { type: 'link'; href: string; text: string }
  | { type: 'cite'; segmentId: string; state: 'ok' | 'changed' | 'missing' | 'unverified' }
  | { type: 'math'; source: string; text: string; ok: boolean };

export type RichBlock =
  | { type: 'heading'; level: number; inlines: RichInline[] }
  | { type: 'paragraph'; inlines: RichInline[] }
  | { type: 'list'; items: RichInline[][] }
  | { type: 'code'; text: string };

function parseInlines(line: string, cite: (id: string) => 'ok' | 'changed' | 'missing' | 'unverified'): RichInline[] {
  const inlines: RichInline[] = [];
  const pattern = /\[\[seg:([0-9a-f-]{36})\]\]|\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|\$\$([^$]+)\$\$|\$([^$\n]+)\$/gi;
  let cursor = 0;
  for (const match of line.matchAll(pattern)) {
    const index = match.index ?? 0;
    if (index > cursor) inlines.push({ type: 'text', text: line.slice(cursor, index) });
    if (match[1]) inlines.push({ type: 'cite', segmentId: match[1], state: cite(match[1]) });
    else if (match[2] && match[3]) inlines.push({ type: 'link', text: match[2], href: match[3] });
    else if (match[4]) inlines.push({ type: 'strong', text: match[4] });
    else if (match[5]) inlines.push({ type: 'code', text: match[5] });
    else {
      const source = (match[6] ?? match[7] ?? '').trim();
      const rendered = renderMathPlain(source);
      inlines.push({ type: 'math', source, text: rendered.ok ? rendered.text : source, ok: rendered.ok });
    }
    cursor = index + match[0].length;
  }
  if (cursor < line.length) inlines.push({ type: 'text', text: line.slice(cursor) });
  return inlines.length ? inlines : [{ type: 'text', text: line }];
}

export function parseSafeMarkdown(markdown: string, cite: (id: string) => 'ok' | 'changed' | 'missing' | 'unverified' = () => 'missing'): RichBlock[] {
  const blocks: RichBlock[] = [];
  const lines = markdown.replace(/\r\n/g, '\n').split('\n');
  let paragraph: string[] = [];
  let list: RichInline[][] = [];
  const flushParagraph = () => {
    if (!paragraph.length) return;
    blocks.push({ type: 'paragraph', inlines: parseInlines(paragraph.join(' '), cite) });
    paragraph = [];
  };
  const flushList = () => {
    if (!list.length) return;
    blocks.push({ type: 'list', items: list });
    list = [];
  };
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? '';
    if (line.startsWith('```')) {
      flushParagraph();
      flushList();
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !(lines[index] ?? '').startsWith('```')) {
        body.push(lines[index] ?? '');
        index += 1;
      }
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      flushParagraph();
      flushList();
      blocks.push({ type: 'heading', level: heading[1]?.length ?? 1, inlines: parseInlines(heading[2] ?? '', cite) });
      continue;
    }
    const item = /^[-*]\s+(.*)$/.exec(line);
    if (item) {
      flushParagraph();
      list.push(parseInlines(item[1] ?? '', cite));
      continue;
    }
    if (!line.trim()) {
      flushParagraph();
      flushList();
      continue;
    }
    flushList();
    paragraph.push(line.trim());
  }
  flushParagraph();
  flushList();
  return blocks;
}

export function gapDurationText(gap: AudioGap) {
  const start = gap.source === 'user_pause' ? gap.wallStartMs : gap.audioStartMs ?? gap.wallStartMs;
  const end = gap.source === 'user_pause' ? gap.wallEndMs : gap.audioEndMs ?? gap.wallEndMs;
  if (gap.precision === 'unknown' || start == null || end == null) return '不确定';
  const seconds = Math.max(0, Math.round((end - start) / 1000));
  return gap.precision === 'estimated' ? `大约 ${seconds} 秒` : `${seconds} 秒`;
}

export function gapIsLoss(gap: AudioGap) {
  return gap.source !== 'user_pause';
}

export function shouldRecordReconnectGap(droppedMs: number) {
  return droppedMs > 0;
}

/** Delay, silence, and an empty caption stream are not evidence that audio was discarded. */
export function captureLossFromSignals(input: { latencyMs: number | null; captionCount: number; quiet: boolean; droppedMs: number }) {
  if (input.droppedMs > 0) return { source: 'queue_overflow' as const, droppedMs: input.droppedMs };
  return null;
}

export function reconnectDelayMs(attempt: number) {
  return Math.min(4_000, 400 * 2 ** Math.max(0, attempt));
}

export function reconnectExhausted(startedMs: number, nowMs: number) {
  return nowMs - startedMs >= RECONNECT_DEADLINE_MS;
}

export function acceptLiveEvent(input: { currentSocket: boolean; userStop: boolean; type: string }) {
  if (!input.currentSocket) return false;
  if (!input.userStop) return true;
  return input.type === 'transcript' || input.type === 'finished' || input.type === 'error' || input.type === 'save_status' || input.type === 'snapshot' || input.type === 'marker_ack' || input.type === 'gap_ack';
}

export function sessionOutcome(input: { recordStatus: RecordLifecycle | null; saveState: SaveState; transcriptId: string | null }) {
  if (input.saveState === 'failed' && !input.transcriptId) return 'failed' as const;
  if (!input.transcriptId) return 'empty' as const;
  if (input.recordStatus === 'incomplete' || input.saveState === 'failed') return 'partial' as const;
  if (input.recordStatus === 'active') return 'in_progress' as const;
  return 'saved' as const;
}

export function purgeDue(purgeAfterMs: number | null, nowMs: number) {
  return purgeAfterMs != null && purgeAfterMs <= nowMs;
}

export function sharesRevivedOnRestore() {
  return false;
}

export function claimBlocksFreeUse(key: string | undefined) {
  if (!key || key.startsWith('ip:')) return false;
  return true;
}

export function freeBlockReason(keys: Array<{ key?: string; blocks: boolean }>) {
  const blocking = keys.filter((item) => item.blocks && claimBlocksFreeUse(item.key));
  if (blocking.some((item) => item.key?.startsWith('dom:'))) return 'domain' as const;
  if (blocking.length) return 'device' as const;
  return null;
}

export type EventProps = Record<string, string | number | boolean | null>;

const EVENT_PROP_KEYS = new Set(['sessionId', 'transcriptId', 'template', 'provider', 'reason', 'source', 'status', 'mode', 'plan', 'samples', 'recognitionP50', 'recognitionP95', 'translationP50', 'translationP95', 'gapSource', 'recordStatus']);

export function sanitizeEventProps(props: EventProps | undefined) {
  const clean: EventProps = {};
  if (!props) return clean;
  for (const [key, value] of Object.entries(props)) {
    if (!EVENT_PROP_KEYS.has(key)) continue;
    if (typeof value === 'string') clean[key] = value.slice(0, 80);
    else if (typeof value === 'number' && Number.isFinite(value)) clean[key] = value;
    else if (typeof value === 'boolean' || value === null) clean[key] = value;
  }
  return clean;
}

export function percentile(values: number[], ratio: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return sorted[index] ?? null;
}

export type MetricEvent = { name: string; createdAtMs: number; userId?: string | null; props: EventProps };

function idsFor(rows: MetricEvent[], name: string) {
  return new Set(rows.filter((event) => event.name === name && typeof event.props.sessionId === 'string').map((event) => String(event.props.sessionId)));
}

export function summarizeProductMetrics(events: MetricEvent[], fromMs: number, toMs: number, options?: { truncated?: boolean }) {
  const rows = events.filter((event) => event.createdAtMs >= fromMs && event.createdAtMs < toMs);
  const count = (name: string) => rows.filter((event) => event.name === name).length;
  const attempted = count('session_start_attempted');
  const ready = count('session_ready');
  const firstCaption = count('session_first_caption');
  const persisted = count('record_persisted');
  const finished = count('record_finished');
  const failed = count('record_failed');
  const recovered = count('record_recovered');
  const gaps = count('audio_gap');
  const opened = count('record_opened');
  const playback = count('audio_playback_started');
  const exported = count('export_succeeded');
  const summaryRequested = count('summary_requested');
  const summarySucceeded = count('summary_succeeded');
  const recognition = rows.filter((event) => event.name === 'latency_sample' && typeof event.props.recognitionP50 === 'number');
  const translation = rows.filter((event) => event.name === 'latency_sample' && typeof event.props.translationP50 === 'number');
  const sampleCount = recognition.reduce((sum, event) => sum + (typeof event.props.samples === 'number' ? event.props.samples : 0), 0);
  return {
    empty: rows.length === 0,
    window: { fromMs, toMs },
    counts: {
      onboardingStarted: count('onboarding_started'),
      onboardingCompleted: count('onboarding_completed'),
      attempted,
      ready,
      firstCaption,
      interrupted: count('connection_interrupted'),
      recoveredConnections: count('connection_recovered'),
      gaps,
      persisted,
      finished,
      failed,
      recovered,
      opened,
      playback,
      exported,
      summaryRequested,
      summarySucceeded,
      summaryFailed: count('summary_failed'),
      summaryCancelled: count('summary_cancelled'),
      audienceEnabled: count('audience_sharing_enabled'),
      audienceRevoked: count('audience_sharing_revoked'),
      support: count('support_submitted'),
      activation: count('activation_requested')
    },
    rates: {
      firstCaption: { numerator: idsFor(rows, 'session_first_caption').size, denominator: idsFor(rows, 'session_start_attempted').size, unknown: Math.max(0, attempted - ready), basis: 'sessions' },
      persisted: { numerator: idsFor(rows, 'record_finished').size, denominator: idsFor(rows, 'record_finished').size + idsFor(rows, 'record_failed').size + idsFor(rows, 'record_recovered').size, unknown: 0, basis: 'sessions' },
      gaps: { numerator: [...idsFor(rows, 'audio_gap')].filter((id) => idsFor(rows, 'record_finished').has(id) || idsFor(rows, 'record_recovered').has(id)).length, denominator: idsFor(rows, 'record_finished').size + idsFor(rows, 'record_recovered').size, unknown: 0, basis: 'sessions_with_a_gap', gapEvents: gaps },
      afterClass: (() => {
        const finishedAt = new Map<string, number>();
        for (const event of rows) {
          if (event.name !== 'record_finished' || typeof event.props.sessionId !== 'string') continue;
          const id = event.props.sessionId;
          const at = finishedAt.get(id);
          if (at == null || event.createdAtMs < at) finishedAt.set(id, event.createdAtMs);
        }
        const used = new Set<string>();
        for (const event of rows) {
          if (!['record_opened', 'audio_playback_started', 'export_succeeded', 'summary_succeeded'].includes(event.name)) continue;
          if (typeof event.props.sessionId !== 'string') continue;
          const ended = finishedAt.get(event.props.sessionId);
          if (ended != null && event.createdAtMs >= ended) used.add(event.props.sessionId);
        }
        return { numerator: used.size, denominator: finishedAt.size, unknown: 0, basis: 'finished_sessions_after_end' };
      })(),
      onboarding: { numerator: count('onboarding_completed'), denominator: count('onboarding_started'), unknown: 0, basis: 'guide' },
      reused: (() => {
        const byUser = new Map<string, number>();
        for (const event of rows) {
          if (event.name !== 'session_start_attempted' || !event.userId) continue;
          byUser.set(event.userId, (byUser.get(event.userId) ?? 0) + 1);
        }
        const users = [...byUser.values()];
        return { numerator: users.filter((value) => value >= 2).length, denominator: users.length, unknown: rows.filter((event) => event.name === 'session_start_attempted' && !event.userId).length, basis: 'users_with_another_session' };
      })()
    },
    latency: {
      basis: 'per_session_percentiles',
      samples: sampleCount,
      sessions: recognition.length,
      recognitionP50: percentile(recognition.map((event) => Number(event.props.recognitionP50)), 0.5),
      recognitionP95: percentile(recognition.map((event) => Number(event.props.recognitionP95 ?? event.props.recognitionP50)), 0.95),
      translationP50: percentile(translation.map((event) => Number(event.props.translationP50)), 0.5),
      translationP95: percentile(translation.map((event) => Number(event.props.translationP95 ?? event.props.translationP50)), 0.95)
    },
    truncated: Boolean(options?.truncated)
  };
}
