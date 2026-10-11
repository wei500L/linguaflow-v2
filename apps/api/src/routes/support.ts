import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, sql } from 'drizzle-orm';
import { z } from 'zod';
import { PRODUCT_EVENTS, sanitizeEventProps } from '@linguaflow/shared';
import { db } from '../db/index.js';
import { adminAudit, realtimeSessions, supportRequests } from '../db/schema.js';
import { recordEvent } from '../lib/events.js';

const CLIENT_EVENTS = new Set(['onboarding_started', 'onboarding_completed', 'latency_sample']);
const categories = ['audio', 'network', 'quota', 'sharing', 'notes', 'account', 'other'] as const;

function cleanDiagnostics(value: Record<string, string> | undefined) {
  if (!value) return null;
  const clean: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value).slice(0, 12)) {
    if (!/^[a-z0-9_]{1,40}$/i.test(key)) continue;
    clean[key] = raw.replace(/[\r\n]/g, ' ').slice(0, 120);
  }
  return clean;
}

async function tooMany(userId: string) {
  const since = new Date(Date.now() - 60 * 60 * 1000);
  const [row] = await db.select({ count: sql<number>`count(*)::int` }).from(supportRequests).where(and(eq(supportRequests.userId, userId), gte(supportRequests.createdAt, since)));
  return Number(row?.count ?? 0) >= 8;
}

export async function supportRoutes(app: FastifyInstance) {
  app.post('/v1/support', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const body = z.object({
      kind: z.enum(['feedback', 'activation', 'free_review']).default('feedback'),
      category: z.enum(categories).default('other'),
      body: z.string().trim().min(1).max(2000),
      sessionId: z.string().uuid().optional(),
      diagnostics: z.record(z.string().max(200)).optional()
    }).parse(request.body);
    if (await tooMany(userId)) return reply.code(429).send({ message: '提交太频繁，请稍后再试。' });
    if (body.sessionId) {
      const [session] = await db.select({ id: realtimeSessions.id }).from(realtimeSessions).where(and(eq(realtimeSessions.id, body.sessionId), eq(realtimeSessions.userId, userId)));
      if (!session) return reply.code(404).send({ message: '找不到这场翻译。' });
    }
    const [created] = await db.insert(supportRequests).values({
      userId,
      kind: body.kind,
      category: body.category,
      body: body.body,
      sessionId: body.sessionId ?? null,
      diagnostics: cleanDiagnostics(body.diagnostics)
    }).returning({ id: supportRequests.id, status: supportRequests.status, createdAt: supportRequests.createdAt });
    const event = body.kind === 'activation' ? 'activation_requested' : 'support_submitted';
    await recordEvent({ userId, name: event, dedupeKey: `${event}:${created.id}`, props: { status: created.status } });
    return reply.code(201).send(created);
  });

  app.get('/v1/support', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    return db.select({
      id: supportRequests.id,
      kind: supportRequests.kind,
      category: supportRequests.category,
      status: supportRequests.status,
      resolution: supportRequests.resolution,
      createdAt: supportRequests.createdAt,
      updatedAt: supportRequests.updatedAt
    }).from(supportRequests).where(eq(supportRequests.userId, userId)).orderBy(desc(supportRequests.createdAt)).limit(50);
  });

  app.post('/v1/events', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const body = z.object({
      name: z.string(),
      dedupeKey: z.string().trim().min(4).max(120),
      props: z.record(z.union([z.string(), z.number(), z.boolean(), z.null()])).optional()
    }).parse(request.body);
    if (!CLIENT_EVENTS.has(body.name) || !(PRODUCT_EVENTS as readonly string[]).includes(body.name)) return reply.code(400).send({ message: '不记录这个事件。' });
    await recordEvent({ userId, name: body.name, dedupeKey: `${userId}:${body.dedupeKey}`, source: 'client', props: sanitizeEventProps(body.props) });
    return { ok: true };
  });
}

export async function adminSupportRoutes(app: FastifyInstance) {
  app.get('/v1/admin/support', async (request) => {
    const query = z.object({ status: z.enum(['open', 'in_progress', 'resolved', 'rejected']).optional(), kind: z.enum(['feedback', 'activation', 'free_review']).optional() }).parse(request.query);
    const filters = [];
    if (query.status) filters.push(eq(supportRequests.status, query.status));
    if (query.kind) filters.push(eq(supportRequests.kind, query.kind));
    return db.select().from(supportRequests).where(filters.length ? and(...filters) : undefined).orderBy(desc(supportRequests.createdAt)).limit(100);
  });

  app.patch('/v1/admin/support/:id', async (request, reply) => {
    const adminId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const body = z.object({ status: z.enum(['open', 'in_progress', 'resolved', 'rejected']), resolution: z.string().trim().max(2000).optional() }).parse(request.body);
    const [updated] = await db.update(supportRequests).set({ status: body.status, resolution: body.resolution ?? null, updatedAt: new Date() }).where(eq(supportRequests.id, id)).returning();
    if (!updated) return reply.code(404).send({ message: '找不到这条申请。' });
    await db.insert(adminAudit).values({ adminId, action: 'support_updated', targetUserId: updated.userId, payloadJson: { id, status: body.status } });
    return { id: updated.id, status: updated.status, resolution: updated.resolution };
  });
}
