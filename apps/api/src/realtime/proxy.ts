import crypto from 'node:crypto';
import WebSocket from 'ws';
import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { glossaries, glossaryTerms, realtimeSessions, transcriptSegments, transcripts } from '../db/schema.js';
import { config } from '../config.js';
import { foldCaptionTurns, type TranscriptToken } from '@linguaflow/shared';
import { settleUsage } from '../lib/quota.js';
import { removeRecording } from '../lib/recordings.js';
import { scheduleRecordingEncode } from './encode.js';
import { SessionRecorder, type RecordingArtifact } from './recorder.js';
import { buildSonioxConfig, type GlossaryMeta, type GlossaryTermInput } from './soniox.js';
import { ensureAudienceShare } from '../lib/audience.js';

const hash = (value: string) => crypto.createHash('sha256').update(value).digest('hex');
const RECONNECT_GRACE_MS = 20_000;
/** Soniox closes the stream after 20s with no audio and no keepalive, and drops speaker and language context with it. */
const UPSTREAM_KEEPALIVE_MS = 5_000;
/** Phones freeze the browser keepalive timer before they stop the mic worklet. Audio has to refresh liveness too, or the 30-minute sweep ends a live session. */
const CLAIM_TOUCH_MS = 30_000;

function disableNagle(socket: WebSocket) {
  const raw = (socket as WebSocket & { _socket?: { setNoDelay?: (on: boolean) => void } })._socket;
  raw?.setNoDelay?.(true);
}

type LiveRoom = {
  client: WebSocket | null;
  audience: Set<WebSocket>;
  finalTokens: TranscriptToken[];
  speakerNames: Record<string, string>;
  title: string;
  mode: string;
  languageA: string;
  languageB: string;
  startedAt?: Date;
  /** PCM bytes forwarded to Soniox. A reconnecting host realigns its latency clock with this. */
  forwardedAudioBytes: number;
  allowed: number;
  ended: boolean;
  stopRequested: boolean;
  reconnectTimer?: NodeJS.Timeout;
  requestDrain: (reason: string) => Promise<void>;
  bindClient: (socket: WebSocket) => void;
};

const activeSessions = new Map<string, (reason: string) => Promise<void>>();
const rooms = new Map<string, LiveRoom>();

export function hasLiveRoom(id: string) {
  return rooms.has(id);
}

function sendJson(socket: WebSocket, payload: unknown) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload));
}

function publishAudience(room: LiveRoom, payload: unknown) {
  for (const socket of room.audience) sendJson(socket, payload);
}

export function joinAudience(sessionId: string, socket: WebSocket) {
  const room = rooms.get(sessionId);
  if (!room || room.ended || room.stopRequested) return false;
  room.audience.add(socket);
  sendJson(socket, {
    type: 'snapshot',
    tokens: room.finalTokens,
    speakerNames: room.speakerNames,
    title: room.title,
    mode: room.mode,
    languageA: room.languageA,
    languageB: room.languageB
  });
  socket.on('close', () => { room.audience.delete(socket); });
  return true;
}

export function audienceCount(sessionId: string) {
  const room = rooms.get(sessionId);
  if (!room) return 0;
  let count = 0;
  for (const socket of room.audience) if (socket.readyState === WebSocket.OPEN) count += 1;
  return count;
}

export function dropAudience(sessionId: string) {
  const room = rooms.get(sessionId);
  if (!room) return;
  for (const socket of room.audience) {
    if (socket.readyState === WebSocket.OPEN) socket.close(1008, 'Audience revoked');
  }
  room.audience.clear();
}

export function holdSession(sessionId: string) {
  const room = rooms.get(sessionId);
  if (!room || room.ended || room.stopRequested) return false;
  if (room.client && (room.client.readyState === WebSocket.OPEN || room.client.readyState === WebSocket.CONNECTING)) return false;
  if (room.reconnectTimer) clearTimeout(room.reconnectTimer);
  room.reconnectTimer = setTimeout(() => { void room.requestDrain('client_closed'); }, RECONNECT_GRACE_MS);
  room.reconnectTimer.unref();
  return true;
}

