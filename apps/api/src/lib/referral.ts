import { and, desc, eq, gt, gte, inArray, isNull, lt, sql as query } from 'drizzle-orm';
import { REFERRAL, normalizeInviteCode } from '@linguaflow/shared';
import { db } from '../db/index.js';
import { entitlements, realtimeSessions, referrals, userDevices, users } from '../db/schema.js';
import { config } from '../config.js';
import { deviceKey, fingerprintKey, type DeviceRef } from './device.js';
import { keysForFingerprint } from './device-store.js';
import { canonicalEmail, referralIdentity } from './email.js';
import { ensureEntitlement } from './quota.js';
import {
  emailDomain,
  evaluateReferral,
  isCustomReferralDomain,
  isDisposableDomain,
  makeInviteCode,
  referralReward,
  type ReferralDecision
} from './referral-risk.js';

const dayMs = 24 * 60 * 60 * 1000;

function isUniqueViolation(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  if ((error as { code?: string }).code === '23505') return true;
  return isUniqueViolation((error as { cause?: unknown }).cause);
}

function countOf(row?: { count: number | string | null }) {
  return Number(row?.count ?? 0);
}

export function maskEmail(email: string) {
  const at = email.lastIndexOf('@');
  if (at <= 0) return '***';
  return `${email.slice(0, 1)}***${email.slice(at)}`;
}

export function inviteLink(code: string) {
  return `${config.webOrigin.replace(/\/$/, '')}/?invite=${code}`;
}

export async function expirePendingReferrals() {
  await db.update(referrals).set({ status: 'expired', reason: 'expired' }).where(and(inArray(referrals.status, ['pending', 'held', 'grant_due']), lt(referrals.expiresAt, new Date())));
}

export async function ensureInviteCode(userId: string) {
  const [existing] = await db.select({ inviteCode: users.inviteCode }).from(users).where(eq(users.id, userId));
  if (!existing) throw Object.assign(new Error('Account not found'), { statusCode: 404 });
  if (existing.inviteCode) return existing.inviteCode;
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = makeInviteCode();
    try {
      const [updated] = await db.update(users).set({ inviteCode: code }).where(and(eq(users.id, userId), isNull(users.inviteCode))).returning({ inviteCode: users.inviteCode });
      if (updated?.inviteCode) return updated.inviteCode;
      const [again] = await db.select({ inviteCode: users.inviteCode }).from(users).where(eq(users.id, userId));
      if (again?.inviteCode) return again.inviteCode;
    } catch (error) {
      if (!isUniqueViolation(error)) throw error;
    }
  }
  throw new Error('Could not assign invite code');
}

async function sharesDeviceGraph(userId: string, device: DeviceRef | null) {
  if (!device) return false;
  const owned = await db.select({ fingerprintHash: userDevices.fingerprintHash, deviceId: userDevices.deviceId }).from(userDevices).where(eq(userDevices.userId, userId));
  if (!owned.length) return false;
  if (owned.some((row) => row.fingerprintHash === device.fingerprintHash || row.deviceId === device.deviceId)) return true;
  const walked = new Set(await keysForFingerprint(device.fingerprintHash));
  walked.add(deviceKey(device.deviceId));
  return owned.some((row) => walked.has(fingerprintKey(row.fingerprintHash)) || walked.has(deviceKey(row.deviceId)));
}

async function inviterCounts(inviterId: string, domain: string, customDomain: boolean, signupIp: string | null) {
  const now = Date.now();
  const sinceDay = new Date(now - REFERRAL.velocityWindowHours * 60 * 60 * 1000);
  const sinceIp = new Date(now - REFERRAL.sameIpWindowDays * dayMs);
  const [pending, recent, domainRow, ipRow] = await Promise.all([
    db.select({ count: query<number>`count(*)::int` }).from(referrals).where(and(eq(referrals.inviterId, inviterId), inArray(referrals.status, ['pending', 'held']))),
    db.select({ count: query<number>`count(*)::int` }).from(referrals).where(and(eq(referrals.inviterId, inviterId), gt(referrals.createdAt, sinceDay))),
    customDomain
      ? db.select({ count: query<number>`count(*)::int` }).from(referrals).where(and(eq(referrals.inviterId, inviterId), gt(referrals.createdAt, sinceDay), query`split_part(${referrals.inviteeEmailIdentity}, '@', 2) = ${domain}`))
      : Promise.resolve([{ count: 0 }]),
    signupIp
      ? db.select({ count: query<number>`count(*)::int` }).from(referrals).where(and(eq(referrals.inviterId, inviterId), eq(referrals.signupIp, signupIp), gt(referrals.createdAt, sinceIp)))
      : Promise.resolve([{ count: 0 }])
  ]);
  return {
    pendingCount: countOf(pending[0]),
    recentCount: countOf(recent[0]),
    sameDomainRecentCount: countOf(domainRow[0]),
    sameIpRecentCount: countOf(ipRow[0])
  };
}

