import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { courses, entitlements, glossaries, glossaryTerms, realtimeSessions, transcripts } from '../db/schema.js';
import { assertFreeTranslation, deviceDenied, recordUserDevice } from '../lib/device-store.js';
import { recordEvent } from '../lib/events.js';
import { holdFreeDevice, remainingSeconds } from '../lib/quota.js';
import { PLANS } from '@linguaflow/shared';
import { audienceReveal, newAudienceToken, revokeAudienceShare } from '../lib/audience.js';
import { audienceCount, closeActiveSession, dropAudience, handleRealtimeSocket, holdSession, noteRoomGap } from '../realtime/proxy.js';
import { finalizePersistedSession, rememberGap, rememberMarker } from '../realtime/persist.js';
import { glossaryInjection, sameLanguageResponse, type GlossaryMeta, type SonioxSessionInput } from '../realtime/soniox.js';
import { socketUrl } from '../lib/socket-url.js';

export const quotaExhaustedMessage = '额度已用完，无法开始新的翻译。';
export const sessionConflictMessage = '上一场翻译还在占用额度。';

function sessionInput(body: z.infer<typeof sessionBody>, id: string): SonioxSessionInput {
  return { id, mode: body.type, languageA: body.languageA, languageB: body.type === 'two_way' ? body.languageB : null, targetLanguage: body.type === 'one_way' ? body.targetLanguage : null };
}

const titleField = z.string().trim().min(1).max(120).optional();
const shareIntentField = z.enum(['personal', 'audience']).default('personal');
const sessionBody = z.union([
  z.object({ type: z.literal('one_way'), languageA: z.string().min(2), targetLanguage: z.string().min(2), glossaryId: z.string().uuid().optional(), recordAudio: z.boolean().optional(), title: titleField, shareIntent: shareIntentField, courseId: z.string().uuid().optional() }),
  z.object({ type: z.literal('two_way'), languageA: z.string().min(2), languageB: z.string().min(2), glossaryId: z.string().uuid().optional(), recordAudio: z.boolean().optional(), title: titleField, shareIntent: shareIntentField, courseId: z.string().uuid().optional() })
]);