export async function closeActiveSessions(reason = 'server_shutdown') {
  await Promise.allSettled([...activeSessions.values()].map((finish) => finish(reason)));
}
export async function closeActiveSession(id: string, reason = 'admin_terminated') {
  const finish = activeSessions.get(id);
  if (finish) await finish(reason);
  return Boolean(finish);
}

function cleanSpeakerNames(value: unknown) {
  if (!value || typeof value !== 'object') return null;
  const names: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value as Record<string, unknown>)) {
    if (typeof raw !== 'string' || !raw.trim()) continue;
    names[key.slice(0, 80)] = raw.trim().slice(0, 80);
  }
  return names;
}

export async function handleRealtimeSocket(client: WebSocket, token: string) {
  disableNagle(client);
  const [claimed] = await db.update(realtimeSessions).set({ claimedAt: new Date(), status: 'connecting' }).where(and(eq(realtimeSessions.sessionTokenHash, hash(token)), eq(realtimeSessions.status, 'pending'), isNull(realtimeSessions.claimedAt), isNull(realtimeSessions.endedAt))).returning();
  const session = claimed;
  if (!session) {
    await handleReconnectSocket(client, token);
    return;
  }

  const loadedGlossary = await loadSessionTerms(session.userId, session.glossaryId);
  const upstream = new WebSocket(config.sonioxWsUrl, { perMessageDeflate: false });
  let startedAt: Date | undefined;
  let ended = false;
  let limitTimer: NodeJS.Timeout | undefined;
  let quotaTimer: NodeJS.Timeout | undefined;
  const finalTokens: TranscriptToken[] = [];
  const room: LiveRoom = {
    client: null,
    audience: new Set(),
    finalTokens,
    speakerNames: {},
    title: session.title?.trim() ?? '',
    mode: session.mode,
    languageA: session.languageA,
    languageB: session.languageB ?? session.targetLanguage ?? '',
    forwardedAudioBytes: 0,
    allowed: Math.min(session.maxSessionSeconds, session.reservedSeconds),
    ended: false,
    stopRequested: false,
    requestDrain: async () => undefined,
    bindClient: () => undefined
  };
  const hostSocket = () => room.client ?? client;
  rooms.set(session.id, room);
  let recorder: SessionRecorder | null = null;
  let recordingSetupError: string | null = null;
  if (session.recordAudio) {
    try {
      recorder = new SessionRecorder(session.userId, session.id);
      await recorder.open();
    } catch {
      recorder = null;
      recordingSetupError = '无法创建录音文件。';
    }
  }
  let finishing: Promise<void> | null = null;
  let stopRequested = false;
  let drainReason: string | null = null;
  let drainTimer: NodeJS.Timeout | undefined;
  let upstreamKeepalive: NodeJS.Timeout | undefined;
  let resolveDrain: (() => void) | undefined;
  let drainPromise: Promise<void> | null = null;
  const finish = (reason: string) => {
    if (!finishing) finishing = runFinish(reason).finally(() => { activeSessions.delete(session.id); rooms.delete(session.id); resolveDrain?.(); });
    return finishing;
  };
  const requestDrain = (reason: string) => {
    if (finishing) return finishing;
    if (!drainPromise) drainPromise = new Promise((resolve) => { resolveDrain = resolve; });
    if (!drainReason) drainReason = reason;
    stopRequested = true;
    room.stopRequested = true;
    if (upstream.readyState !== upstream.OPEN) return finish(drainReason);
    if (!drainTimer) {
      // An empty binary frame is silence. Soniox ends the stream on an empty text frame, then sends the final tokens.
      upstream.send('');
      drainTimer = setTimeout(() => { void finish(drainReason ?? reason).catch(() => undefined); }, 8_000);
      drainTimer.unref();
    }
    return drainPromise;
  };
  const runFinish = async (reason: string) => {
    if (ended) return;
    ended = true;
    if (limitTimer) clearTimeout(limitTimer);
    if (quotaTimer) clearInterval(quotaTimer);
    if (drainTimer) clearTimeout(drainTimer);
    if (upstreamKeepalive) clearInterval(upstreamKeepalive);
    if (room.reconnectTimer) clearTimeout(room.reconnectTimer);
    room.ended = true;
    const endedAt = new Date();
    const seconds = startedAt ? Math.max(0, Math.ceil((endedAt.getTime() - startedAt.getTime()) / 1000)) : 0;
    const lines = foldCaptionTurns(finalTokens, [], true);
    let audio: RecordingArtifact = { relPath: null, status: recordingSetupError ? 'failed' : 'none', format: null, bytes: null, durationMs: null, error: recordingSetupError };
    if (recorder) audio = await recorder.finish();
    let saved = false;
    let transcriptId: string | null = null;
    try {
      await settleUsage(session.userId, session.id, seconds, reason);
      if (lines.length || audio.relPath) {
        const [transcript] = await db.insert(transcripts).values({
          userId: session.userId,
          sessionId: session.id,
          title: room.title.trim() || session.title?.trim() || `翻译会话 · ${endedAt.toLocaleString('zh-CN')}`,
          mode: session.mode,
          languageA: session.languageA,
          languageB: session.languageB ?? session.targetLanguage ?? 'en',
          durationMs: seconds * 1000,
          audioRelPath: audio.relPath,
          audioStatus: audio.status,
          audioFormat: audio.format,
          audioBytes: audio.bytes,
          audioDurationMs: audio.durationMs,
          audioError: audio.error
        }).returning();
        try {
          if (lines.length) {
            await db.insert(transcriptSegments).values(lines.map((segment, index) => ({
              transcriptId: transcript.id,
              idx: index,
              sourceText: segment.source,
              translationText: segment.translation,
              language: segment.language ?? null,
              startMs: segment.startMs ?? null,
              endMs: segment.endMs ?? null,
              speaker: segment.speaker ? room.speakerNames[segment.speaker] ?? segment.speaker : null
            })));
          }
          saved = true;
          transcriptId = transcript.id;
        } catch (error) {
          await db.delete(transcripts).where(eq(transcripts.id, transcript.id));
          throw error;
        }
      }
      if (transcriptId) {
        const [fresh] = await db.select().from(realtimeSessions).where(eq(realtimeSessions.id, session.id));
        if (fresh) await ensureAudienceShare(fresh, transcriptId).catch(() => null);
      }
    } finally {
      if (!saved && audio.relPath) await removeRecording(audio.relPath);
      const host = hostSocket();
      sendJson(host, { type: 'finished', reason, transcriptId });
      if (host.readyState === WebSocket.OPEN) host.close();
      for (const socket of room.audience) {
        sendJson(socket, { type: 'finished' });
        if (socket.readyState === WebSocket.OPEN) socket.close();
      }
      room.audience.clear();
      if (upstream.readyState === upstream.OPEN || upstream.readyState === upstream.CONNECTING) upstream.close();
    }
    if (saved && transcriptId && audio.status === 'encoding') scheduleRecordingEncode(transcriptId);
  };
  activeSessions.set(session.id, requestDrain);
  const keepUpstreamAlive = () => {
    if (ended || stopRequested || room.client || upstream.readyState !== upstream.OPEN) return;
    upstream.send(JSON.stringify({ type: 'keepalive' }));
  };

  upstream.on('open', async () => {
    disableNagle(upstream);
    if (ended) return;
    startedAt = new Date();
    await db.update(realtimeSessions).set({ startedAt, status: 'active' }).where(and(eq(realtimeSessions.id, session.id), eq(realtimeSessions.status, 'connecting')));
    if (ended || upstream.readyState !== upstream.OPEN) return;
    upstream.send(JSON.stringify(buildSonioxConfig(config.sonioxApiKey, session, loadedGlossary.terms, loadedGlossary.glossary)));
    upstreamKeepalive = setInterval(keepUpstreamAlive, UPSTREAM_KEEPALIVE_MS);
    upstreamKeepalive.unref();
    const allowed = room.allowed;
    room.startedAt = startedAt;
    sendJson(hostSocket(), { type: 'ready', sessionId: session.id, allowedSeconds: allowed });
    limitTimer = setTimeout(() => {
      const code = allowed < session.maxSessionSeconds ? 'quota_exhausted' : 'session_limit_reached';
      sendJson(hostSocket(), { type: 'error', code });
      void requestDrain(code);
    }, allowed * 1000);
    limitTimer.unref();
    quotaTimer = setInterval(async () => {
      if (ended) return;
      const [state] = await db.select({ endedAt: realtimeSessions.endedAt }).from(realtimeSessions).where(eq(realtimeSessions.id, session.id));
      if (state?.endedAt) await requestDrain('terminated');
    }, 15_000);
    quotaTimer.unref();
  });
  upstream.on('message', (message, isBinary) => {
    if (isBinary) { if (client.readyState === client.OPEN) client.send(message); return; }
    let event: { tokens?: TranscriptToken[]; total_audio_proc_ms?: number; finished?: boolean; error_code?: number | null; error_type?: string; error_message?: string };
    try { event = JSON.parse(message.toString()) as typeof event; } catch { return; }
    if (event.error_code != null || event.error_type) {
      const code = event.error_type || 'upstream_error';
      sendJson(hostSocket(), { type: 'error', code, message: event.error_message });
      void finish(code).catch(() => undefined);
      return;
    }
    const totalAudioProcMs = typeof event.total_audio_proc_ms === 'number' && Number.isFinite(event.total_audio_proc_ms) ? event.total_audio_proc_ms : undefined;
    if (event.tokens?.length || totalAudioProcMs !== undefined) {
      for (const token of event.tokens ?? []) {
        if (token.text === '<end>' || token.is_final) finalTokens.push(token);
      }
      const tokens = event.tokens ?? [];
      sendJson(hostSocket(), { type: 'transcript', tokens, ...(totalAudioProcMs !== undefined ? { totalAudioProcMs } : {}) });
      if (tokens.length) publishAudience(room, { type: 'transcript', tokens });
    }
    if (event.finished) void finish(drainReason ?? 'completed').catch(() => undefined);
  });
  upstream.on('error', () => { void finish(drainReason ?? 'upstream_error').catch(() => undefined); });
  upstream.on('close', () => { void finish(drainReason ?? 'upstream_closed').catch(() => undefined); });
  let lastClaimTouchMs = Date.now();
  const noteClientActivity = () => {
    const now = Date.now();
    if (now - lastClaimTouchMs < CLAIM_TOUCH_MS) return;
    lastClaimTouchMs = now;
    void db.update(realtimeSessions).set({ claimedAt: new Date(now) }).where(eq(realtimeSessions.id, session.id));
  };
  const bindClient = (socket: WebSocket) => {
    room.client = socket;
    socket.on('message', (message: Buffer, isBinary: boolean) => {
      if (ended || room.client !== socket) return;
      if (!isBinary) {
        const data = message.toString();
        try {
          const event = JSON.parse(data) as { type?: string; names?: unknown; title?: unknown };
          if (event.type === 'speakers') {
            const names = cleanSpeakerNames(event.names);
            if (names) room.speakerNames = names;
            publishAudience(room, { type: 'speakers', names: room.speakerNames });
            return;
          }
          if (event.type === 'title') {
            if (typeof event.title === 'string') room.title = event.title.trim().slice(0, 120);
            publishAudience(room, { type: 'title', title: room.title });
            return;
          }
          if (event.type === 'stop') {
            if (typeof event.title === 'string' && event.title.trim()) room.title = event.title.trim().slice(0, 120);
            void requestDrain('completed');
            return;
          }
          if (stopRequested || upstream.readyState !== upstream.OPEN) return;
          if (event.type === 'keepalive') { lastClaimTouchMs = Date.now(); void db.update(realtimeSessions).set({ claimedAt: new Date() }).where(eq(realtimeSessions.id, session.id)); return void upstream.send(data); }
        } catch { /* Ignore malformed control frames. */ }
        return;
      }
      if (stopRequested || upstream.readyState !== upstream.OPEN) return;
      const pcm = Buffer.isBuffer(message) ? message : Buffer.from(message);
      if (pcm.length) recorder?.push(pcm);
      upstream.send(message);
      room.forwardedAudioBytes += pcm.length;
      noteClientActivity();
    });
    socket.on('close', () => {
      if (room.client !== socket) return;
      room.client = null;
      if (ended || stopRequested) { void requestDrain('client_closed')?.catch(() => undefined); return; }
      keepUpstreamAlive();
      if (room.reconnectTimer) clearTimeout(room.reconnectTimer);
      room.reconnectTimer = setTimeout(() => { void requestDrain('client_closed'); }, RECONNECT_GRACE_MS);
      room.reconnectTimer.unref();
      void db.update(realtimeSessions).set({ status: 'reconnecting', claimedAt: new Date() }).where(and(eq(realtimeSessions.id, session.id), isNull(realtimeSessions.endedAt)));
    });
  };
  room.bindClient = bindClient;
  room.requestDrain = requestDrain;
  bindClient(client);
}

