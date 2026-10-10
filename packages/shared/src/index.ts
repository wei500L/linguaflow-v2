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
  | { type: 'ready'; sessionId: string; allowedSeconds?: number; receivedAudioMs?: number }
  | { type: 'transcript'; tokens: TranscriptToken[]; totalAudioProcMs?: number }
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

type TurnBoundary = { at: number; endMs?: number; restStartMs?: number; translated: boolean };

export type CaptionFold = {
  committed: CaptionTurn[];
  open: CaptionTurn | null;
  sentence: TurnBoundary | null;
  clause: TurnBoundary | null;
};

export function createCaptionFold(): CaptionFold {
  return { committed: [], open: null, sentence: null, clause: null };
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

function commitOpenTurn(state: CaptionFold) {
  const current = state.open;
  state.open = null;
  state.sentence = null;
  state.clause = null;
  if (!current || !(current.source.trim() || current.translation.trim())) return;
  current.source = current.source.trim();
  current.translation = current.translation.trim();
  current.interim = false;
  state.committed.push(current);
}

export const SOFT_TURN_CHARS = 240;
export const CLAUSE_TURN_CHARS = 360;
export const HARD_TURN_CHARS = 720;
export const FORCE_TURN_CHARS = 1200;
export const DENSE_TURN_LIMITS = { soft: 80, clause: 120, hard: 240, force: 400 };
const DENSE_LANGUAGES = new Set(['zh', 'ja', 'yue']);
const clauseEnding = /[,;:，；：、。！？!?．.…]$/;

/* CJK packs roughly three times more speech into each character, so its turns close at shorter lengths. */
export function turnLimits(language?: string) {
  return DENSE_LANGUAGES.has(languageCode(language)) ? DENSE_TURN_LIMITS : { soft: SOFT_TURN_CHARS, clause: CLAUSE_TURN_CHARS, hard: HARD_TURN_CHARS, force: FORCE_TURN_CHARS };
}

/* Soniox translates in clause-sized chunks and streams each one after its source chunk, sometimes after the first words of the
   next source chunk, while translation tokens land on whichever turn is open. A long turn is therefore cut at the latest
   source sentence end, or for very long sentences the latest clause end, once a translated chunk end arrives after it;
   source words already past that point move to the next turn.
   Sentence counts are not compared because translations merge, split, and drop filler sentences. */
function splitAtBoundary(state: CaptionFold, boundary: TurnBoundary) {
  const open = state.open;
  if (!open) return;
  const rest: CaptionTurn = { source: open.source.slice(boundary.at), translation: '', language: open.language, speaker: open.speaker, startMs: boundary.restStartMs, endMs: open.endMs, interim: false };
  open.source = open.source.slice(0, boundary.at);
  if (boundary.endMs !== undefined) open.endMs = boundary.endMs;
  commitOpenTurn(state);
  if (rest.source.trim()) state.open = rest;
}

function breakBefore(state: CaptionFold, open: CaptionTurn, next: string): TurnBoundary | 'now' | null {
  const limits = turnLimits(open.language);
  const reaches = (boundary: TurnBoundary, length: number) => open.source.slice(0, boundary.at).trim().length >= length;
  const sentence = state.sentence?.translated ? state.sentence : null;
  const clause = state.clause?.translated ? state.clause : null;
  // Cutting before the furthest translated point would push already translated source into the next turn.
  if (clause && (!sentence || clause.at > sentence.at)) {
    if (reaches(clause, limits.clause)) return clause;
  } else if (sentence && reaches(sentence, limits.soft)) return sentence;
  const source = open.source.trim();
  if (source.length >= limits.hard && sentenceEnding.test(source)) return 'now';
  if (source.length >= limits.force && (limits === DENSE_TURN_LIMITS || /^\s/.test(next))) return 'now';
  return null;
}

function markSourceEnd(state: CaptionFold, open: CaptionTurn, startMs: number | undefined, inline: boolean) {
  for (const boundary of [state.sentence, state.clause]) if (boundary && boundary.restStartMs === undefined) boundary.restStartMs = startMs;
  const source = open.source.trim();
  const mark = (): TurnBoundary => ({ at: open.source.length, endMs: open.endMs, translated: inline });
  if (sentenceEnding.test(source)) state.sentence = mark();
  if (clauseEnding.test(source)) state.clause = mark();
}

function applyCaptionToken(state: CaptionFold, token: TranscriptToken) {
  const text = token.text ?? '';
  if (text === '<end>') { commitOpenTurn(state); return; }
  if (!text) return;
  const translated = token.translation_status === 'translation';
  if (!translated) {
    const previous = state.open;
    if (previous && (!sameTag(previous.speaker, token.speaker) || !sameLanguage(previous.language, token.language))) commitOpenTurn(state);
    else if (previous) {
      const action = breakBefore(state, previous, text);
      if (action === 'now') commitOpenTurn(state);
      else if (action) splitAtBoundary(state, action);
    }
    state.open ??= blankTurn();
    const open = state.open;
    if (!open.language && token.language) open.language = token.language;
    if (!open.speaker && token.speaker) open.speaker = token.speaker;
    if (open.startMs === undefined && typeof token.start_ms === 'number') open.startMs = token.start_ms;
    if (typeof token.end_ms === 'number') open.endMs = token.end_ms;
    open.source += text;
    const inline = !token.translation_status ? token.translation ?? token.translation_text ?? '' : '';
    open.translation += inline;
    markSourceEnd(state, open, typeof token.start_ms === 'number' ? token.start_ms : undefined, Boolean(inline));
    return;
  }
  state.open ??= blankTurn();
  const open = state.open;
  if (!open.language && token.source_language) open.language = token.source_language;
  open.translation += text;
  const translation = open.translation.trim();
  if (state.sentence && sentenceEnding.test(translation)) state.sentence.translated = true;
  if (state.clause && clauseEnding.test(translation)) state.clause.translated = true;
}

export function ingestCaptionTokens(state: CaptionFold, tokens: TranscriptToken[]) {
  for (const token of tokens) applyCaptionToken(state, token);
}

function presentOpenTurn(turn: CaptionTurn, interim: boolean): CaptionTurn {
  return { ...turn, source: turn.source.trim(), translation: turn.translation.trim(), interim };
}

export function projectCaptionTurns(state: CaptionFold, interimTokens: TranscriptToken[] = [], flush = false): CaptionTurn[] {
  const scratch = createCaptionFold();
  scratch.open = state.open ? { ...state.open } : null;
  scratch.sentence = state.sentence ? { ...state.sentence } : null;
  scratch.clause = state.clause ? { ...state.clause } : null;
  let sawInterim = false;
  for (const token of interimTokens) {
    applyCaptionToken(scratch, token);
    if ((token.text ?? '') && token.text !== '<end>') sawInterim = true;
  }
  const turns = state.committed.concat(scratch.committed);
  const current = scratch.open;
  if (current && (current.source.trim() || current.translation.trim())) turns.push(presentOpenTurn(current, sawInterim || !flush));
  return turns;
}

export function foldCaptionTurns(finalTokens: TranscriptToken[], interimTokens: TranscriptToken[] = [], flush = false): CaptionTurn[] {
  const state = createCaptionFold();
  ingestCaptionTokens(state, finalTokens);
  return projectCaptionTurns(state, interimTokens, flush);
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

export const REFERRAL = {
  inviteeSeconds: 2 * 60 * 60,
  inviterSeconds: 5 * 60 * 60,
  qualifySeconds: 3 * 60,
  qualifyDays: 14,
  pendingCap: 5,
  monthlyQualifiedCap: 10,
  monthlyWindowDays: 30,
  lifetimeQualifiedCap: 30,
  sameIpWindowDays: 7,
  velocityWindowHours: 24,
  velocityCap: 5,
  domainBurstAt: 3,
  registerIpPerHour: 8,
  registerWindowHours: 1,
  codeLength: 8,
  codeAlphabet: 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
} as const;

export function normalizeInviteCode(value: string) {
  const code = value.trim().toUpperCase();
  if (code.length !== REFERRAL.codeLength) return null;
  for (const char of code) if (!REFERRAL.codeAlphabet.includes(char)) return null;
  return code;
}

export const PCM_BYTES_PER_SECOND = 32000;

/* 16 kHz, 16-bit, mono. A frame that would exceed the reserved seconds is refused whole. */
export function acceptPcmFrame(forwardedBytes: number, frameBytes: number, allowedSeconds: number) {
  if (frameBytes <= 0) return true;
  const budget = Math.max(0, allowedSeconds) * PCM_BYTES_PER_SECOND;
  return frameBytes <= budget - Math.max(0, forwardedBytes);
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