export async function realtimeRoutes(app: FastifyInstance) {
  app.post('/v1/realtime/sessions', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    let body = sessionBody.parse(request.body);
    let courseWarning: string | null = null;
    if (body.courseId) {
      const [course] = await db.select().from(courses).where(and(eq(courses.id, body.courseId), eq(courses.userId, userId)));
      if (!course) return reply.code(404).send({ message: '找不到这门课。' });
      let glossaryId = course.glossaryId ?? undefined;
      if (glossaryId) {
        const [glossary] = await db.select({ id: glossaries.id }).from(glossaries).where(and(eq(glossaries.id, glossaryId), eq(glossaries.userId, userId)));
        if (!glossary) { glossaryId = undefined; courseWarning = 'glossary_missing'; }
      }
      const title = body.title ?? (course.titlePattern ? course.titlePattern.replaceAll('{date}', new Date().toLocaleDateString('zh-CN')).slice(0, 120) : undefined);
      body = course.mode === 'two_way'
        ? { type: 'two_way', languageA: course.languageA, languageB: course.languageB, glossaryId, recordAudio: course.recordAudio, title, shareIntent: body.shareIntent, courseId: course.id }
        : { type: 'one_way', languageA: course.languageA, targetLanguage: course.languageB, glossaryId, recordAudio: course.recordAudio, title, shareIntent: body.shareIntent, courseId: course.id };
    }
    const conflict = sameLanguageResponse(body);
    if (conflict) return reply.code(conflict.status).send({ code: conflict.code, message: conflict.message });
    let glossaryMeta: GlossaryMeta | null = null;
    if (body.glossaryId) {
      const [glossary] = await db.select({ id: glossaries.id, languageA: glossaries.languageA, languageB: glossaries.languageB, presetKey: glossaries.presetKey }).from(glossaries).where(and(eq(glossaries.id, body.glossaryId), eq(glossaries.userId, userId)));
      if (!glossary) return reply.code(404).send({ message: '找不到术语库。' });
      glossaryMeta = glossary;
    }
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    const device = await recordUserDevice(userId, request);
    await assertFreeTranslation(userId, device);
    const session = await db.transaction(async (tx) => {
      const [entitlement] = await tx.select().from(entitlements).where(eq(entitlements.userId, userId)).for('update');
      const maxSeconds = PLANS[entitlement.plan as keyof typeof PLANS].maxSessionSeconds;
      const available = remainingSeconds(entitlement) + entitlement.addonSeconds;
      if (available <= 0) throw Object.assign(new Error('quota_exhausted'), { statusCode: 402, code: 'quota_exhausted' });
      if (entitlement.plan === 'free') {
        if (!device) throw deviceDenied('device_required');
        if (remainingSeconds(entitlement) > 0) await holdFreeDevice(tx, userId, device.fingerprintHash, device.deviceId, device.strong !== false);
      }
      const [active] = await tx.select().from(realtimeSessions).where(and(eq(realtimeSessions.userId, userId), isNull(realtimeSessions.endedAt))).for('update');
      if (active) throw Object.assign(new Error('session_conflict'), { statusCode: 409, code: 'session_conflict', sessionId: active.id });
      const [created] = await tx.insert(realtimeSessions).values({ userId, sessionTokenHash: crypto.createHash('sha256').update(sessionToken).digest('hex'), mode: body.type, languageA: body.languageA, languageB: body.type === 'two_way' ? body.languageB : null, targetLanguage: body.type === 'one_way' ? body.targetLanguage : null, glossaryId: body.glossaryId, maxSessionSeconds: maxSeconds, reservedSeconds: Math.min(maxSeconds, available), recordAudio: body.recordAudio ?? true, title: body.title ?? null, fingerprintHash: device?.fingerprintHash ?? null, deviceId: device?.deviceId ?? null, shareIntent: body.shareIntent, courseId: body.courseId ?? null }).returning();
      return created;
    }).catch(async (error: any) => {
      if (error?.code === 'quota_exhausted') return reply.code(402).send({ code: 'quota_exhausted', message: quotaExhaustedMessage });
      if (error?.code === 'free_device_blocked' || error?.code === 'device_required') throw error;
      if (error?.code === 'session_conflict' || error?.code === '23505') {
        const [active] = error?.sessionId ? [{ id: error.sessionId }] : await db.select({ id: realtimeSessions.id }).from(realtimeSessions).where(and(eq(realtimeSessions.userId, userId), isNull(realtimeSessions.endedAt))).limit(1);
        return reply.code(409).send({ code: 'session_conflict', message: sessionConflictMessage, sessionId: active?.id ?? null });
      }
      throw error;
    });
    if ('sent' in session) return session;
    const preview = body.glossaryId && glossaryMeta ? glossaryInjection(sessionInput(body, session.id), await db.select({ source: glossaryTerms.source, target: glossaryTerms.target, pinned: glossaryTerms.pinned }).from(glossaryTerms).where(eq(glossaryTerms.glossaryId, body.glossaryId)), glossaryMeta) : { used: 0, dropped: 0, droppedTerms: [] as string[] };
    await recordEvent({ userId, name: 'session_start_attempted', dedupeKey: `session_start_attempted:${session.id}`, props: { sessionId: session.id, mode: session.mode } });
    return { sessionId: session.id, title: session.title, maxSessionSeconds: session.maxSessionSeconds, websocketUrl: socketUrl(request, '/v1/realtime/ws'), websocketProtocols: ['realtime.v1', sessionToken], glossaryTermsUsed: preview.used, glossaryTermsDropped: preview.dropped, shareIntent: session.shareIntent, courseWarning };
  });

  app.get('/v1/realtime/sessions/active', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    const [session] = await db.select({ id: realtimeSessions.id, mode: realtimeSessions.mode, status: realtimeSessions.status, startedAt: realtimeSessions.startedAt, title: realtimeSessions.title, languageA: realtimeSessions.languageA, languageB: realtimeSessions.languageB, targetLanguage: realtimeSessions.targetLanguage }).from(realtimeSessions).where(and(eq(realtimeSessions.userId, userId), isNull(realtimeSessions.endedAt))).limit(1);
    return { session: session ?? null };
  });

  app.get('/v1/realtime/sessions/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const parsed = z.string().uuid().safeParse((request.params as { id: string }).id);
    if (!parsed.success) return reply.code(404).send({ message: '找不到这场翻译。' });
    const [session] = await db.select({
      id: realtimeSessions.id,
      mode: realtimeSessions.mode,
      status: realtimeSessions.status,
      title: realtimeSessions.title,
      languageA: realtimeSessions.languageA,
      languageB: realtimeSessions.languageB,
      targetLanguage: realtimeSessions.targetLanguage,
      endedAt: realtimeSessions.endedAt,
      endReason: realtimeSessions.endReason,
      saveStatus: realtimeSessions.saveStatus,
      checkpointAt: realtimeSessions.checkpointAt,
      transcriptId: transcripts.id,
      recordStatus: transcripts.recordStatus
    }).from(realtimeSessions).leftJoin(transcripts, eq(transcripts.sessionId, realtimeSessions.id)).where(and(eq(realtimeSessions.id, parsed.data), eq(realtimeSessions.userId, userId))).orderBy(desc(transcripts.createdAt)).limit(1);
    if (!session) return reply.code(404).send({ message: '找不到这场翻译。' });
    return {
      session: {
        id: session.id,
        mode: session.mode,
        status: session.status,
        title: session.title,
        languageA: session.languageA,
        languageB: session.languageB,
        targetLanguage: session.targetLanguage,
        endedAt: session.endedAt ? session.endedAt.toISOString() : null,
        endReason: session.endReason,
        saveStatus: session.saveStatus,
        savedThrough: session.checkpointAt ? session.checkpointAt.toISOString() : null,
        transcriptId: session.transcriptId,
        recordStatus: session.recordStatus
      }
    };
  });

  app.post('/v1/realtime/sessions/:id/reconnect', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const [session] = await db.select().from(realtimeSessions).where(and(eq(realtimeSessions.id, id), eq(realtimeSessions.userId, userId), isNull(realtimeSessions.endedAt)));
    if (!session) return reply.code(404).send({ code: 'session_not_resumable', message: '这场翻译已经结束，无法恢复。' });
    if (!holdSession(id)) return reply.code(409).send({ code: 'session_not_resumable', message: '这场翻译正在另一台设备上继续，或已经不在服务器上。' });
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    await db.update(realtimeSessions).set({ sessionTokenHash: crypto.createHash('sha256').update(sessionToken).digest('hex'), status: 'reconnecting', claimedAt: new Date() }).where(eq(realtimeSessions.id, id));
    return { sessionId: id, websocketUrl: socketUrl(request, '/v1/realtime/ws'), websocketProtocols: ['realtime.v1', sessionToken] };
  });

  app.get('/v1/realtime/sessions/:id/audience', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const [session] = await db.select().from(realtimeSessions).where(and(eq(realtimeSessions.id, id), eq(realtimeSessions.userId, userId), isNull(realtimeSessions.endedAt)));
    if (!session) return reply.code(404).send({ message: '这场翻译已经结束。' });
    return { audience: audienceReveal(session), viewerCount: audienceCount(id) };
  });

  app.post('/v1/realtime/sessions/:id/audience', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const body = z.object({ includeAudio: z.boolean().optional(), keepAfter: z.boolean().optional(), expiresInHours: z.number().int().min(1).max(24 * 30).nullable().optional(), reissue: z.boolean().optional() }).parse(request.body ?? {});
    const [session] = await db.select().from(realtimeSessions).where(and(eq(realtimeSessions.id, id), eq(realtimeSessions.userId, userId), isNull(realtimeSessions.endedAt)));
    if (!session) return reply.code(404).send({ message: '这场翻译已经结束。' });
    const hours = body.expiresInHours && body.expiresInHours > 0 ? body.expiresInHours : 24 * 30;
    const expiresAt = new Date(Date.now() + hours * 60 * 60 * 1000);
    const keep = Boolean(session.audienceTokenHash) && !session.audienceRevokedAt && !body.reissue;
    const minted = keep ? null : newAudienceToken();
    const token = minted?.token ?? session.audienceToken;
    const includeAudio = body.includeAudio ?? (keep ? session.audienceIncludeAudio : false);
    const keepAfter = body.keepAfter ?? (keep ? session.audienceKeepAfter : false);
    const [updated] = await db.update(realtimeSessions).set({
      audienceToken: token,
      audienceTokenHash: minted?.tokenHash ?? session.audienceTokenHash,
      audienceIncludeAudio: includeAudio,
      audienceKeepAfter: keepAfter,
      shareIntent: 'audience',
      audienceExpiresAt: expiresAt,
      audienceRevokedAt: null
    }).where(eq(realtimeSessions.id, id)).returning({ token: realtimeSessions.audienceToken, includeAudio: realtimeSessions.audienceIncludeAudio, expiresAt: realtimeSessions.audienceExpiresAt, keepAfter: realtimeSessions.audienceKeepAfter });
    await recordEvent({ userId, name: 'audience_sharing_enabled', dedupeKey: `audience_sharing_enabled:${id}:${updated.token ?? 'existing'}`, props: { sessionId: id } });
    if (minted) dropAudience(id);
    return reply.code(201).send({ audience: { token: updated.token, includeAudio: updated.includeAudio, keepAfter: updated.keepAfter, expiresAt: updated.expiresAt } });
  });

  app.delete('/v1/realtime/sessions/:id/audience', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const [session] = await db.select().from(realtimeSessions).where(and(eq(realtimeSessions.id, id), eq(realtimeSessions.userId, userId)));
    if (!session) return reply.code(404).send({ message: '这场翻译已经结束。' });
    await db.update(realtimeSessions).set({ audienceRevokedAt: new Date() }).where(eq(realtimeSessions.id, id));
    if (session.audienceTokenHash) await revokeAudienceShare(session.audienceTokenHash);
    dropAudience(id);
    await recordEvent({ userId, name: 'audience_sharing_revoked', dedupeKey: `audience_sharing_revoked:${id}:${Date.now()}`, props: { sessionId: id } });
    return reply.code(204).send();
  });

  app.get('/v1/realtime/ws', { websocket: true }, async (socket, request) => {
    const protocols = request.headers['sec-websocket-protocol']?.split(',').map((part) => part.trim()) ?? [];
    const token = protocols[1];
    if (!token) return socket.close(1008, 'Missing session token');
    await handleRealtimeSocket(socket, token);
  });

  app.post('/v1/realtime/sessions/:id/controls', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const body = z.object({
      items: z.array(z.object({
        type: z.enum(['marker', 'gap']),
        id: z.string().uuid(),
        kind: z.enum(['important', 'unclear', 'assignment']).optional(),
        source: z.enum(['user_pause', 'system_suspend', 'reconnect', 'queue_overflow', 'dropped']).optional(),
        note: z.string().max(500).nullable().optional(),
        wallMs: z.number().nullable().optional(),
        audioMs: z.number().nullable().optional(),
        wallStartMs: z.number().nullable().optional(),
        wallEndMs: z.number().nullable().optional(),
        audioStartMs: z.number().nullable().optional(),
        audioEndMs: z.number().nullable().optional(),
        precision: z.enum(['exact', 'estimated', 'unknown']).optional()
      })).max(40)
    }).parse(request.body);
    const [session] = await db.select({ id: realtimeSessions.id, endReason: realtimeSessions.endReason }).from(realtimeSessions).where(and(eq(realtimeSessions.id, id), eq(realtimeSessions.userId, userId)));
    if (!session || session.endReason === 'purged') return reply.code(404).send({ message: '找不到这场翻译。' });
    const saved: string[] = [];
    for (const item of body.items) {
      if (item.type === 'marker' && item.kind) {
        const ok = await rememberMarker({ id: item.id, userId, sessionId: id, kind: item.kind, note: item.note, wallMs: item.wallMs, audioMs: item.audioMs });
        if (ok) saved.push(item.id);
      }
      if (item.type === 'gap' && item.source && item.precision) {
        const gap = { id: item.id, source: item.source, wallStartMs: item.wallStartMs ?? null, wallEndMs: item.wallEndMs ?? null, audioStartMs: item.audioStartMs ?? null, audioEndMs: item.audioEndMs ?? null, precision: item.precision };
        const ok = await rememberGap(id, gap);
        if (ok) { noteRoomGap(id, gap); saved.push(item.id); }
      }
    }
    return { saved };
  });

  app.delete('/v1/realtime/sessions/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const [session] = await db.select().from(realtimeSessions).where(and(eq(realtimeSessions.id, id), eq(realtimeSessions.userId, userId), isNull(realtimeSessions.endedAt)));
    if (session) {
      const closed = await closeActiveSession(id, 'cancelled');
      if (!closed) await finalizePersistedSession(id, 'cancelled', { interrupted: true });
    }
    return reply.code(204).send();
  });
}
