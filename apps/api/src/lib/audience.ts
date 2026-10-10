import crypto from 'node:crypto';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { realtimeSessions, transcriptShares } from '../db/schema.js';
import { hashShareToken } from './shares.js';

export type AudienceRow = {
  audienceToken: string | null;
  audienceTokenHash: string | null;
  audienceIncludeAudio: boolean;
  audienceRevokedAt: Date | null;
  audienceExpiresAt: Date | null;
};

export type AudienceRoom = 'live' | 'saving' | null;

/* A room that is still finishing must not look ended. The transcript row and
   the share link are written after the session is marked ended, and reporting
   "ended, nothing saved" in that gap makes the audience page drop captions. */
export function audienceViewPhase(input: { ended: boolean; room: AudienceRoom }): 'live' | 'waiting' | 'saving' | 'ended' {
  if (input.room === 'live' && !input.ended) return 'live';
  if (input.room) return 'saving';
  if (!input.ended) return 'waiting';
  return 'ended';
}

export function audienceIsOpen(row: AudienceRow, now = new Date()) {
  if (!row.audienceTokenHash) return false;
  if (row.audienceRevokedAt) return false;
  if (row.audienceExpiresAt && row.audienceExpiresAt.getTime() <= now.getTime()) return false;
  return true;
}

/* The host can show the same QR after a refresh. The plaintext token stays on
   the session and is only returned to that host. Listeners still join by hash. */
export function audienceReveal(row: AudienceRow) {
  if (!audienceIsOpen(row)) return null;
  return { token: row.audienceToken, includeAudio: row.audienceIncludeAudio, expiresAt: row.audienceExpiresAt };
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
  if (!audienceIsOpen(session) || !session.audienceTokenHash) return null;
  const [existing] = await db.select().from(transcriptShares).where(eq(transcriptShares.tokenHash, session.audienceTokenHash)).limit(1);
  if (existing) return existing;
  await db.insert(transcriptShares).values({
    transcriptId,
    tokenHash: session.audienceTokenHash,
    token: null,
    includeAudio: session.audienceIncludeAudio,
    expiresAt: session.audienceExpiresAt
  }).onConflictDoNothing({ target: transcriptShares.tokenHash });
  const [created] = await db.select().from(transcriptShares).where(eq(transcriptShares.tokenHash, session.audienceTokenHash)).limit(1);
  return created ?? null;
}

export async function revokeAudienceShare(tokenHash: string) {
  await db.update(transcriptShares).set({ revokedAt: new Date() }).where(eq(transcriptShares.tokenHash, tokenHash));
}
