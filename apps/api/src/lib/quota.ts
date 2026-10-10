import { PLANS, REFERRAL, splitQuotaCharge, summaryChargeSeconds, type Entitlement, type Plan } from '@linguaflow/shared';
import { and, eq, inArray, sql as query } from 'drizzle-orm';
import { db } from '../db/index.js';
import { deviceClaims, entitlements, realtimeSessions, referrals, usageLedger, users } from '../db/schema.js';
import { claimBlocks, claimKeys, freeDeviceBlockedMessage, serverClaimKeys, type DeviceRef } from './device.js';

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

type ClaimExecutor = Pick<typeof db, 'insert' | 'select' | 'update'>;

/* Insert first so two free accounts serialize on the same key. A released row
   can be taken. An active row owned by someone else rejects this transaction,
   which rolls the insert back. Settling a session must not grab the key again:
   an admin release would otherwise be undone when the old session ends. */
export async function holdFreeDevice(tx: ClaimExecutor, userId: string, fingerprintHash: string | null, deviceId: string | null, strong = true) {
  const [account] = await tx.select({ signupIp: users.signupIp, email: users.email }).from(users).where(eq(users.id, userId));
  const keys = [
    ...(fingerprintHash && deviceId ? claimKeys(fingerprintHash, deviceId, strong) : []),
    ...serverClaimKeys({ signupIp: account?.signupIp, email: account?.email })
  ];
  if (!keys.length) return;
  const now = new Date();
  await tx.insert(deviceClaims).values(keys.map((key) => ({ key, claimedBy: userId, claimedAt: now, releasedAt: null }))).onConflictDoNothing({ target: deviceClaims.key });
  const rows = await tx.select().from(deviceClaims).where(inArray(deviceClaims.key, keys)).for('update');
  if (rows.some((row) => claimBlocks({ userId: row.claimedBy, releasedAt: row.releasedAt, key: row.key, claimedAt: row.claimedAt }, userId, now))) {
    throw Object.assign(new Error(freeDeviceBlockedMessage), { statusCode: 403, code: 'free_device_blocked' });
  }
  const take = rows.filter((row) => row.releasedAt || (row.key.startsWith('ip:') && row.claimedBy !== userId)).map((row) => row.key);
  if (take.length) await tx.update(deviceClaims).set({ claimedBy: userId, claimedAt: now, releasedAt: null }).where(inArray(deviceClaims.key, take));
}

export function publicEntitlement(row: typeof entitlements.$inferSelect): Entitlement {
  return { plan: row.plan as Plan, planExpiresAt: row.planExpiresAt?.toISOString() ?? null,
    remainingSeconds: remainingSeconds(row), addonSeconds: row.addonSeconds,
    usedSecondsThisPeriod: row.usedSecondsThisPeriod, periodStart: row.periodStart.toISOString(),
    periodEnd: row.periodEnd.toISOString(), status: row.status as Entitlement['status'] };
}

export async function settleUsage(userId: string, sessionId: string, seconds: number, reason: string) {
  const result = await db.transaction(async (tx) => {
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
    if (reason !== 'cancelled' && billedSeconds >= REFERRAL.qualifySeconds) {
      await tx.update(referrals).set({ status: 'grant_due', qualifiedSessionId: sessionId }).where(and(eq(referrals.inviteeId, userId), eq(referrals.status, 'pending')));
    }
    return { billedSeconds, settled: true };
  });
  /* referral.ts reads devices through device-store, which imports this module.
     A static import would cycle, and a failed grant must not undo the settlement. */
  if (result.settled && reason !== 'cancelled' && result.billedSeconds >= REFERRAL.qualifySeconds) {
    try {
      const { qualifyReferral } = await import('./referral.js');
      await qualifyReferral(userId, sessionId);
    } catch (error) {
      console.error('[LinguaFlow] referral grant failed', error);
    }
  }
  return result;
}

export function platformSummarySeconds(charCount: number, plan: Plan) {
  return summaryChargeSeconds(charCount, PLANS[plan].monthlySeconds === null);
}

export async function reserveSummaryUsage(userId: string, transcriptId: string, charCount: number, device?: DeviceRef | null) {
  const row = await ensureEntitlement(userId);
  const requested = platformSummarySeconds(charCount, row.plan as Plan);
  if (requested <= 0) return { seconds: 0 };
  return db.transaction(async (tx) => {
    const [locked] = await tx.select().from(entitlements).where(eq(entitlements.userId, userId)).for('update');
    const split = splitQuotaCharge(requested, remainingSeconds(locked), locked.addonSeconds);
    if (!split.covered) throw Object.assign(new Error('平台纪要额度不足。'), { statusCode: 402, code: 'quota_exhausted' });
    if (locked.plan === 'free' && split.planSeconds > 0) await holdFreeDevice(tx, userId, device?.fingerprintHash ?? null, device?.deviceId ?? null, device?.strong !== false);
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
