/** 16 kHz PCM s16le: two bytes per sample, 32 bytes per millisecond. */
export const BYTES_PER_MS = 32;
const MARK_KEEP_MS = 3 * 60 * 1000;
const SMOOTH_TAU_MS = 1000;
/** With no new result for this long, the readout starts rising with the wait. */
const STALL_AFTER_MS = 1200;
/** Audio already sent beyond the processed cursor before a wait counts as a stall. */
const PENDING_AUDIO_MS = 200;

export type AudioMark = {
  audioEndMs: number;
  durationMs: number;
  /** performance.now() at the moment the last sample of the chunk was captured. */
  capturedAt: number;
};

export type LatencyTrack = {
  /** Furthest audio position already sampled. Older positions must not move the readout. */
  cursorMs: number | null;
  smooth: number | null;
  sampledAt: number | null;
};

export type LatencyClock = {
  marks: AudioMark[];
  sentAudioMs: number;
  /** Audio captured earlier was queued while connecting and only measures the backlog. */
  measureFrom: number | null;
  /** End of the newest final spoken token that still expects a translation. */
  finalSourceEndMs: number | null;
  recognition: LatencyTrack;
  translation: LatencyTrack;
};

export type StampedChunk = {
  durationMs: number;
  capturedAt: number;
};

export type LatencyReadout = {
  recognition: number | null;
  translation: number | null;
};

export type LatencySamples = { recognition: number[]; translation: number[] };

export function emptyLatencySamples(): LatencySamples {
  return { recognition: [], translation: [] };
}

function samplePercentile(values: number[], ratio: number) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(ratio * sorted.length) - 1));
  return Math.round(sorted[index] ?? 0);
}

/** One session's own percentiles. The admin view labels this as per-session, not a pooled sample. */
export function latencySampleProps(samples: LatencySamples) {
  if (!samples.recognition.length && !samples.translation.length) return null;
  return {
    samples: Math.max(samples.recognition.length, samples.translation.length),
    recognitionP50: samplePercentile(samples.recognition, 0.5),
    recognitionP95: samplePercentile(samples.recognition, 0.95),
    translationP50: samplePercentile(samples.translation, 0.5),
    translationP95: samplePercentile(samples.translation, 0.95)
  };
}

export function pushLatencySample(samples: LatencySamples, readout: LatencyReadout) {
  if (readout.recognition != null && Number.isFinite(readout.recognition)) samples.recognition.push(readout.recognition);
  if (readout.translation != null && Number.isFinite(readout.translation)) samples.translation.push(readout.translation);
  if (samples.recognition.length > 240) samples.recognition.splice(0, samples.recognition.length - 240);
  if (samples.translation.length > 240) samples.translation.splice(0, samples.translation.length - 240);
}

type LatencyToken = { text?: string; end_ms?: number; is_final?: boolean; translation_status?: string };

function createTrack(): LatencyTrack {
  return { cursorMs: null, smooth: null, sampledAt: null };
}

export function createLatencyClock(): LatencyClock {
  return { marks: [], sentAudioMs: 0, measureFrom: null, finalSourceEndMs: null, recognition: createTrack(), translation: createTrack() };
}

export function chunkDurationMs(byteLength: number) {
  if (!Number.isFinite(byteLength) || byteLength <= 0) return 0;
  return byteLength / BYTES_PER_MS;
}

/** Capture time only. The audio clock moves in `commitSentChunk`, after the socket send. */
export function stampChunk(byteLength: number, capturedAt: number): StampedChunk {
  return { durationMs: chunkDurationMs(byteLength), capturedAt };
}

export function commitSentChunk(clock: LatencyClock, chunk: StampedChunk) {
  if (!(chunk.durationMs > 0) || !Number.isFinite(chunk.capturedAt)) return;
  clock.sentAudioMs += chunk.durationMs;
  clock.marks.push({ audioEndMs: clock.sentAudioMs, durationMs: chunk.durationMs, capturedAt: chunk.capturedAt });
  const keepAfter = clock.sentAudioMs - MARK_KEEP_MS;
  while (clock.marks.length > 1 && clock.marks[0].audioEndMs < keepAfter) clock.marks.shift();
}

