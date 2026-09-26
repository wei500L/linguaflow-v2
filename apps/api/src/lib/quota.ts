import { PLANS, splitQuotaCharge, summaryChargeSeconds, type Entitlement, type Plan } from '@linguaflow/shared';
import { and, eq, sql as query } from 'drizzle-orm';
import { db } from '../db/index.js';
import { entitlements, realtimeSessions, usageLedger } from '../db/schema.js';

const addMonth = (date: Date) => new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, date.getUTCDate()));

export async function ensureEntitlement(userId: string) {
  const now = new Date();
  await db.insert(entitlements).values({ userId, periodStart: now, periodEnd: addMonth(now) }).onConflictDoNothing();
  return db.transaction(async (tx) => {
    let [row] = await tx.select().from(entitlements).where(eq(entitlements.userId, userId)).for('update');
    if (row.planExpiresAt && row.planExpiresAt <= now && row.plan !== 'free') {
      [row] = await tx.update(entitlements).set({ plan: 'free', status: 'expired', planExpiresAt: null, usedSecondsThisPeriod: 0, periodStart: now, periodEnd: addMonth(now) }).where(eq(entitlements.userId, userId)).returning();
    } else if (row.periodEnd <= now) {
      [row] = await tx.update(entitlements).set({ usedSecondsThisPeriod: 0, periodStart: now, periodEnd: addMonth(now) }).where(eq(entitlements.userId, userId)).returning();
    }
    return row;
  });
}

export function remainingSeconds(row: typeof entitlements.$inferSelect) {
  const monthly = PLANS[row.plan as Plan]?.monthlySeconds;
  return monthly === null ? Number.MAX_SAFE_INTEGER : Math.max(0, (monthly ?? 0) - row.usedSecondsThisPeriod);
}

export function publicEntitlement(row: typeof entitlements.$inferSelect): Entitlement {
  return { plan: row.plan as Plan, planExpiresAt: row.planExpiresAt?.toISOString() ?? null,
    remainingSeconds: remainingSeconds(row), addonSeconds: row.addonSeconds,
    usedSecondsThisPeriod: row.usedSecondsThisPeriod, periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(), status: row.status as Entitlement['status'] };
}

export async function settleUsage(userId: string, sessionId: string, seconds: number, reason: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(entitlements).where(eq(entitlements.userId, userId)).for('update');
    if (!row) throw new Error('Missing entitlement');
    const [session] = await tx.select().from(realtimeSessions).where(eq(realtimeSessions.id, sessionId)).for('update');
    if (!session || session.userId !== userId) throw new Error('Missing session');
    if (session.endedAt) return { billedSeconds: session.billedSeconds ?? 0, settled: false };
    const allowed = Math.min(Math.max(0, Math.ceil(seconds)), session.reservedSeconds, session.maxSessionSeconds);
    const planSeconds = Math.min(allowed, remainingSeconds(row));
    const addonSeconds = Math.min(Math.max(0, allowed - planSeconds), row.addonSeconds);
    const billedSeconds = planSeconds + addonSeconds;
    await tx.update(entitlements).set({
      usedSecondsThisPeriod: query`${entitlements.usedSecondsThisPeriod} + ${planSeconds}`,
      addonSeconds: query`${entitlements.addonSeconds} - ${addonSeconds}`
    }).where(eq(entitlements.userId, userId));
    if (planSeconds) await tx.insert(usageLedger).values({ userId, sessionId, seconds: planSeconds, source: 'plan' });
    if (addonSeconds) await tx.insert(usageLedger).values({ userId, sessionId, seconds: addonSeconds, source: 'addon' });
    await tx.update(realtimeSessions).set({ endedAt: new Date(), billedSeconds, endReason: reason, status: reason === 'cancelled' ? 'cancelled' : 'finished' }).where(eq(realtimeSessions.id, sessionId));
    return { billedSeconds, settled: true };
  });
}

export function platformSummarySeconds(charCount: number, plan: Plan) {
  return summaryChargeSeconds(charCount, PLANS[plan].monthlySeconds === null);
}

export async function reserveSummaryUsage(userId: string, transcriptId: string, charCount: number) {
  const row = await ensureEntitlement(userId);
  const requested = platformSummarySeconds(charCount, row.plan as Plan);
  if (requested <= 0) return { seconds: 0 };
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(entitlements).where(eq(entitlements.userId, userId)).for('update');
    const split = splitQuotaCharge(requested, remainingSeconds(locked), locked.addonSeconds);
    if (!split.covered) throw Object.assign(new Error('平台纪要额度不足。'), { statusCode: 402, code: 'quota_exhausted' });
    await tx.update(entitlements).set({
      usedSecondsThisPeriod: query`${entitlements.usedSecondsThisPeriod} + ${split.planSeconds}`,
      addonSeconds: query`${entitlements.addonSeconds} - ${split.addonSeconds}`
    }).where(eq(entitlements.userId, userId));
    if (split.planSeconds) await tx.insert(usageLedger).values({ userId, transcriptId, seconds: split.planSeconds, source: 'plan', kind: 'summary', status: 'held' });
    if (split.addonSeconds) await tx.insert(usageLedger).values({ userId, transcriptId, seconds: split.addonSeconds, source: 'addon', kind: 'summary', status: 'held' });
    return { seconds: requested };
  });
}

export async function confirmSummaryUsage(userId: string, transcriptId: string) {
  await db.update(usageLedger).set({ status: 'settled' }).where(and(eq(usageLedger.userId, userId), eq(usageLedger.transcriptId, transcriptId), eq(usageLedger.kind, 'summary'), eq(usageLedger.status, 'held')));
}

export async function refundSummaryUsage(userId: string, transcriptId: string) {
  await db.transaction(async (tx) => {
    const rows = await tx.delete(usageLedger).where(and(eq(usageLedger.userId, userId), eq(usageLedger.transcriptId, transcriptId), eq(usageLedger.kind, 'summary'), eq(usageLedger.status, 'held'))).returning();
    const planSeconds = rows.filter((item) => item.source === 'plan').reduce((sum, item) => sum + item.seconds, 0);
    const addonSeconds = rows.filter((item) => item.source === 'addon').reduce((sum, item) => sum + item.seconds, 0);
    if (!planSeconds && !addonSeconds) return;
    await tx.update(entitlements).set({
      usedSecondsThisPeriod: query`GREATEST(0, ${entitlements.usedSecondsThisPeriod} - ${planSeconds})`,
      addonSeconds: query`${entitlements.addonSeconds} + ${addonSeconds}`
    }).where(eq(entitlements.userId, userId));
  });
}
