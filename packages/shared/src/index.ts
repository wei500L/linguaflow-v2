export type Plan = 'free' | 'plus' | 'pro' | 'ultra';
export type SessionMode = 'one_way' | 'two_way';

export type Entitlement = {
  plan: Plan;
  planExpiresAt: string | null;
  remainingSeconds: number;
  addonSeconds: number;
  usedSecondsThisPeriod: number;
  periodStart: string;
  periodEnd: string;
  status: 'active' | 'none' | 'expired';
};

export type LanguageOption = {
  code: string;
  nativeName: string;
  englishName: string;
};

export type TranscriptToken = {
  text: string;
  translation?: string;
  translation_text?: string;
  is_final?: boolean;
  translation_status?: 'original' | 'translation' | 'none' | string;
  language?: string;
  source_language?: string;
  speaker?: string;
  start_ms?: number;
  end_ms?: number;
  confidence?: number;
};

export type RealtimeEvent =
  | { type: 'ready'; sessionId: string; allowedSeconds?: number }
  | { type: 'transcript'; tokens: TranscriptToken[] }
  | { type: 'snapshot'; tokens: TranscriptToken[]; speakerNames?: Record<string, string> }
  | { type: 'error'; code: string; message?: string }
  | { type: 'finished'; reason?: string; transcriptId?: string | null };

const sentenceBoundary = /(?<=[。！？!?．.…])\s*/;
const sentenceEnding = /[。！？!?．.…]$/;

export function splitClosedSentences(text: string) {
  const parts = text.split(sentenceBoundary).map((part) => part.trim()).filter(Boolean);
  if (!parts.length) return { done: [] as string[], rest: '' };
  const last = parts[parts.length - 1];
  if (sentenceEnding.test(last)) return { done: parts, rest: '' };
  return { done: parts.slice(0, -1), rest: last };
}

export function pairTranscriptLines(sourceText: string, translationText: string) {
  const source = splitClosedSentences(sourceText);
  const translation = splitClosedSentences(translationText);
  const sourceLines = [...source.done, ...(source.rest ? [source.rest] : [])];
  const translationLines = [...translation.done, ...(translation.rest ? [translation.rest] : [])];
  const count = Math.max(sourceLines.length, translationLines.length);
  return Array.from({ length: count }, (_, index) => ({ source: sourceLines[index] ?? '', translation: translationLines[index] ?? '' })).filter((line) => line.source || line.translation);
}

export type TimedPiece = { text: string; startMs?: number; endMs?: number; speaker?: string };
export type TimedLine = { source: string; translation: string; startMs?: number; endMs?: number; speaker?: string };

function closedLines(text: string) {
  const split = splitClosedSentences(text);
  return [...split.done, ...(split.rest ? [split.rest] : [])];
}

function sentenceSpans(pieces: TimedPiece[]) {
  const text = pieces.map((piece) => piece.text).join('');
  let cursor = 0;
  return closedLines(text).map((line) => {
    const from = text.indexOf(line, cursor);
    const start = from === -1 ? cursor : from;
    const end = start + line.length;
    cursor = end;
    let startMs: number | undefined;
    let endMs: number | undefined;
    let speaker: string | undefined;
    let offset = 0;
    for (const piece of pieces) {
      const next = offset + piece.text.length;
      if (next > start && offset < end) {
        if (startMs === undefined && piece.startMs !== undefined) startMs = piece.startMs;
        if (piece.endMs !== undefined) endMs = piece.endMs;
        if (!speaker && piece.speaker) speaker = piece.speaker;
      }
      offset = next;
    }
    return { text: line, startMs, endMs, speaker };
  });
}

export type CaptionTurn = {
  source: string;
  translation: string;
  language?: string;
  speaker?: string;
  startMs?: number;
  endMs?: number;
  interim: boolean;
};

function blankTurn(): CaptionTurn {
  return { source: '', translation: '', interim: false };
}

function languageCode(value?: string) {
  return value?.toLowerCase().split('-')[0] ?? '';
}

function sameTag(current: string | undefined, next: string | undefined) {
  if (!current || !next) return true;
  return current === next;
}

function sameLanguage(current: string | undefined, next: string | undefined) {
  if (!current || !next) return true;
  return languageCode(current) === languageCode(next);
}

