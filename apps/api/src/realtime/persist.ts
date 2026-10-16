import crypto from 'node:crypto';
import os from 'node:os';
import { and, asc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import {
  billableSecondsFromCheckpoint,
  checkpointFailureAction,
  defaultSummaryTemplate,
  foldCaptionTurns,
  mergeAudioGaps,
  mergePersistedSegments,
  sessionOutcome,
  type AudioGap,
  type PersistedSegment,
  type TranscriptToken
} from '@linguaflow/shared';
import { db } from '../db/index.js';
import { courses, realtimeSessions, sessionMarkers, sessionTokenChunks, transcriptSegments, transcripts } from '../db/schema.js';
import { ensureAudienceShare } from '../lib/audience.js';
import { recordEvent } from '../lib/events.js';
import { settleUsage } from '../lib/quota.js';
import { markLiveRecording, unmarkLiveRecording } from '../lib/recordings.js';
import { scheduleRecordingEncode } from './encode.js';
import { repairWavFile } from './wav-repair.js';

/** One process owns a live room. After SIGKILL the id changes and the heartbeat goes stale. */
export const instanceId = `${os.hostname()}:${process.pid}:${crypto.randomUUID()}`;
const CHECKPOINT_GAP_MS = 4_000;
const MAX_UNPERSISTED_TOKENS = 8_000;

export type FinishedAudio = {
  relPath: string | null;
  status: 'none' | 'encoding' | 'ready' | 'failed' | 'recording';
  format: 'mp3' | 'wav' | null;
  bytes: number | null;
  durationMs: number | null;
  error: string | null;
};

type CheckpointState = { count: number; since: number; savedThrough: string | null; seq: number };
const checkpointState = new Map<string, CheckpointState>();
const checkpointChain = new Map<string, Promise<unknown>>();
const checkpointQueued = new Map<string, number>();

export function applyCheckpointFailure(state: CheckpointState, now: number, unpersisted: number) {
  const since = state.since || now;
  const count = state.count + 1;
  return {
    count,
    since,
    stopCapture: checkpointFailureAction(count, now - since) === 'stop' || unpersisted > MAX_UNPERSISTED_TOKENS
  };
}

export type CheckpointResult = {
  ok: boolean;
  savedThrough: string | null;
  checkpointSeq: number;
  stopCapture: boolean;
  error?: string;
};

function asSegments(value: unknown): PersistedSegment[] {
  return Array.isArray(value) ? value as PersistedSegment[] : [];
}

function asGaps(value: unknown): AudioGap[] {
  return Array.isArray(value) ? value as AudioGap[] : [];
}

function namedSpeaker(speaker: string | null, names: Record<string, string>) {
  if (!speaker) return null;
  return names[speaker] ?? speaker;
}

async function templateFor(mode: string, courseId: string | null) {
  const sessionMode = mode === 'two_way' ? 'two_way' : 'one_way';
  if (!courseId) return defaultSummaryTemplate(sessionMode);
  const [course] = await db.select({ summaryTemplate: courses.summaryTemplate }).from(courses).where(eq(courses.id, courseId));
  return defaultSummaryTemplate(sessionMode, course?.summaryTemplate);
}

export async function attachRecording(sessionId: string, relPath: string) {
  await db.update(realtimeSessions).set({ recordingRelPath: relPath, ownerInstanceId: instanceId, ownerHeartbeatAt: new Date() }).where(and(eq(realtimeSessions.id, sessionId), isNull(realtimeSessions.endedAt)));
}

export async function noteOwner(sessionId: string, status?: string) {
  await db.update(realtimeSessions).set({
    ownerInstanceId: instanceId,
    ownerHeartbeatAt: new Date(),
    ...(status ? { status } : {})
  }).where(and(eq(realtimeSessions.id, sessionId), isNull(realtimeSessions.endedAt)));
}

export async function rememberGap(sessionId: string, gap: AudioGap) {
  return db.transaction(async (tx) => {
    const [session] = await tx.select().from(realtimeSessions).where(eq(realtimeSessions.id, sessionId)).for('update');
    if (!session || session.endReason === 'purged') return false;
    const [draft] = await tx.select({ gaps: transcripts.gaps, deletedAt: transcripts.deletedAt }).from(transcripts).where(eq(transcripts.sessionId, sessionId)).limit(1);
    if (draft?.deletedAt) return false;
    const next = mergeAudioGaps(mergeAudioGaps(asGaps(session.gaps), asGaps(draft?.gaps)), [gap]);
    if (next.length === asGaps(session.gaps).length && asGaps(session.gaps).some((item) => item.id === gap.id)) return true;
    await tx.update(realtimeSessions).set({ gaps: next }).where(eq(realtimeSessions.id, sessionId));
    await tx.update(transcripts).set({ gaps: next }).where(and(eq(transcripts.sessionId, sessionId), isNull(transcripts.deletedAt)));
    await recordEvent({ userId: session.userId, name: 'audio_gap', dedupeKey: `audio_gap:${sessionId}:${gap.id}`, props: { sessionId, gapSource: gap.source } });
    return true;
  });
}

export async function rememberMarker(input: { id: string; userId: string; sessionId: string; kind: 'important' | 'unclear' | 'assignment'; note?: string | null; wallMs?: number | null; audioMs?: number | null }) {
  const [session] = await db.select({ userId: realtimeSessions.userId }).from(realtimeSessions).where(eq(realtimeSessions.id, input.sessionId));
  if (!session || session.userId !== input.userId) return false;
  const [transcript] = await db.select({ id: transcripts.id }).from(transcripts).where(and(eq(transcripts.sessionId, input.sessionId), isNull(transcripts.deletedAt))).limit(1);
  await db.insert(sessionMarkers).values({
    id: input.id,
    userId: input.userId,
    sessionId: input.sessionId,
    transcriptId: transcript?.id ?? null,
    kind: input.kind,
    note: input.note?.slice(0, 500) ?? null,
    wallMs: input.wallMs ?? null,
    audioMs: input.audioMs ?? null
  }).onConflictDoUpdate({
    target: sessionMarkers.id,
    set: { note: input.note?.slice(0, 500) ?? null, kind: input.kind, wallMs: input.wallMs ?? null, audioMs: input.audioMs ?? null, updatedAt: new Date() }
  });
  return true;
}

export function persistCheckpoint(input: {
  sessionId: string;
  finalTokens: TranscriptToken[];
  speakerNames: Record<string, string>;
  title: string;
  audioMs: number;
  gaps: AudioGap[];
  startedAt: Date | null;
  force?: boolean;
  summaryTemplate?: string | null;
  titleExplicit?: boolean;
}): Promise<CheckpointResult> {
  const waiting = checkpointQueued.get(input.sessionId) ?? 0;
  if (waiting >= 2) {
    const state = checkpointState.get(input.sessionId) ?? { count: 0, since: 0, savedThrough: null, seq: 0 };
    const failure = applyCheckpointFailure(state, Date.now(), input.finalTokens.length);
    checkpointState.set(input.sessionId, { ...state, count: failure.count, since: failure.since });
    return Promise.resolve({ ok: false, savedThrough: state.savedThrough, checkpointSeq: state.seq, stopCapture: failure.stopCapture, error: 'checkpoint queue full' });
  }
  checkpointQueued.set(input.sessionId, waiting + 1);
  const previous = checkpointChain.get(input.sessionId) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => writeCheckpoint(input)).finally(() => {
    checkpointQueued.set(input.sessionId, Math.max(0, (checkpointQueued.get(input.sessionId) ?? 1) - 1));
  });
  checkpointChain.set(input.sessionId, run);
  return run;
}