export async function bindReferral(input: {
  inviteeId: string;
  inviteeEmail: string;
  inviteCode?: string;
  device: DeviceRef | null;
  signupIp: string | null;
}): Promise<{ applied: boolean; status: string | null }> {
  const code = input.inviteCode ? normalizeInviteCode(input.inviteCode) : null;
  if (!code) return { applied: false, status: null };
  const [inviter] = await db.select({ id: users.id, email: users.email }).from(users).where(eq(users.inviteCode, code));
  if (!inviter) return { applied: false, status: null };
  await expirePendingReferrals();
  const identity = referralIdentity(input.inviteeEmail);
  const domain = emailDomain(identity);
  const [used, latestDevice, counts, deviceOverlap] = await Promise.all([
    db.select({ id: referrals.id }).from(referrals).where(eq(referrals.inviteeEmailIdentity, identity)).limit(1),
    db.select({ lastIp: userDevices.lastIp }).from(userDevices).where(eq(userDevices.userId, inviter.id)).orderBy(desc(userDevices.lastSeenAt)).limit(1),
    inviterCounts(inviter.id, domain, isCustomReferralDomain(domain), input.signupIp),
    sharesDeviceGraph(inviter.id, input.device)
  ]);
  const inviterIp = latestDevice[0]?.lastIp ?? null;
  const decision: ReferralDecision = evaluateReferral({
    inviterFound: true,
    self: inviter.id === input.inviteeId || canonicalEmail(inviter.email) === canonicalEmail(input.inviteeEmail) || referralIdentity(inviter.email) === identity,
    deviceOverlap,
    disposableEmail: isDisposableDomain(domain),
    identityUsed: Boolean(used[0]),
    customDomain: isCustomReferralDomain(domain),
    sameIp: Boolean(input.signupIp && inviterIp && input.signupIp === inviterIp),
    weakDevice: input.device?.strong === false,
    ...counts
  });
  const status = decision.decision === 'allow' ? 'pending' : decision.decision === 'hold' ? 'held' : 'rejected';
  try {
    await db.insert(referrals).values({
      inviterId: inviter.id,
      inviteeId: input.inviteeId,
      inviteeEmailIdentity: identity,
      status,
      reason: decision.reason,
      signupIp: input.signupIp,
      fingerprintHash: input.device?.fingerprintHash ?? null,
      deviceId: input.device?.deviceId ?? null,
      weakDevice: input.device?.strong === false,
      expiresAt: new Date(Date.now() + REFERRAL.qualifyDays * dayMs)
    });
  } catch (error) {
    if (isUniqueViolation(error)) return { applied: true, status: 'rejected' };
    throw error;
  }
  return { applied: true, status };
}

