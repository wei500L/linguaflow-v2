import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gte, inArray, isNull, lt, or, sql as query } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { activationCodes, adminAudit, deviceClaims, entitlements, productEvents, realtimeSessions, usageLedger, userDevices, users } from '../db/schema.js';
import { claimKeys, fingerprintKey } from '../lib/device.js';
import { blockFingerprint, releaseFingerprint } from '../lib/device-store.js';
import { approveReferral, listAdminReferrals, rejectReferral } from '../lib/referral.js';
import { closeActiveSession } from '../realtime/proxy.js';
import { finalizePersistedSession } from '../realtime/persist.js';
import { summarizeProductMetrics } from '@linguaflow/shared';
import { adminSupportRoutes } from './support.js';

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
    const rows = await db.select({
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
    if (!rows.length) return [];
    const devices = await db.select({ userId: userDevices.userId, fingerprintHash: userDevices.fingerprintHash, deviceId: userDevices.deviceId }).from(userDevices).where(inArray(userDevices.userId, rows.map((row) => row.id)));
    const keys = [...new Set(devices.flatMap((device) => claimKeys(device.fingerprintHash, device.deviceId)))];
    const active = keys.length ? await db.select({ key: deviceClaims.key, claimedBy: deviceClaims.claimedBy }).from(deviceClaims).where(and(inArray(deviceClaims.key, keys), isNull(deviceClaims.releasedAt))) : [];
    const owners = new Map(active.map((claim) => [claim.key, claim.claimedBy]));
    return rows.map((row) => ({
      ...row,
      freeBlocked: devices.some((device) => device.userId === row.id && claimKeys(device.fingerprintHash, device.deviceId).some((key) => {
        const owner = owners.get(key);
        return Boolean(owner && owner !== row.id);
      }))
    }));
  });

  app.get('/v1/admin/free-devices', async (request) => {
    const { q } = request.query as { q?: string };
    const term = q?.trim();
    let hashes: string[] | undefined;
    if (term) {
      const like = `%${term}%`;
      const linked = await db.select({ hash: userDevices.fingerprintHash }).from(userDevices).leftJoin(users, eq(userDevices.userId, users.id)).where(or(query`${users.email} ILIKE ${like}`, query`${userDevices.lastIp} ILIKE ${like}`, query`${userDevices.userAgent} ILIKE ${like}`)).limit(100);
      const owned = await db.select({ key: deviceClaims.key }).from(deviceClaims).leftJoin(users, eq(deviceClaims.claimedBy, users.id)).where(and(query`${deviceClaims.key} LIKE 'fp:%'`, query`${users.email} ILIKE ${like}`)).limit(100);
      hashes = [...new Set([...linked.map((row) => row.hash), ...owned.map((row) => row.key.slice(3))])];
      if (!hashes.length) return [];
    }
    const claims = await db.select({
      key: deviceClaims.key,
      claimedBy: deviceClaims.claimedBy,
      claimedAt: deviceClaims.claimedAt,
      releasedAt: deviceClaims.releasedAt,
      ownerEmail: users.email
    }).from(deviceClaims).leftJoin(users, eq(deviceClaims.claimedBy, users.id)).where(hashes ? and(query`${deviceClaims.key} LIKE 'fp:%'`, inArray(deviceClaims.key, hashes.map((hash) => fingerprintKey(hash)))) : query`${deviceClaims.key} LIKE 'fp:%'`).orderBy(desc(deviceClaims.claimedAt)).limit(50);
    if (!claims.length) return [];
    const links = await db.select({
      fingerprintHash: userDevices.fingerprintHash,
      userId: users.id,
      email: users.email,
      plan: entitlements.plan,
      usedSecondsThisPeriod: entitlements.usedSecondsThisPeriod,
      lastIp: userDevices.lastIp,
      userAgent: userDevices.userAgent,
      lastSeenAt: userDevices.lastSeenAt
    }).from(userDevices).leftJoin(users, eq(userDevices.userId, users.id)).leftJoin(entitlements, eq(users.id, entitlements.userId)).where(inArray(userDevices.fingerprintHash, claims.map((claim) => claim.key.slice(3))));
    return claims.map((claim) => {
      const fingerprintHash = claim.key.slice(3);
      const accounts = new Map<string, { userId: string; email: string; plan: string | null; usedSecondsThisPeriod: number | null }>();
      let lastIp: string | null = null;
      let userAgent: string | null = null;
      let seenAt = 0;
      for (const link of links) {
        if (link.fingerprintHash !== fingerprintHash) continue;
        const at = link.lastSeenAt?.getTime() ?? 0;
        if (at >= seenAt) { seenAt = at; lastIp = link.lastIp; userAgent = link.userAgent; }
        if (!link.userId || !link.email || accounts.has(link.userId)) continue;
        accounts.set(link.userId, { userId: link.userId, email: link.email, plan: link.plan, usedSecondsThisPeriod: link.usedSecondsThisPeriod });
      }
      return { fingerprintHash, ownerUserId: claim.claimedBy, ownerEmail: claim.ownerEmail, claimedAt: claim.claimedAt.toISOString(), releasedAt: claim.releasedAt?.toISOString() ?? null, lastIp, userAgent, accounts: [...accounts.values()] };
    });
  });

  app.post('/v1/admin/free-devices/:hash/release', async (request, reply) => {
    const adminId = (request.user as { sub: string }).sub;
    const hash = (request.params as { hash: string }).hash;
    if (!/^[a-f0-9]{64}$/.test(hash)) return reply.code(400).send({ message: 'Invalid fingerprint' });
    const [claim] = await db.select().from(deviceClaims).where(eq(deviceClaims.key, fingerprintKey(hash)));
    if (!claim) return reply.code(404).send({ message: '找不到这个设备指纹。' });
    const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.id, claim.claimedBy));
    await releaseFingerprint(hash);
    await db.insert(adminAudit).values({ adminId, action: 'free_device_released', targetUserId: owner?.id, payloadJson: { fingerprintHash: hash } });
    return { released: true };
  });

  app.post('/v1/admin/free-devices/:hash/block', async (request, reply) => {
    const adminId = (request.user as { sub: string }).sub;
    const hash = (request.params as { hash: string }).hash;
    if (!/^[a-f0-9]{64}$/.test(hash)) return reply.code(400).send({ message: 'Invalid fingerprint' });
    const [claim] = await db.select().from(deviceClaims).where(eq(deviceClaims.key, fingerprintKey(hash)));
    if (!claim) return reply.code(404).send({ message: '找不到这个设备指纹。' });
    const [owner] = await db.select({ id: users.id }).from(users).where(eq(users.id, claim.claimedBy));
    await blockFingerprint(hash, claim.claimedBy);
    await db.insert(adminAudit).values({ adminId, action: 'free_device_blocked', targetUserId: owner?.id, payloadJson: { fingerprintHash: hash } });
    return { blocked: true };
  });

  app.get('/v1/admin/referrals', async (request) => {
    const { status } = request.query as { status?: string };
    if (status && !['pending', 'held', 'grant_due', 'qualified', 'rejected', 'expired'].includes(status)) return [];
    return listAdminReferrals(status || undefined);
  });

  app.post('/v1/admin/referrals/:id/approve', async (request, reply) => {
    const adminId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.code(400).send({ message: 'Invalid referral' });
    const result = await approveReferral(id);
    if (result.error === 'missing') return reply.code(404).send({ message: '找不到这条邀请。' });
    if (result.error === 'not_held') return reply.code(409).send({ message: '这条邀请不在暂扣中。' });
    await db.insert(adminAudit).values({ adminId, action: 'referral_approved', payloadJson: { referralId: id, status: result.status } });
    return result;
  });

  app.post('/v1/admin/referrals/:id/reject', async (request, reply) => {
    const adminId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    if (!z.string().uuid().safeParse(id).success) return reply.code(400).send({ message: 'Invalid referral' });
    const result = await rejectReferral(id);
    if (result.error === 'missing') return reply.code(404).send({ message: '找不到这条邀请。' });
    await db.insert(adminAudit).values({ adminId, action: 'referral_rejected', payloadJson: { referralId: id } });
    return result;
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
    const closed = await closeActiveSession(id, 'admin_terminated');
    if (!closed) await finalizePersistedSession(id, 'admin_terminated', { interrupted: true });
    await db.insert(adminAudit).values({ adminId, action: 'realtime_session_terminated', payloadJson: { sessionId: id } });
    return reply.code(204).send();
  });

  app.get('/v1/admin/metrics', async (request) => {
    const queryParams = z.object({ from: z.string().optional(), to: z.string().optional() }).parse(request.query);
    const to = queryParams.to ? new Date(queryParams.to) : new Date();
    const from = queryParams.from ? new Date(queryParams.from) : new Date(to.getTime() - 7 * 24 * 60 * 60 * 1000);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime())) return { empty: true, counts: {}, rates: {}, latency: { samples: 0, sessions: 0, recognitionP50: null, recognitionP95: null, translationP50: null, translationP95: null } };
    const rows = await db.select().from(productEvents).where(and(gte(productEvents.createdAt, from), lt(productEvents.createdAt, to))).limit(5000);
    return summarizeProductMetrics(rows.map((row) => ({ name: row.name, createdAtMs: row.createdAt.getTime(), userId: row.userId, props: row.props ?? {} })), from.getTime(), to.getTime(), { truncated: rows.length >= 5000 });
  });

  await adminSupportRoutes(app);
}
