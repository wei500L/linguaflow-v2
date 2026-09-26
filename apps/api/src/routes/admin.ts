import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, isNull, sql as query } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { activationCodes, adminAudit, entitlements, realtimeSessions, usageLedger, users } from '../db/schema.js';
import { closeActiveSession } from '../realtime/proxy.js';

const hashCode = (code: string) => crypto.createHash('sha256').update(code).digest('hex');
const makeCode = () => `LF-${crypto.randomBytes(4).toString('hex').toUpperCase()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;

async function requireAdmin(request: any, reply: any) {
  const user = request.user as { role?: string };
  if (user.role !== 'admin') return reply.code(403).send({ message: 'Admin access required' });
}

export async function adminRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);
  app.addHook('preHandler', requireAdmin);

  app.get('/v1/admin/users', async (request) => {
    const { q } = request.query as { q?: string };
    const filter = q ? query`${users.email} ILIKE ${'%' + q + '%'}` : undefined;
    return db.select({
      id: users.id,
      email: users.email,
      displayName: users.displayName,
      role: users.role,
      createdAt: users.createdAt,
      plan: entitlements.plan,
      addonSeconds: entitlements.addonSeconds,
      usedSecondsThisPeriod: entitlements.usedSecondsThisPeriod,
      planExpiresAt: entitlements.planExpiresAt
    }).from(users).leftJoin(entitlements, eq(users.id, entitlements.userId)).where(filter).orderBy(desc(users.createdAt)).limit(50);
  });

  app.get('/v1/admin/activation-codes', async () => {
    return db.select({
      id: activationCodes.id,
      codePrefix: activationCodes.codePrefix,
      plan: activationCodes.plan,
      months: activationCodes.months,
      addonSeconds: activationCodes.addonSeconds,
      note: activationCodes.note,
      redemptionCount: activationCodes.redemptionCount,
      maxRedemptions: activationCodes.maxRedemptions,
      expiresAt: activationCodes.expiresAt,
      disabled: activationCodes.disabled,
      createdAt: activationCodes.createdAt
    }).from(activationCodes).orderBy(desc(activationCodes.createdAt)).limit(50);
  });

  app.patch('/v1/admin/activation-codes/:id', async (request, reply) => {
    const adminId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const body = z.object({ disabled: z.boolean() }).parse(request.body);
    const [code] = await db.update(activationCodes).set({ disabled: body.disabled }).where(eq(activationCodes.id, id)).returning({ id: activationCodes.id, disabled: activationCodes.disabled });
    if (!code) return reply.code(404).send({ message: 'Activation code not found' });
    await db.insert(adminAudit).values({ adminId, action: body.disabled ? 'activation_code_disabled' : 'activation_code_enabled', payloadJson: { codeId: id } });
    return code;
  });

  app.post('/v1/admin/users/:id/addon', async (request, reply) => {
    const adminId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const body = z.object({ minutes: z.number().int().min(1).max(100000) }).parse(request.body);
    const seconds = body.minutes * 60;
    const [updated] = await db.update(entitlements).set({ addonSeconds: query`${entitlements.addonSeconds} + ${seconds}` }).where(eq(entitlements.userId, id)).returning({ addonSeconds: entitlements.addonSeconds });
    if (!updated) return reply.code(404).send({ message: 'Account not found' });
    await db.insert(adminAudit).values({ adminId, action: 'addon_granted', targetUserId: id, payloadJson: { minutes: body.minutes } });
    return updated;
  });

  app.get('/v1/admin/realtime-sessions', async () => {
    return db.select({
      id: realtimeSessions.id,
      email: users.email,
      mode: realtimeSessions.mode,
      status: realtimeSessions.status,
      startedAt: realtimeSessions.startedAt,
      createdAt: realtimeSessions.createdAt
    }).from(realtimeSessions).leftJoin(users, eq(realtimeSessions.userId, users.id)).where(and(isNull(realtimeSessions.endedAt))).orderBy(desc(realtimeSessions.createdAt)).limit(50);
  });

  app.get('/v1/admin/usage', async () => {
    const rows = await db.select({ kind: usageLedger.kind, source: usageLedger.source, seconds: query<number>`coalesce(sum(${usageLedger.seconds}), 0)::int` }).from(usageLedger).where(eq(usageLedger.status, 'settled')).groupBy(usageLedger.kind, usageLedger.source);
    const [active] = await db.select({ count: query<number>`count(*)::int` }).from(realtimeSessions).where(isNull(realtimeSessions.endedAt));
    return { activeSessions: active?.count ?? 0, totals: rows };
  });

  app.post('/v1/admin/activation-codes', async (request, reply) => {
    const adminId = (request.user as { sub: string }).sub;
    const body = z.object({ plan: z.enum(['free', 'plus', 'pro', 'ultra']).nullable().optional(), months: z.number().int().min(1).max(120).nullable().optional(), addonSeconds: z.number().int().min(0).default(0), count: z.number().int().min(1).max(100).default(1), maxRedemptions: z.number().int().min(1).max(10000).default(1), expiresInDays: z.number().int().min(1).max(3650).optional(), note: z.string().max(200).optional() }).parse(request.body);
    const codes = Array.from({ length: body.count }, () => makeCode());
    const expiresAt = body.expiresInDays ? new Date(Date.now() + body.expiresInDays * 24 * 60 * 60 * 1000) : null;
    await db.insert(activationCodes).values(codes.map((code) => ({ codeHash: hashCode(code), codePrefix: code.slice(0, 7), plan: body.plan ?? null, months: body.months ?? null, addonSeconds: body.addonSeconds, maxRedemptions: body.maxRedemptions, expiresAt, note: body.note, createdBy: adminId })));
    await db.insert(adminAudit).values({ adminId, action: 'activation_codes_created', payloadJson: { count: codes.length, plan: body.plan, months: body.months, addonSeconds: body.addonSeconds } });
    return reply.code(201).send({ codes });
  });

  app.post('/v1/admin/users/:id/plan', async (request, reply) => {
    const adminId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const body = z.object({ plan: z.enum(['free', 'plus', 'pro', 'ultra']), months: z.number().int().min(1).max(120) }).parse(request.body);
    const current = await db.select().from(entitlements).where(eq(entitlements.userId, id));
    const base = current[0]?.planExpiresAt && current[0].planExpiresAt > new Date() ? current[0].planExpiresAt : new Date();
    const expires = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + body.months, base.getUTCDate()));
    await db.update(entitlements).set({ plan: body.plan, planExpiresAt: expires, status: 'active' }).where(eq(entitlements.userId, id));
    await db.insert(adminAudit).values({ adminId, action: 'plan_granted', targetUserId: id, payloadJson: body });
    return { plan: body.plan, planExpiresAt: expires.toISOString() };
  });

  app.get('/v1/admin/soniox-observability', async () => {
    const rows = await db.select({ kind: usageLedger.kind, source: usageLedger.source, seconds: query<number>`coalesce(sum(${usageLedger.seconds}), 0)::int` }).from(usageLedger).where(eq(usageLedger.status, 'settled')).groupBy(usageLedger.kind, usageLedger.source);
    return { totals: rows, generatedAt: new Date().toISOString() };
  });

  app.post('/v1/admin/realtime-sessions/:id/terminate', async (request, reply) => {
    const adminId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    await closeActiveSession(id, 'admin_terminated');
    await db.update(realtimeSessions).set({ endedAt: new Date(), endReason: 'admin_terminated', status: 'cancelled' }).where(eq(realtimeSessions.id, id));
    await db.insert(adminAudit).values({ adminId, action: 'realtime_session_terminated', payloadJson: { sessionId: id } });
    return reply.code(204).send();
  });
}