export async function qualifyReferral(userId: string, sessionId: string) {
  await expirePendingReferrals();
  const [existing] = await db.select({ id: referrals.id, inviterId: referrals.inviterId }).from(referrals).where(and(eq(referrals.inviteeId, userId), inArray(referrals.status, ['pending', 'grant_due'])));
  if (!existing) return;
  await ensureEntitlement(userId);
  const [inviter] = await db.select({ id: users.id }).from(users).where(eq(users.id, existing.inviterId));
  if (inviter) await ensureEntitlement(inviter.id);
  const [sessionDevice] = await db.select({ fingerprintHash: realtimeSessions.fingerprintHash, deviceId: realtimeSessions.deviceId }).from(realtimeSessions).where(eq(realtimeSessions.id, sessionId));
  const sessionDeviceRef = sessionDevice?.fingerprintHash && sessionDevice.deviceId ? { fingerprintHash: sessionDevice.fingerprintHash, deviceId: sessionDevice.deviceId } : null;
  const overlapped = await sharesDeviceGraph(existing.inviterId, sessionDeviceRef);
  await db.transaction(async (tx) => {
    const [row] = await tx.select().from(referrals).where(eq(referrals.id, existing.id)).for('update');
    if (!row || (row.status !== 'pending' && row.status !== 'grant_due')) return;
    if (row.expiresAt <= new Date()) {
      await tx.update(referrals).set({ status: 'expired', reason: 'expired' }).where(and(eq(referrals.id, row.id), eq(referrals.status, row.status)));
      return;
    }
    const [session] = await tx.select({
      billedSeconds: realtimeSessions.billedSeconds,
      status: realtimeSessions.status
    }).from(realtimeSessions).where(eq(realtimeSessions.id, sessionId));
    if (!session || session.status !== 'finished' || (session.billedSeconds ?? 0) < REFERRAL.qualifySeconds) return;
    if (overlapped) {
      await tx.update(referrals).set({ status: 'rejected', reason: 'device_overlap' }).where(and(eq(referrals.id, row.id), eq(referrals.status, row.status)));
      return;
    }
    if (inviter) await tx.select({ userId: entitlements.userId }).from(entitlements).where(eq(entitlements.userId, row.inviterId)).for('update');
    const since = new Date(Date.now() - REFERRAL.monthlyWindowDays * dayMs);
    const paid = and(eq(referrals.inviterId, row.inviterId), gt(referrals.inviterGrantedSeconds, 0));
    const [month] = await tx.select({ count: query<number>`count(*)::int` }).from(referrals).where(and(paid, gt(referrals.grantedAt, since)));
    const [lifetime] = await tx.select({ count: query<number>`count(*)::int` }).from(referrals).where(paid);
    const [inviterEntitlement] = await tx.select({ userId: entitlements.userId }).from(entitlements).where(eq(entitlements.userId, row.inviterId));
    const reward = referralReward(countOf(month), countOf(lifetime));
    const inviterSeconds = inviterEntitlement ? reward.inviterSeconds : 0;
    const [claimed] = await tx.update(referrals).set({
      status: 'qualified',
      reason: inviterEntitlement ? reward.reason : reward.reason ?? 'inviter_missing',
      qualifiedSessionId: sessionId,
      inviteeGrantedSeconds: reward.inviteeSeconds,
      inviterGrantedSeconds: inviterSeconds,
      grantedAt: new Date()
    }).where(and(eq(referrals.id, row.id), eq(referrals.status, row.status))).returning({ id: referrals.id });
    if (!claimed) return;
    await tx.update(entitlements).set({ addonSeconds: query`${entitlements.addonSeconds} + ${reward.inviteeSeconds}` }).where(eq(entitlements.userId, userId));
    if (inviterSeconds) await tx.update(entitlements).set({ addonSeconds: query`${entitlements.addonSeconds} + ${inviterSeconds}` }).where(eq(entitlements.userId, row.inviterId));
  });
}

export async function replayDueReferrals() {
  await expirePendingReferrals();
  const due = await db.select({ inviteeId: referrals.inviteeId, qualifiedSessionId: referrals.qualifiedSessionId }).from(referrals).where(eq(referrals.status, 'grant_due'));
  for (const row of due) {
    if (!row.inviteeId || !row.qualifiedSessionId) continue;
    try {
      await qualifyReferral(row.inviteeId, row.qualifiedSessionId);
    } catch (error) {
      console.error('[LinguaFlow] referral grant failed', error);
    }
  }
}

export async function presentReferral(userId: string) {
  await expirePendingReferrals();
  const code = await ensureInviteCode(userId);
  const since = new Date(Date.now() - REFERRAL.monthlyWindowDays * dayMs);
  const [pending, month, lifetime, incoming, items] = await Promise.all([
    db.select({ count: query<number>`count(*)::int` }).from(referrals).where(and(eq(referrals.inviterId, userId), inArray(referrals.status, ['pending', 'held']))),
    db.select({ count: query<number>`count(*)::int` }).from(referrals).where(and(eq(referrals.inviterId, userId), gt(referrals.inviterGrantedSeconds, 0), gt(referrals.grantedAt, since))),
    db.select({ count: query<number>`count(*)::int` }).from(referrals).where(and(eq(referrals.inviterId, userId), gt(referrals.inviterGrantedSeconds, 0))),
    db.select({ status: referrals.status, expiresAt: referrals.expiresAt }).from(referrals).where(and(eq(referrals.inviteeId, userId), inArray(referrals.status, ['pending', 'held', 'grant_due']))).limit(1),
    db.select({
      id: referrals.id,
      status: referrals.status,
      email: referrals.inviteeEmailIdentity,
      createdAt: referrals.createdAt,
      expiresAt: referrals.expiresAt,
      inviterGrantedSeconds: referrals.inviterGrantedSeconds,
      inviteeGrantedSeconds: referrals.inviteeGrantedSeconds
    }).from(referrals).where(and(eq(referrals.inviterId, userId), inArray(referrals.status, ['pending', 'held', 'grant_due', 'qualified', 'expired']))).orderBy(desc(referrals.createdAt)).limit(20)
  ]);
  const current = incoming[0];
  return {
    code,
    link: inviteLink(code),
    limits: {
      pending: countOf(pending[0]),
      pendingCap: REFERRAL.pendingCap,
      qualifiedThisMonth: countOf(month[0]),
      monthlyCap: REFERRAL.monthlyQualifiedCap,
      qualifiedLifetime: countOf(lifetime[0]),
      lifetimeCap: REFERRAL.lifetimeQualifiedCap
    },
    reward: {
      inviteeMinutes: REFERRAL.inviteeSeconds / 60,
      inviterMinutes: REFERRAL.inviterSeconds / 60,
      qualifyMinutes: REFERRAL.qualifySeconds / 60
    },
    incoming: current ? { status: current.status, expiresAt: current.expiresAt.toISOString() } : null,
    items: items.map((item) => ({ ...item, email: maskEmail(item.email), createdAt: item.createdAt.toISOString(), expiresAt: item.expiresAt.toISOString() }))
  };
}

