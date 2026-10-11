import type { FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { deviceClaims, userDevices, users } from '../db/schema.js';
import { ensureEntitlement } from './quota.js';
import {
  isStrongCanvas,
  claimKeys,
  clientAddress,
  clientUserAgent,
  deviceKey,
  deviceRequiredMessage,
  fingerprintHash,
  fingerprintKey,
  freeDeviceBlockedMessage,
  freeDomainBlockedMessage,
  freeDeviceDecision,
  parseDeviceHeader,
  serverClaimKeys,
  type DeviceRef
} from './device.js';

export function deviceDenied(code: 'free_device_blocked' | 'device_required', reason?: 'device' | 'domain') {
  const message = code === 'device_required' ? deviceRequiredMessage : reason === 'domain' ? freeDomainBlockedMessage : freeDeviceBlockedMessage;
  return Object.assign(new Error(message), { statusCode: 403, code, reason });
}

export async function recordUserDevice(userId: string, request: FastifyRequest): Promise<DeviceRef | null> {
  const signals = parseDeviceHeader(request.headers['x-linguaflow-device']);
  if (!signals) return null;
  const hash = fingerprintHash(signals);
  const now = new Date();
  await db.insert(userDevices).values({
    userId,
    fingerprintHash: hash,
    deviceId: signals.deviceId,
    lastIp: clientAddress(request.headers, request.socket?.remoteAddress || request.ip),
    userAgent: clientUserAgent(request.headers),
    firstSeenAt: now,
    lastSeenAt: now
  }).onConflictDoUpdate({
    target: [userDevices.userId, userDevices.fingerprintHash, userDevices.deviceId],
    set: { lastIp: clientAddress(request.headers, request.socket?.remoteAddress || request.ip), userAgent: clientUserAgent(request.headers), lastSeenAt: now }
  });
  return { fingerprintHash: hash, deviceId: signals.deviceId, strong: isStrongCanvas(signals.canvas) };
}

export async function latestUserDevice(userId: string): Promise<DeviceRef | null> {
  const [row] = await db.select({ fingerprintHash: userDevices.fingerprintHash, deviceId: userDevices.deviceId }).from(userDevices).where(eq(userDevices.userId, userId)).orderBy(desc(userDevices.lastSeenAt)).limit(1);
  return row ?? null;
}

export async function assertFreeTranslation(userId: string, device: DeviceRef | null) {
  const entitlement = await ensureEntitlement(userId);
  const [account] = await db.select({ signupIp: users.signupIp, email: users.email }).from(users).where(eq(users.id, userId));
  const keys = [
    ...(device ? claimKeys(device.fingerprintHash, device.deviceId, device.strong !== false) : []),
    ...serverClaimKeys({ signupIp: account?.signupIp, email: account?.email })
  ];
  const claims = keys.length
    ? await db.select({ userId: deviceClaims.claimedBy, releasedAt: deviceClaims.releasedAt, key: deviceClaims.key, claimedAt: deviceClaims.claimedAt }).from(deviceClaims).where(inArray(deviceClaims.key, keys))
    : [];
  const decision = freeDeviceDecision({ plan: entitlement.plan, userId, hasDevice: Boolean(device), claims });
  if (!decision.ok) throw deviceDenied(decision.code, 'reason' in decision ? decision.reason : undefined);
  return entitlement;
}

/* One browser can mint a second fingerprint when the screen or timezone changes.
   Follow the stable device id so release and block cover that whole browser. */
export async function keysForFingerprint(hash: string) {
  const fingerprints = new Set<string>([hash]);
  const deviceIds = new Set<string>();
  let pending = [hash];
  while (pending.length) {
    const rows = await db.select({ fingerprintHash: userDevices.fingerprintHash, deviceId: userDevices.deviceId }).from(userDevices).where(inArray(userDevices.fingerprintHash, pending));
    pending = [];
    const freshIds = rows.map((row) => row.deviceId).filter((id) => !deviceIds.has(id));
    for (const id of freshIds) deviceIds.add(id);
    if (!freshIds.length) continue;
    const siblings = await db.select({ fingerprintHash: userDevices.fingerprintHash }).from(userDevices).where(inArray(userDevices.deviceId, freshIds));
    for (const row of siblings) {
      if (fingerprints.has(row.fingerprintHash)) continue;
      fingerprints.add(row.fingerprintHash);
      pending.push(row.fingerprintHash);
    }
  }
  return [...[...fingerprints].map(fingerprintKey), ...[...deviceIds].map(deviceKey)];
}

export async function releaseFingerprint(hash: string) {
  const keys = await keysForFingerprint(hash);
  await db.update(deviceClaims).set({ releasedAt: new Date() }).where(and(inArray(deviceClaims.key, keys), isNull(deviceClaims.releasedAt)));
}

export async function blockFingerprint(hash: string, claimedBy: string) {
  const keys = await keysForFingerprint(hash);
  const now = new Date();
  await db.insert(deviceClaims).values(keys.map((key) => ({ key, claimedBy, claimedAt: now, releasedAt: null }))).onConflictDoUpdate({
    target: deviceClaims.key,
    set: { claimedBy, releasedAt: null }
  });
}
