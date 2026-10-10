import crypto from 'node:crypto';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { transcriptShares } from '../db/schema.js';
export { sharePasswordMatches } from './share-password.js';

export const SHARE_DEFAULT_MS = 30 * 24 * 60 * 60 * 1000;

export function resolveShareExpiry(hours: number | null | undefined, now = Date.now()) {
  if (hours && hours > 0) return new Date(now + hours * 60 * 60 * 1000);
  return new Date(now + SHARE_DEFAULT_MS);
}

export const hashShareToken = (token: string) => crypto.createHash('sha256').update(token).digest('hex');
const hashToken = hashShareToken;

export function shareIsActive(share: { revokedAt: Date | null; expiresAt: Date | null }, now = new Date()) {
  if (share.revokedAt) return false;
  if (share.expiresAt && share.expiresAt.getTime() <= now.getTime()) return false;
  return true;
}

export async function createShare(transcriptId: string, includeAudio: boolean, expiresAt: Date | null, options?: { passwordHash?: string | null; scope?: 'full' | 'summary' }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const scope = options?.scope === 'summary' ? 'summary' : 'full';
  const [share] = await db.insert(transcriptShares).values({
    transcriptId,
    tokenHash: hashToken(token),
    token: null,
    includeAudio: scope === 'summary' ? false : includeAudio,
    expiresAt,
    passwordHash: options?.passwordHash ?? null,
    scope
  }).returning();
  return presentShare(share, token);
}

function presentShare(share: typeof transcriptShares.$inferSelect, token: string | null = null) {
  return { id: share.id, token, includeAudio: share.includeAudio, createdAt: share.createdAt, expiresAt: share.expiresAt, revokedAt: share.revokedAt, hasPassword: Boolean(share.passwordHash), viewCount: share.viewCount, scope: share.scope };
}

export async function listShares(transcriptId: string) {
  const rows = await db.select().from(transcriptShares).where(eq(transcriptShares.transcriptId, transcriptId));
  return rows.map((share) => presentShare(share));
}

export async function revokeShare(transcriptId: string, shareId: string) {
  const [share] = await db.update(transcriptShares).set({ revokedAt: new Date() }).where(and(eq(transcriptShares.id, shareId), eq(transcriptShares.transcriptId, transcriptId), isNull(transcriptShares.revokedAt))).returning({ id: transcriptShares.id });
  return share ?? null;
}

export async function reissueShare(transcriptId: string, shareId: string) {
  const token = crypto.randomBytes(24).toString('base64url');
  const [share] = await db.update(transcriptShares).set({ token: null, tokenHash: hashToken(token), revokedAt: null }).where(and(eq(transcriptShares.id, shareId), eq(transcriptShares.transcriptId, transcriptId))).returning();
  return share ? presentShare(share, token) : null;
}

export async function openShare(token: string) {
  const [share] = await db.select().from(transcriptShares).where(and(eq(transcriptShares.tokenHash, hashToken(token)), isNull(transcriptShares.revokedAt))).limit(1);
  if (!share || !shareIsActive(share)) return null;
  return share;
}

export async function recordShareView(shareId: string) {
  await db.update(transcriptShares).set({ viewCount: sql`${transcriptShares.viewCount} + 1` }).where(eq(transcriptShares.id, shareId));
}