export async function listAdminReferrals(status?: string) {
  await expirePendingReferrals();
  const where = status ? eq(referrals.status, status) : undefined;
  const rows = await db.select({
    id: referrals.id,
    status: referrals.status,
    reason: referrals.reason,
    inviteeEmailIdentity: referrals.inviteeEmailIdentity,
    signupIp: referrals.signupIp,
    weakDevice: referrals.weakDevice,
    createdAt: referrals.createdAt,
    expiresAt: referrals.expiresAt,
    grantedAt: referrals.grantedAt,
    inviteeGrantedSeconds: referrals.inviteeGrantedSeconds,
    inviterGrantedSeconds: referrals.inviterGrantedSeconds,
    inviterEmail: users.email
  }).from(referrals).leftJoin(users, eq(referrals.inviterId, users.id)).where(where).orderBy(desc(referrals.createdAt)).limit(50);
  return rows.map((row) => ({
    ...row,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    grantedAt: row.grantedAt?.toISOString() ?? null
  }));
}

export async function approveReferral(referralId: string) {
  await expirePendingReferrals();
  const [row] = await db.select().from(referrals).where(eq(referrals.id, referralId));
  if (!row) return { error: 'missing' as const };
  if (row.status === 'expired') return { status: 'expired' as const };
  if (row.status !== 'held') return { error: 'not_held' as const };
  if (row.expiresAt <= new Date()) {
    await db.update(referrals).set({ status: 'expired', reason: 'expired' }).where(and(eq(referrals.id, row.id), eq(referrals.status, 'held')));
    return { status: 'expired' as const };
  }
  const [updated] = await db.update(referrals).set({ status: 'pending', reason: null }).where(and(eq(referrals.id, row.id), eq(referrals.status, 'held'))).returning();
  if (!updated?.inviteeId) return { status: 'pending' as const };
  const [session] = await db.select({ id: realtimeSessions.id }).from(realtimeSessions).where(and(
    eq(realtimeSessions.userId, updated.inviteeId),
    eq(realtimeSessions.status, 'finished'),
    gte(realtimeSessions.billedSeconds, REFERRAL.qualifySeconds)
  )).orderBy(desc(realtimeSessions.billedSeconds)).limit(1);
  if (session) await qualifyReferral(updated.inviteeId, session.id);
  const [after] = await db.select({ status: referrals.status }).from(referrals).where(eq(referrals.id, referralId));
  return { status: after?.status ?? 'pending' };
}

export async function rejectReferral(referralId: string) {
  return db.transaction(async (tx) => {
    const [row] = await tx.select().from(referrals).where(eq(referrals.id, referralId)).for('update');
    if (!row) return { error: 'missing' as const };
    if (row.status === 'rejected') return { status: 'rejected' as const };
    if (row.status === 'qualified') {
      if (row.inviteeId && row.inviteeGrantedSeconds > 0) {
        await tx.update(entitlements).set({ addonSeconds: query`GREATEST(0, ${entitlements.addonSeconds} - ${row.inviteeGrantedSeconds})` }).where(eq(entitlements.userId, row.inviteeId));
      }
      if (row.inviterGrantedSeconds > 0) {
        await tx.update(entitlements).set({ addonSeconds: query`GREATEST(0, ${entitlements.addonSeconds} - ${row.inviterGrantedSeconds})` }).where(eq(entitlements.userId, row.inviterId));
      }
    }
    await tx.update(referrals).set({ status: 'rejected', reason: 'admin_rejected' }).where(eq(referrals.id, row.id));
    return { status: 'rejected' as const };
  });
}