async function writeCheckpoint(input: {
  sessionId: string;
  finalTokens: TranscriptToken[];
  speakerNames: Record<string, string>;
  title: string;
  audioMs: number;
  gaps: AudioGap[];
  startedAt: Date | null;
  force?: boolean;
  summaryTemplate?: string | null;
  titleExplicit?: boolean;
}): Promise<CheckpointResult> {
  const state = checkpointState.get(input.sessionId) ?? { count: 0, since: 0, savedThrough: null, seq: 0 };
  const now = Date.now();
  if (!input.force && state.savedThrough && now - Date.parse(state.savedThrough) < CHECKPOINT_GAP_MS) {
    return { ok: true, savedThrough: state.savedThrough, checkpointSeq: state.seq, stopCapture: false };
  }
  let persistedHint = 0;
  try {
    const [session] = await db.select().from(realtimeSessions).where(eq(realtimeSessions.id, input.sessionId));
    if (!session || session.endedAt || session.endReason === 'purged') {
      return { ok: true, savedThrough: session?.checkpointAt?.toISOString() ?? state.savedThrough, checkpointSeq: session?.checkpointSeq ?? state.seq, stopCapture: false };
    }
    persistedHint = session.persistedTokenCount;
    const folded = foldCaptionTurns(input.finalTokens, [], false).filter((turn) => !turn.interim);
    const activeUntil = new Date();
    const template = input.summaryTemplate ?? await templateFor(session.mode, session.courseId);
    let transcriptId: string | null = null;
    let nextSeq = session.checkpointSeq + 1;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('statement_timeout', '8000', true)`);
      const [locked] = await tx.select().from(realtimeSessions).where(eq(realtimeSessions.id, input.sessionId)).for('update');
      if (!locked || locked.endedAt || locked.endReason === 'purged') return;
      const [draft] = await tx.select({ deletedAt: transcripts.deletedAt }).from(transcripts).where(eq(transcripts.sessionId, input.sessionId)).limit(1);
      if (draft?.deletedAt) return;
      const persisted = locked.persistedTokenCount;
      const fresh = input.finalTokens.slice(Math.max(0, persisted));
      const merged = mergePersistedSegments(asSegments(locked.segmentSnapshot), folded, () => crypto.randomUUID());
      if (fresh.length) {
        await tx.insert(sessionTokenChunks).values({ sessionId: input.sessionId, seq: persisted, tokens: fresh }).onConflictDoNothing();
      }
      const mergedGaps = mergeAudioGaps(asGaps(locked.gaps), input.gaps);
      if (merged.length) transcriptId = await upsertDraft(tx, locked, merged, { ...input, gaps: mergedGaps }, activeUntil, 'active', template);
      nextSeq = locked.checkpointSeq + 1;
      await tx.update(realtimeSessions).set({
        persistedTokenCount: persisted + fresh.length,
        checkpointSeq: nextSeq,
        checkpointAt: activeUntil,
        activeUntil,
        ownerInstanceId: instanceId,
        ownerHeartbeatAt: activeUntil,
        audioMs: input.audioMs,
        segmentSnapshot: merged,
        speakerNames: input.speakerNames,
        gaps: mergedGaps,
        ...(input.titleExplicit && input.title.trim() ? { title: input.title.trim() } : {}),
        saveStatus: 'saved',
        saveError: null,
        startedAt: locked.startedAt ?? input.startedAt
      }).where(and(eq(realtimeSessions.id, input.sessionId), isNull(realtimeSessions.endedAt)));
    });
    const savedThrough = activeUntil.toISOString();
    checkpointState.set(input.sessionId, { count: 0, since: 0, savedThrough, seq: nextSeq });
    if (transcriptId) await recordEvent({ userId: session.userId, name: 'record_persisted', dedupeKey: `record_persisted:${input.sessionId}`, props: { sessionId: input.sessionId, recordStatus: 'active' } });
    if (input.finalTokens.some((token) => token.text && token.text !== '<end>')) {
      await recordEvent({ userId: session.userId, name: 'session_first_caption', dedupeKey: `session_first_caption:${input.sessionId}`, props: { sessionId: input.sessionId } });
    }
    return { ok: true, savedThrough, checkpointSeq: nextSeq, stopCapture: false };
  } catch (error) {
    const failure = applyCheckpointFailure(state, now, Math.max(0, input.finalTokens.length - persistedHint));
    checkpointState.set(input.sessionId, { count: failure.count, since: failure.since, savedThrough: state.savedThrough, seq: state.seq });
    const message = error instanceof Error ? error.message : 'checkpoint failed';
    await db.update(realtimeSessions).set({ saveStatus: 'failed', saveError: message.slice(0, 300) }).where(and(eq(realtimeSessions.id, input.sessionId), isNull(realtimeSessions.endedAt))).catch(() => undefined);
    return { ok: false, savedThrough: state.savedThrough, checkpointSeq: state.seq, stopCapture: failure.stopCapture, error: message };
  }
}

type SessionRow = typeof realtimeSessions.$inferSelect;
type TokenExecutor = Pick<typeof db, 'insert' | 'select' | 'update' | 'delete'>;

async function upsertDraft(tx: TokenExecutor, session: SessionRow, merged: PersistedSegment[], input: { title: string; gaps: AudioGap[]; audioMs: number; speakerNames: Record<string, string>; titleExplicit?: boolean }, activeUntil: Date, recordStatus: 'active' | 'incomplete' | 'complete', summaryTemplate: string | null, audio?: FinishedAudio) {
  const [existing] = await tx.select().from(transcripts).where(eq(transcripts.sessionId, session.id)).limit(1);
  if (existing?.deletedAt) return existing.id;
  const startedAt = session.startedAt;
  const wallMs = startedAt ? Math.max(0, activeUntil.getTime() - startedAt.getTime()) : 0;
  const incoming = input.title.trim();
  const title = existing?.title && incoming && incoming !== existing.title && !input.titleExplicit
    ? existing.title
    : incoming || session.title?.trim() || existing?.title || `翻译会话 · ${activeUntil.toLocaleString('zh-CN')}`;
  const gaps = mergeAudioGaps(mergeAudioGaps(asGaps(session.gaps), asGaps(existing?.gaps)), input.gaps);
  let transcriptId = existing?.id ?? null;
  if (!existing) {
    const template = summaryTemplate ?? defaultSummaryTemplate(session.mode === 'two_way' ? 'two_way' : 'one_way');
    const [created] = await tx.insert(transcripts).values({
      userId: session.userId,
      sessionId: session.id,
      title,
      mode: session.mode,
      languageA: session.languageA,
      languageB: session.languageB ?? session.targetLanguage ?? 'en',
      durationMs: wallMs,
      summaryTemplate: template,
      recordStatus,
      startedAt,
      endedAt: recordStatus === 'active' ? null : activeUntil,
      courseId: session.courseId,
      gaps,
      audioRelPath: audio?.relPath ?? session.recordingRelPath,
      audioStatus: audio?.status ?? (session.recordingRelPath ? 'recording' : 'none'),
      audioFormat: audio?.format ?? (session.recordingRelPath ? 'wav' : null),
      audioBytes: audio?.bytes ?? null,
      audioDurationMs: audio?.durationMs ?? input.audioMs,
      audioError: audio?.error ?? null,
      folderId: null
    }).onConflictDoNothing({ target: transcripts.sessionId }).returning();
    if (!created) {
      const [race] = await tx.select().from(transcripts).where(eq(transcripts.sessionId, session.id)).limit(1);
      if (!race || race.deletedAt) return race?.id ?? null;
      transcriptId = race.id;
    } else transcriptId = created.id;
  } else if (transcriptId) {
    await tx.update(transcripts).set({
      title,
      durationMs: wallMs,
      gaps,
      recordStatus: existing.recordStatus === 'complete' ? existing.recordStatus : recordStatus,
      endedAt: recordStatus === 'active' ? existing.endedAt : activeUntil,
      startedAt: existing.startedAt ?? startedAt,
      ...(audio?.relPath ? { audioRelPath: audio.relPath, audioStatus: audio.status, audioFormat: audio.format, audioBytes: audio.bytes, audioDurationMs: audio.durationMs, audioError: audio.error } : {})
    }).where(and(eq(transcripts.id, transcriptId), isNull(transcripts.deletedAt)));
  }
  if (!transcriptId || !merged.length) return transcriptId;
  await tx.delete(transcriptSegments).where(eq(transcriptSegments.transcriptId, transcriptId));
  await tx.insert(transcriptSegments).values(merged.map((segment, index) => ({
    id: segment.id,
    transcriptId,
    idx: index,
    sourceText: segment.source,
    translationText: segment.translation,
    language: segment.language,
    startMs: segment.startMs,
    endMs: segment.endMs,
    speaker: namedSpeaker(segment.speaker, input.speakerNames),
    sourceHash: segment.sourceHash
  })));
  await tx.update(sessionMarkers).set({ transcriptId }).where(and(eq(sessionMarkers.sessionId, session.id), isNull(sessionMarkers.transcriptId)));
  return transcriptId;
}

export async function finalizePersistedSession(sessionId: string, reason: string, options: { interrupted?: boolean; audio?: FinishedAudio; title?: string; titleExplicit?: boolean; gaps?: AudioGap[]; speakerNames?: Record<string, string> } = {}) {
  let audio = options.audio;
  let interrupted = options.interrupted ?? false;
  let template: string | null = null;
  const [preview] = await db.select({ recordingRelPath: realtimeSessions.recordingRelPath, endedAt: realtimeSessions.endedAt, mode: realtimeSessions.mode, courseId: realtimeSessions.courseId }).from(realtimeSessions).where(eq(realtimeSessions.id, sessionId));
  if (preview) template = await templateFor(preview.mode, preview.courseId);
  if (!audio && preview && !preview.endedAt && preview.recordingRelPath) {
    markLiveRecording(preview.recordingRelPath);
    try {
      const repaired = await repairWavFile(preview.recordingRelPath);
      if (repaired && repaired.pcmBytes >= 2) {
        audio = { relPath: preview.recordingRelPath, status: 'encoding', format: 'wav', bytes: repaired.bytes, durationMs: repaired.durationMs, error: null };
        interrupted = options.interrupted ?? true;
      }
    } finally {
      unmarkLiveRecording(preview.recordingRelPath);
    }
  }
  const prepared = await db.transaction(async (tx) => {
    const [session] = await tx.select().from(realtimeSessions).where(eq(realtimeSessions.id, sessionId)).for('update');
    if (!session) return { missing: true as const };
    const [existing] = await tx.select().from(transcripts).where(eq(transcripts.sessionId, sessionId)).limit(1);
    if (session.endedAt || session.endReason === 'purged') {
      return { duplicate: true as const, userId: session.userId, transcriptId: existing?.deletedAt ? null : existing?.id ?? null, recordStatus: existing?.recordStatus ?? null, saveStatus: session.saveStatus };
    }
    const chunks = await tx.select().from(sessionTokenChunks).where(eq(sessionTokenChunks.sessionId, sessionId)).orderBy(asc(sessionTokenChunks.seq));
    const tokens = chunks.flatMap((chunk) => (Array.isArray(chunk.tokens) ? chunk.tokens as TranscriptToken[] : []));
    const folded = foldCaptionTurns(tokens, [], true);
    const names = options.speakerNames ?? (session.speakerNames && typeof session.speakerNames === 'object' ? session.speakerNames : {});
    const merged = mergePersistedSegments(asSegments(session.segmentSnapshot), folded, () => crypto.randomUUID());
    const activeUntil = session.activeUntil ?? session.checkpointAt ?? session.startedAt ?? new Date();
    const seconds = billableSecondsFromCheckpoint({
      startedAtMs: session.startedAt?.getTime() ?? null,
      activeUntilMs: session.activeUntil?.getTime() ?? session.checkpointAt?.getTime() ?? null,
      audioMs: Math.max(session.audioMs, audio?.durationMs ?? 0),
      maxSessionSeconds: session.maxSessionSeconds,
      reservedSeconds: session.reservedSeconds
    });
    const failed = session.saveStatus === 'failed';
    const recordStatus = interrupted || failed ? 'incomplete' : 'complete';
    const mergedGaps = mergeAudioGaps(asGaps(session.gaps), options.gaps ?? []);
    const hasBody = merged.length > 0 || Boolean(audio?.relPath || session.recordingRelPath);
    let transcriptId: string | null = existing?.deletedAt ? existing.id : null;
    if (hasBody && !existing?.deletedAt) {
      transcriptId = await upsertDraft(tx, { ...session, activeUntil, gaps: mergedGaps }, merged, {
        title: options.title ?? session.title ?? '',
        titleExplicit: options.titleExplicit,
        gaps: mergedGaps,
        audioMs: session.audioMs,
        speakerNames: names
      }, activeUntil, recordStatus, template, audio);
    }
    if (existing?.deletedAt) {
      return { missing: false as const, duplicate: false as const, userId: session.userId, transcriptId: null, seconds, reason, recordStatus: 'incomplete' as const, failed: true, keepAfter: false, hasBody: false };
    }
    await tx.update(realtimeSessions).set({ segmentSnapshot: merged, gaps: mergedGaps, title: options.titleExplicit ? (options.title ?? session.title) : session.title }).where(eq(realtimeSessions.id, sessionId));
    return { missing: false as const, duplicate: false as const, userId: session.userId, transcriptId, seconds, reason, recordStatus, failed, keepAfter: session.audienceKeepAfter && session.shareIntent === 'audience', hasBody };
  });
  if (prepared.missing) return { transcriptId: null, outcome: 'failed' as const, duplicate: false };
  if (prepared.duplicate) {
    return { transcriptId: prepared.transcriptId, outcome: sessionOutcome({ recordStatus: prepared.recordStatus as 'active' | 'incomplete' | 'complete' | null, saveState: prepared.saveStatus === 'failed' ? 'failed' : 'saved', transcriptId: prepared.transcriptId }), duplicate: true };
  }
  await settleUsage(prepared.userId, sessionId, prepared.seconds, interrupted ? 'interrupted' : reason);
  if (prepared.transcriptId && prepared.recordStatus === 'complete' && prepared.keepAfter && !prepared.failed) {
    const [fresh] = await db.select().from(realtimeSessions).where(eq(realtimeSessions.id, sessionId));
    if (fresh) await ensureAudienceShare(fresh, prepared.transcriptId).catch(() => null);
  }
  const outcome = sessionOutcome({
    recordStatus: prepared.hasBody ? prepared.recordStatus as 'active' | 'incomplete' | 'complete' : null,
    saveState: prepared.failed ? 'failed' : 'saved',
    transcriptId: prepared.hasBody ? prepared.transcriptId : null
  });
  const event = interrupted ? 'record_recovered' : outcome === 'failed' ? 'record_failed' : 'record_finished';
  await recordEvent({ userId: prepared.userId, name: event, dedupeKey: `${event}:${sessionId}`, props: { sessionId, reason, recordStatus: prepared.recordStatus, status: outcome } });
  if (prepared.transcriptId && audio?.status === 'encoding') scheduleRecordingEncode(prepared.transcriptId);
  checkpointState.delete(sessionId);
  return { transcriptId: prepared.hasBody ? prepared.transcriptId : null, outcome, duplicate: false, recordStatus: prepared.recordStatus };
}

export async function recoverStaleSessions(hasLiveRoom: (id: string) => boolean) {
  const cutoff = new Date(Date.now() - 45_000);
  const rows = await db.select().from(realtimeSessions).where(and(
    isNull(realtimeSessions.endedAt),
    inArray(realtimeSessions.status, ['connecting', 'active', 'reconnecting', 'stopping', 'saving']),
    or(isNull(realtimeSessions.ownerHeartbeatAt), lt(realtimeSessions.ownerHeartbeatAt, cutoff))
  ));
  for (const session of rows) {
    if (hasLiveRoom(session.id)) continue;
    let audio: FinishedAudio | undefined;
    if (session.recordingRelPath) {
      markLiveRecording(session.recordingRelPath);
      try {
        const repaired = await repairWavFile(session.recordingRelPath);
        if (repaired && repaired.pcmBytes >= 2) {
          audio = { relPath: session.recordingRelPath, status: 'encoding', format: 'wav', bytes: repaired.bytes, durationMs: repaired.durationMs, error: null };
        }
      } finally {
        unmarkLiveRecording(session.recordingRelPath);
      }
    }
    await finalizePersistedSession(session.id, 'interrupted', { interrupted: true, audio });
  }
}

/** Sessions still writing a recoverable WAV must survive the orphan sweep. */
export async function protectedRecordingPaths() {
  const rows = await db.select({ recordingRelPath: realtimeSessions.recordingRelPath }).from(realtimeSessions).where(and(isNull(realtimeSessions.endedAt)));
  return rows.flatMap((row) => row.recordingRelPath ? [row.recordingRelPath] : []);
}