export function foldCaptionTurns(finalTokens: TranscriptToken[], interimTokens: TranscriptToken[] = [], flush = false): CaptionTurn[] {
  const turns: CaptionTurn[] = [];
  const state: { open: CaptionTurn | null } = { open: null };

  const commit = () => {
    const current = state.open;
    state.open = null;
    if (!current || !(current.source.trim() || current.translation.trim())) return;
    current.source = current.source.trim();
    current.translation = current.translation.trim();
    current.interim = false;
    turns.push(current);
  };

  const apply = (token: TranscriptToken) => {
    const text = token.text ?? '';
    if (text === '<end>') { commit(); return; }
    if (!text) return;
    const translated = token.translation_status === 'translation';
    if (!translated) {
      const previous = state.open;
      if (previous && (!sameTag(previous.speaker, token.speaker) || !sameLanguage(previous.language, token.language))) commit();
      state.open ??= blankTurn();
      const open = state.open;
      if (!open.language && token.language) open.language = token.language;
      if (!open.speaker && token.speaker) open.speaker = token.speaker;
      if (open.startMs === undefined && typeof token.start_ms === 'number') open.startMs = token.start_ms;
      if (typeof token.end_ms === 'number') open.endMs = token.end_ms;
      open.source += text;
      if (!token.translation_status && (token.translation || token.translation_text)) open.translation += token.translation ?? token.translation_text ?? '';
      return;
    }
    state.open ??= blankTurn();
    const open = state.open;
    if (!open.language && token.source_language) open.language = token.source_language;
    open.translation += text;
  };

  for (const token of finalTokens) apply(token);
  let sawInterim = false;
  for (const token of interimTokens) {
    apply(token);
    if ((token.text ?? '') && token.text !== '<end>') sawInterim = true;
  }
  const current = state.open;
  if (current && (current.source.trim() || current.translation.trim())) {
    current.source = current.source.trim();
    current.translation = current.translation.trim();
    current.interim = sawInterim || !flush;
    turns.push(current);
  }
  return turns;
}

export function pairTimedLines(sourcePieces: TimedPiece[], translationPieces: TimedPiece[]): TimedLine[] {
  const source = sentenceSpans(sourcePieces);
  const translation = sentenceSpans(translationPieces);
  const count = Math.max(source.length, translation.length);
  const lines: TimedLine[] = [];
  for (let index = 0; index < count; index += 1) {
    const sourceLine = source[index];
    const translationLine = translation[index];
    if (!sourceLine?.text && !translationLine?.text) continue;
    lines.push({
      source: sourceLine?.text ?? '',
      translation: translationLine?.text ?? '',
      startMs: sourceLine?.startMs ?? translationLine?.startMs,
      endMs: sourceLine?.endMs ?? translationLine?.endMs,
      speaker: sourceLine?.speaker
    });
  }
  return lines;
}

export const PLANS: Record<Plan, { label: string; monthlySeconds: number | null; maxSessionSeconds: number }> = {
  free: { label: 'Free', monthlySeconds: 30 * 60, maxSessionSeconds: 15 * 60 },
  plus: { label: 'Plus', monthlySeconds: 600 * 60, maxSessionSeconds: 2 * 60 * 60 },
  pro: { label: 'Pro', monthlySeconds: 1500 * 60, maxSessionSeconds: 5 * 60 * 60 },
  ultra: { label: 'Ultra', monthlySeconds: null, maxSessionSeconds: 12 * 60 * 60 }
};

export function summaryChargeSeconds(charCount: number, unlimited: boolean) {
  if (unlimited || charCount <= 0) return 0;
  return Math.max(60, Math.ceil(charCount / 2000) * 60);
}

export function splitQuotaCharge(requested: number, planRemaining: number, addonSeconds: number) {
  const planSeconds = Math.min(requested, Math.max(0, planRemaining));
  const addon = Math.min(Math.max(0, requested - planSeconds), Math.max(0, addonSeconds));
  return { planSeconds, addonSeconds: addon, covered: planSeconds + addon >= requested };
}

export const LANGUAGE_OPTIONS: LanguageOption[] = [
  ['zh', '中文', 'Chinese'], ['en', 'English', 'English'], ['ja', '日本語', 'Japanese'],
  ['ko', '한국어', 'Korean'], ['ru', 'Русский', 'Russian'], ['fr', 'Français', 'French'],
  ['de', 'Deutsch', 'German'], ['es', 'Español', 'Spanish'], ['it', 'Italiano', 'Italian'],
  ['pt', 'Português', 'Portuguese'], ['ar', 'العربية', 'Arabic'], ['hi', 'हिन्दी', 'Hindi'],
  ['nl', 'Nederlands', 'Dutch'], ['tr', 'Türkçe', 'Turkish'], ['pl', 'Polski', 'Polish']
].map(([code, nativeName, englishName]) => ({ code, nativeName, englishName }));

const taskHeading = /待办|作业|action items?|to-?dos?|tasks?|homework/i;

export function extractActionItems(markdown: string) {
  const items: string[] = [];
  let capture = false;
  for (const raw of markdown.split('\n')) {
    const line = raw.trim();
    const heading = /^(#{1,3})\s+(.*)$/.exec(line);
    if (heading) {
      capture = taskHeading.test(heading[2] ?? '');
      continue;
    }
    if (!capture) continue;
    const item = /^[-*]\s+(?:\[[ xX]\]\s+)?(.*)$/.exec(line);
    const text = item?.[1]?.trim().replace(/\*\*/g, '');
    if (text) items.push(text);
  }
  return items;
}
