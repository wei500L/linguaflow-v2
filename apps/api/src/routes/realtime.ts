import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, eq, isNull } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { entitlements, glossaries, glossaryTerms, realtimeSessions } from '../db/schema.js';
import { ensureEntitlement, remainingSeconds } from '../lib/quota.js';
import { PLANS } from '@linguaflow/shared';
import { audienceIsOpen, newAudienceToken, revokeAudienceShare } from '../lib/audience.js';
import { audienceCount, closeActiveSession, dropAudience, handleRealtimeSocket, holdSession } from '../realtime/proxy.js';
import { glossaryInjection, sameLanguageResponse, type GlossaryMeta, type SonioxSessionInput } from '../realtime/soniox.js';
import { settleUsage } from '../lib/quota.js';

export const quotaExhaustedMessage = '额度已用完，无法开始新的翻译。';
export const sessionConflictMessage = '上一场翻译还在占用额度。';

function sessionInput(body: z.infer<typeof sessionBody>, id: string): SonioxSessionInput {
  return { id, mode: body.type, languageA: body.languageA, languageB: body.type === 'two_way' ? body.languageB : null, targetLanguage: body.type === 'one_way' ? body.targetLanguage : null };
}

const titleField = z.string().trim().min(1).max(120).optional();
const sessionBody = z.union([
  z.object({ type: z.literal('one_way'), languageA: z.string().min(2), targetLanguage: z.string().min(2), glossaryId: z.string().uuid().optional(), recordAudio: z.boolean().optional(), title: titleField }),
  z.object({ type: z.literal('two_way'), languageA: z.string().min(2), languageB: z.string().min(2), glossaryId: z.string().uuid().optional(), recordAudio: z.boolean().optional(), title: titleField })
]);