/** A socket can close with sent audio still buffered. The server count is what Soniox actually heard. */
export function alignSentAudio(clock: LatencyClock, receivedAudioMs: number) {
  if (!Number.isFinite(receivedAudioMs) || receivedAudioMs < 0 || receivedAudioMs >= clock.sentAudioMs) return;
  while (clock.marks.length) {
    const last = clock.marks[clock.marks.length - 1];
    const start = last.audioEndMs - last.durationMs;
    if (start >= receivedAudioMs) { clock.marks.pop(); continue; }
    if (last.audioEndMs > receivedAudioMs) {
      const cut = last.audioEndMs - receivedAudioMs;
      last.capturedAt -= cut;
      last.durationMs -= cut;
      last.audioEndMs = receivedAudioMs;
    }
    break;
  }
  clock.sentAudioMs = receivedAudioMs;
}

export function startMeasuring(clock: LatencyClock, at: number) {
  clock.measureFrom = at;
}

/** Positions past the sent audio are clamped to its end. */
export function capturedAtPosition(clock: LatencyClock, positionMs: number) {
  const marks = clock.marks;
  if (!marks.length || !Number.isFinite(positionMs)) return null;
  const position = Math.min(positionMs, clock.sentAudioMs);
  let lo = 0;
  let hi = marks.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (marks[mid].audioEndMs >= position) {
      found = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  if (found < 0) return null;
  const mark = marks[found];
  if (position < mark.audioEndMs - mark.durationMs) return null;
  return mark.capturedAt - (mark.audioEndMs - position);
}

export function latencyAt(clock: LatencyClock, positionMs: number, now: number) {
  if (!Number.isFinite(now)) return null;
  const capturedAt = capturedAtPosition(clock, positionMs);
  if (capturedAt === null) return null;
  if (clock.measureFrom !== null && capturedAt < clock.measureFrom) return null;
  return Math.max(0, now - capturedAt);
}

/** Time-based EMA, so the smoothing window stays near one second however often results arrive. */
export function smoothLatency(previous: number | null, sample: number, elapsedMs: number) {
  if (previous === null || !Number.isFinite(previous) || !(elapsedMs > 0)) return previous ?? sample;
  const alpha = 1 - Math.exp(-elapsedMs / SMOOTH_TAU_MS);
  return previous + alpha * (sample - previous);
}

export function observeTrack(clock: LatencyClock, track: LatencyTrack, positionMs: number, now: number) {
  if (!Number.isFinite(positionMs)) return false;
  if (track.cursorMs !== null && positionMs <= track.cursorMs) return false;
  track.cursorMs = positionMs;
  const sample = latencyAt(clock, positionMs, now);
  if (sample === null) return false;
  track.smooth = track.smooth === null || track.sampledAt === null ? sample : smoothLatency(track.smooth, sample, now - track.sampledAt);
  track.sampledAt = now;
  return true;
}

function spokenEnd(token: LatencyToken) {
  if (token.translation_status === 'translation' || token.text === '<end>') return null;
  return typeof token.end_ms === 'number' && Number.isFinite(token.end_ms) ? token.end_ms : null;
}

/** Translated tokens carry no timestamps. They follow the spoken tokens they translate, in order. */
export function observeTranscript(clock: LatencyClock, event: { tokens?: LatencyToken[]; totalAudioProcMs?: number }, now: number) {
  let running = clock.finalSourceEndMs;
  let newestSpoken: number | null = null;
  let translated: number | null = null;
  for (const token of event.tokens ?? []) {
    if (!token) continue;
    if (token.translation_status === 'translation') {
      if (!token.text?.trim()) continue;
      const covered = token.is_final ? clock.finalSourceEndMs : running;
      if (covered !== null && (translated === null || covered > translated)) translated = covered;
      continue;
    }
    const end = spokenEnd(token);
    if (end === null) continue;
    if (newestSpoken === null || end > newestSpoken) newestSpoken = end;
    if (token.translation_status === 'none') continue;
    if (running === null || end > running) running = end;
    if (token.is_final && (clock.finalSourceEndMs === null || end > clock.finalSourceEndMs)) clock.finalSourceEndMs = end;
  }
  const processed = typeof event.totalAudioProcMs === 'number' && Number.isFinite(event.totalAudioProcMs) ? event.totalAudioProcMs : newestSpoken;
  if (processed !== null) observeTrack(clock, clock.recognition, processed, now);
  if (translated !== null) observeTrack(clock, clock.translation, translated, now);
}

function stalledFloor(clock: LatencyClock, track: LatencyTrack, pendingFromMs: number | null, now: number) {
  if (pendingFromMs === null) return null;
  if (track.sampledAt !== null && now - track.sampledAt <= STALL_AFTER_MS) return null;
  const floor = latencyAt(clock, pendingFromMs, now);
  return floor !== null && floor > STALL_AFTER_MS ? floor : null;
}

function firstMeasuredPosition(clock: LatencyClock) {
  const from = clock.measureFrom;
  const mark = from === null ? clock.marks[0] : clock.marks.find((item) => item.capturedAt >= from);
  return mark ? mark.audioEndMs : null;
}

function withFloor(base: number | null, floor: number | null) {
  if (floor === null) return base;
  return base === null ? floor : Math.max(base, floor);
}

/** `active` is false while capture is paused, so nothing is waiting on Soniox. */
export function readLatency(clock: LatencyClock, now: number, active: boolean): LatencyReadout {
  const recognition = clock.recognition;
  const translation = clock.translation;
  if (!active) return { recognition: recognition.smooth, translation: translation.smooth };
  const processedTo = recognition.cursorMs ?? firstMeasuredPosition(clock);
  const recognitionPending = processedTo !== null && clock.sentAudioMs - processedTo > PENDING_AUDIO_MS ? processedTo : null;
  const translationPending = clock.finalSourceEndMs !== null && clock.finalSourceEndMs > (translation.cursorMs ?? -1) ? clock.finalSourceEndMs : null;
  return {
    recognition: withFloor(recognition.smooth, stalledFloor(clock, recognition, recognitionPending, now)),
    translation: withFloor(translation.smooth, stalledFloor(clock, translation, translationPending, now))
  };
}

export function newestTokenEndMs(tokens: LatencyToken[]) {
  let best: number | null = null;
  for (const token of tokens) {
    const end = token ? spokenEnd(token) : null;
    if (end !== null && (best === null || end > best)) best = end;
  }
  return best;
}

export type LatencyBand = 'pending' | 'ok' | 'warn' | 'slow';

/** Translation waits for whole phrases, so its budget is wider than recognition's. */
export function latencyBand(ms: number | null, kind: 'recognition' | 'translation' = 'recognition'): LatencyBand {
  if (ms === null || !Number.isFinite(ms)) return 'pending';
  const [ok, warn] = kind === 'translation' ? [2500, 5000] : [800, 2000];
  if (ms < ok) return 'ok';
  if (ms < warn) return 'warn';
  return 'slow';
}

const BAND_RANK: Record<LatencyBand, number> = { pending: 0, ok: 1, warn: 2, slow: 3 };

export function readoutBand(readout: LatencyReadout): LatencyBand {
  const recognition = latencyBand(readout.recognition, 'recognition');
  const translation = latencyBand(readout.translation, 'translation');
  return BAND_RANK[translation] > BAND_RANK[recognition] ? translation : recognition;
}

export function sameReadout(left: LatencyReadout, right: LatencyReadout) {
  const round = (value: number | null) => value === null ? null : Math.round(value / 10);
  return round(left.recognition) === round(right.recognition) && round(left.translation) === round(right.translation);
}
