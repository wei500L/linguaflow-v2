import crypto from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { and, desc, eq, gt, isNull, lt, or, sql as query } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { activationCodes, entitlements, redemptions } from '../db/schema.js';
import { ensureEntitlement } from '../lib/quota.js';

const hashCode = (code: string) => crypto.createHash('sha256').update(code.trim().toUpperCase()).digest('hex');

export async function billingRoutes(app: FastifyInstance) {
  app.post('/v1/billing/redeem', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { code } = z.object({ code: z.string().min(8) }).parse(request.body);
    const [activation] = await db.select().from(activationCodes).where(eq(activationCodes.codeHash, hashCode(code)));
    if (!activation || activation.disabled || activation.redemptionCount >= activation.maxRedemptions || (activation.expiresAt && activation.expiresAt < new Date())) return reply.code(400).send({ message: 'Invalid or expired activation code' });
    const current = await ensureEntitlement(userId);
    const now = new Date();
    const base = current.planExpiresAt && current.planExpiresAt > now ? current.planExpiresAt : now;
    const expires = activation.months ? new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + activation.months, base.getUTCDate())) : current.planExpiresAt;
    await db.transaction(async (tx) => {
      const [claimed] = await tx.update(activationCodes).set({ redemptionCount: query`${activationCodes.redemptionCount} + 1` }).where(and(eq(activationCodes.id, activation.id), eq(activationCodes.disabled, false), lt(activationCodes.redemptionCount, activationCodes.maxRedemptions), or(isNull(activationCodes.expiresAt), gt(activationCodes.expiresAt, new Date())))).returning();
      if (!claimed) throw Object.assign(new Error('Invalid or expired activation code'), { statusCode: 400 });
      await tx.insert(redemptions).values({ codeId: activation.id, userId, grantedPlan: activation.plan, grantedMonths: activation.months, grantedAddonSeconds: activation.addonSeconds });
      await tx.update(entitlements).set({ plan: activation.plan ?? current.plan, planExpiresAt: expires, addonSeconds: query`${entitlements.addonSeconds} + ${activation.addonSeconds}`, status: 'active' }).where(eq(entitlements.userId, userId));
    });
    return { entitlement: await ensureEntitlement(userId) };
  });

  app.get('/v1/billing/redemptions', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    const items = await db.select({
      id: redemptions.id,
      redeemedAt: redemptions.redeemedAt,
      grantedPlan: redemptions.grantedPlan,
      grantedMonths: redemptions.grantedMonths,
      grantedAddonSeconds: redemptions.grantedAddonSeconds
    }).from(redemptions).where(eq(redemptions.userId, userId)).orderBy(desc(redemptions.redeemedAt)).limit(20);
    return { items };
  });
}