export async function handleReconnectSocket(client: WebSocket, token: string) {
  const [session] = await db.select().from(realtimeSessions).where(and(eq(realtimeSessions.sessionTokenHash, hash(token)), isNull(realtimeSessions.endedAt))).limit(1);
  const room = session ? rooms.get(session.id) : undefined;
  if (!session || !room || room.ended) {
    client.close(1008, 'Invalid session');
    return;
  }
  if (room.client && (room.client.readyState === WebSocket.OPEN || room.client.readyState === WebSocket.CONNECTING)) {
    client.close(1008, 'Session in use');
    return;
  }
  if (room.reconnectTimer) clearTimeout(room.reconnectTimer);
  room.reconnectTimer = undefined;
  await db.update(realtimeSessions).set({ status: 'active', claimedAt: new Date() }).where(eq(realtimeSessions.id, session.id));
  room.bindClient(client);
  const elapsed = room.startedAt ? Math.floor((Date.now() - room.startedAt.getTime()) / 1000) : 0;
  if (client.readyState === client.OPEN) {
    client.send(JSON.stringify({ type: 'ready', sessionId: session.id, allowedSeconds: Math.max(0, room.allowed - elapsed), receivedAudioMs: room.forwardedAudioBytes / 32 }));
    client.send(JSON.stringify({ type: 'snapshot', tokens: room.finalTokens, speakerNames: room.speakerNames }));
  }
}

async function loadSessionTerms(userId: string, glossaryId: string | null): Promise<{ terms: GlossaryTermInput[]; glossary: GlossaryMeta | null }> {
  if (!glossaryId) return { terms: [], glossary: null };
  const [glossary] = await db.select({ languageA: glossaries.languageA, languageB: glossaries.languageB, presetKey: glossaries.presetKey }).from(glossaries).where(and(eq(glossaries.userId, userId), eq(glossaries.id, glossaryId)));
  if (!glossary) return { terms: [], glossary: null };
  const terms = await db.select({ source: glossaryTerms.source, target: glossaryTerms.target, pinned: glossaryTerms.pinned }).from(glossaryTerms).where(eq(glossaryTerms.glossaryId, glossaryId));
  return { terms, glossary };
}