export async function realtimeRoutes(app: FastifyInstance) {
  app.post('/v1/realtime/sessions', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const body = sessionBody.parse(request.body);
    const conflict = sameLanguageResponse(body);
    if (conflict) return reply.code(conflict.status).send({ code: conflict.code, message: conflict.message });
    let glossaryMeta: GlossaryMeta | null = null;
    if (body.glossaryId) {
      const [glossary] = await db.select({ id: glossaries.id, languageA: glossaries.languageA, languageB: glossaries.languageB, presetKey: glossaries.presetKey }).from(glossaries).where(and(eq(glossaries.id, body.glossaryId), eq(glossaries.userId, userId)));
      if (!glossary) return reply.code(404).send({ message: '找不到术语库。' });
      glossaryMeta = glossary;
    }
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    await ensureEntitlement(userId);
    const session = await db.transaction(async (tx) => {
      const [entitlement] = await tx.select().from(entitlements).where(eq(entitlements.userId, userId)).for('update');
      const maxSeconds = PLANS[entitlement.plan as keyof typeof PLANS].maxSessionSeconds;
      const available = remainingSeconds(entitlement) + entitlement.addonSeconds;
      if (available <= 0) throw Object.assign(new Error('quota_exhausted'), { statusCode: 402, code: 'quota_exhausted' });
      const [active] = await tx.select().from(realtimeSessions).where(and(eq(realtimeSessions.userId, userId), isNull(realtimeSessions.endedAt))).for('update');
      if (active) throw Object.assign(new Error('session_conflict'), { statusCode: 409, code: 'session_conflict', sessionId: active.id });
      const [created] = await tx.insert(realtimeSessions).values({ userId, sessionTokenHash: crypto.createHash('sha256').update(sessionToken).digest('hex'), mode: body.type, languageA: body.languageA, languageB: body.type === 'two_way' ? body.languageB : null, targetLanguage: body.type === 'one_way' ? body.targetLanguage : null, glossaryId: body.glossaryId, maxSessionSeconds: maxSeconds, reservedSeconds: Math.min(maxSeconds, available), recordAudio: body.recordAudio ?? true, title: body.title ?? null }).returning();
      return created;
    }).catch(async (error: any) => {
      if (error?.code === 'quota_exhausted') return reply.code(402).send({ code: 'quota_exhausted', message: quotaExhaustedMessage });
      if (error?.code === 'session_conflict' || error?.code === '23505') {
        const [active] = error?.sessionId ? [{ id: error.sessionId }] : await db.select({ id: realtimeSessions.id }).from(realtimeSessions).where(and(eq(realtimeSessions.userId, userId), isNull(realtimeSessions.endedAt))).limit(1);
        return reply.code(409).send({ code: 'session_conflict', message: sessionConflictMessage, sessionId: active?.id ?? null });
      }
      throw error;
    });
    if ('sent' in session) return session;
    const preview = body.glossaryId && glossaryMeta ? glossaryInjection(sessionInput(body, session.id), await db.select({ source: glossaryTerms.source, target: glossaryTerms.target, pinned: glossaryTerms.pinned }).from(glossaryTerms).where(eq(glossaryTerms.glossaryId, body.glossaryId)), glossaryMeta) : { used: 0, dropped: 0, droppedTerms: [] as string[] };
    const host = request.headers.host ?? 'localhost:3000';
    const protocol = request.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
    return { sessionId: session.id, maxSessionSeconds: session.maxSessionSeconds, websocketUrl: `${protocol}://${host}/v1/realtime/ws`, websocketProtocols: ['realtime.v1', sessionToken], glossaryTermsUsed: preview.used, glossaryTermsDropped: preview.dropped };
  });

  app.get('/v1/realtime/sessions/active', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    const [session] = await db.select({ id: realtimeSessions.id, mode: realtimeSessions.mode, status: realtimeSessions.status, startedAt: realtimeSessions.startedAt, title: realtimeSessions.title, languageA: realtimeSessions.languageA, languageB: realtimeSessions.languageB, targetLanguage: realtimeSessions.targetLanguage }).from(realtimeSessions).where(and(eq(realtimeSessions.userId, userId), isNull(realtimeSessions.endedAt))).limit(1);
    return { session: session ?? null };
  });

  app.post('/v1/realtime/sessions/:id/reconnect', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const [session] = await db.select().from(realtimeSessions).where(and(eq(realtimeSessions.id, id), eq(realtimeSessions.userId, userId), isNull(realtimeSessions.endedAt)));
    if (!session) return reply.code(404).send({ code: 'session_not_resumable', message: '这场翻译已经结束，无法恢复。' });
    if (!holdSession(id)) return reply.code(409).send({ code: 'session_not_resumable', message: '这场翻译正在另一台设备上继续，或已经不在服务器上。' });
    const sessionToken = crypto.randomBytes(32).toString('base64url');
    await db.update(realtimeSessions).set({ sessionTokenHash: crypto.createHash('sha256').update(sessionToken).digest('hex'), status: 'reconnecting', claimedAt: new Date() }).where(eq(realtimeSessions.id, id));
    const host = request.headers.host ?? 'localhost:3000';
    const protocol = request.headers['x-forwarded-proto'] === 'https' ? 'wss' : 'ws';
    return { sessionId: id, websocketUrl: `${protocol}://${host}/v1/realtime/ws`, websocketProtocols: ['realtime.v1', sessionToken] };
  });

  app.get('/v1/realtime/sessions/:id/audience', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const [session] = await db.select().from(realtimeSessions).where(and(eq(realtimeSessions.id, id), eq(realtimeSessions.userId, userId), isNull(realtimeSessions.endedAt)));
    if (!session) return reply.code(404).send({ message: '这场翻译已经结束。' });
    if (!audienceIsOpen(session) || !session.audienceToken) return { audience: null, viewerCount: audienceCount(id) };
    return { audience: { token: session.audienceToken, includeAudio: session.audienceIncludeAudio, expiresAt: session.audienceExpiresAt }, viewerCount: audienceCount(id) };
  });

  app.post('/v1/realtime/sessions/:id/audience', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const body = z.object({ includeAudio: z.boolean().default(false), expiresInHours: z.number().int().min(1).max(24 * 30).nullable().optional() }).parse(request.body ?? {});
    const [session] = await db.select().from(realtimeSessions).where(and(eq(realtimeSessions.id, id), eq(realtimeSessions.userId, userId), isNull(realtimeSessions.endedAt)));
    if (!session) return reply.code(404).send({ message: '这场翻译已经结束。' });
    const expiresAt = body.expiresInHours === null ? null : new Date(Date.now() + (body.expiresInHours ?? 24 * 7) * 60 * 60 * 1000);
    const minted = session.audienceToken && session.audienceTokenHash && !session.audienceRevokedAt ? { token: session.audienceToken, tokenHash: session.audienceTokenHash } : newAudienceToken();
    const [updated] = await db.update(realtimeSessions).set({
      audienceToken: minted.token,
      audienceTokenHash: minted.tokenHash,
      audienceIncludeAudio: body.includeAudio,
      audienceExpiresAt: expiresAt,
      audienceRevokedAt: null
    }).where(eq(realtimeSessions.id, id)).returning({ token: realtimeSessions.audienceToken, includeAudio: realtimeSessions.audienceIncludeAudio, expiresAt: realtimeSessions.audienceExpiresAt });
    return reply.code(201).send({ audience: updated });
  });

  app.delete('/v1/realtime/sessions/:id/audience', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const [session] = await db.select().from(realtimeSessions).where(and(eq(realtimeSessions.id, id), eq(realtimeSessions.userId, userId)));
    if (!session) return reply.code(404).send({ message: '这场翻译已经结束。' });
    await db.update(realtimeSessions).set({ audienceRevokedAt: new Date() }).where(eq(realtimeSessions.id, id));
    if (session.audienceTokenHash) await revokeAudienceShare(session.audienceTokenHash);
    dropAudience(id);
    return reply.code(204).send();
  });

  app.get('/v1/realtime/ws', { websocket: true }, async (socket, request) => {
    const protocols = request.headers['sec-websocket-protocol']?.split(',').map((part) => part.trim()) ?? [];
    const token = protocols[1];
    if (!token) return socket.close(1008, 'Missing session token');
    await handleRealtimeSocket(socket, token);
  });

  app.delete('/v1/realtime/sessions/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const [session] = await db.select().from(realtimeSessions).where(and(eq(realtimeSessions.id, id), eq(realtimeSessions.userId, userId), isNull(realtimeSessions.endedAt)));
    if (session) {
      await closeActiveSession(id, 'cancelled');
      const seconds = session.startedAt ? Math.max(0, Math.ceil((Date.now() - session.startedAt.getTime()) / 1000)) : 0;
      await settleUsage(userId, id, seconds, 'cancelled');
    }
    return reply.code(204).send();
  });
}
