import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { realtimeSessions, transcriptShares } from '../db/schema.js';
import { hashShareToken, openShare } from './shares.js';

export type AudienceRow = {
  audienceToken: string | null;
  audienceTokenHash: string | null;
  audienceIncludeAudio: boolean;
  audienceRevokedAt: Date | null;
  audienceExpiresAt: Date | null;
};

export function audienceIsOpen(row: AudienceRow, now = new Date()) {
  if (!row.audienceToken || !row.audienceTokenHash) return false;
  if (row.audienceRevokedAt) return false;
  if (row.audienceExpiresAt && row.audienceExpiresAt.getTime() <= now.getTime()) return false;
  return true;
}

export function newAudienceToken() {
  const token = crypto.randomBytes(24).toString('base64url');
  return { token, tokenHash: hashShareToken(token) };
}

export async function findAudienceSession(token: string) {
  const [session] = await db.select().from(realtimeSessions).where(eq(realtimeSessions.audienceTokenHash, hashShareToken(token))).limit(1);
  if (!session || !audienceIsOpen(session)) return null;
  return session;
}

export async function ensureAudienceShare(session: AudienceRow, transcriptId: string) {
  if (!audienceIsOpen(session) || !session.audienceToken || !session.audienceTokenHash) return null;
  const existing = await openShare(session.audienceToken);
  if (existing) return existing;
  await db.insert(transcriptShares).values({
    transcriptId,
    tokenHash: session.audienceTokenHash,
    token: session.audienceToken,
    includeAudio: session.audienceIncludeAudio,
    expiresAt: session.audienceExpiresAt
  }).onConflictDoNothing({ target: transcriptShares.tokenHash });
  return openShare(session.audienceToken);
}

export async function revokeAudienceShare(tokenHash: string) {
  await db.update(transcriptShares).set({ revokedAt: new Date() }).where(eq(transcriptShares.tokenHash, tokenHash));
}
