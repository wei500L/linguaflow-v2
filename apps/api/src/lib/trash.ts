import { and, eq, inArray, isNotNull, isNull, lte } from 'drizzle-orm';
import { TRASH_RETAIN_MS } from '@linguaflow/shared';
import { db } from '../db/index.js';
import { realtimeSessions, sessionMarkers, sessionTokenChunks, transcriptShares, transcripts } from '../db/schema.js';
import { closeActiveSession, dropAudience } from '../realtime/proxy.js';
import { finalizePersistedSession } from '../realtime/persist.js';
import { refundSummaryUsage } from './quota.js';
import { removeRecording } from './recordings.js';

async function endLiveSession(sessionId: string) {
  const closed = await closeActiveSession(sessionId, 'cancelled');
  if (!closed) await finalizePersistedSession(sessionId, 'cancelled', { interrupted: true });
}

export async function softDeleteTranscripts(userId: string, ids: string[]) {
  if (!ids.length) return 0;
  const rows = await db.select().from(transcripts).where(and(eq(transcripts.userId, userId), inArray(transcripts.id, ids), isNull(transcripts.deletedAt)));
  const now = new Date();
  for (const row of rows) {
    if (row.sessionId) {
      const [live] = await db.select({ id: realtimeSessions.id }).from(realtimeSessions).where(and(eq(realtimeSessions.id, row.sessionId), eq(realtimeSessions.userId, userId), isNull(realtimeSessions.endedAt)));
      if (live) await endLiveSession(live.id);
      dropAudience(row.sessionId);
    }
    if (row.summaryStatus === 'running') await refundSummaryUsage(userId, row.id);
    await db.update(transcriptShares).set({ revokedAt: now }).where(and(eq(transcriptShares.transcriptId, row.id), isNull(transcriptShares.revokedAt)));
    await db.update(transcripts).set({ deletedAt: now, purgeAfter: new Date(now.getTime() + TRASH_RETAIN_MS), summaryStatus: row.summaryStatus === 'running' ? 'failed' : row.summaryStatus }).where(and(eq(transcripts.id, row.id), eq(transcripts.userId, userId), isNull(transcripts.deletedAt)));
  }
  return rows.length;
}

export async function restoreTranscripts(userId: string, ids: string[]) {
  if (!ids.length) return 0;
  const restored = await db.update(transcripts).set({ deletedAt: null, purgeAfter: null }).where(and(eq(transcripts.userId, userId), inArray(transcripts.id, ids), isNotNull(transcripts.deletedAt))).returning({ id: transcripts.id });
  return restored.length;
}

export async function hardDeleteTranscripts(userId: string, ids: string[]) {
  if (!ids.length) return 0;
  const rows = await db.select().from(transcripts).where(and(eq(transcripts.userId, userId), inArray(transcripts.id, ids)));
  for (const row of rows) {
    if (row.summaryStatus === 'running' || row.summaryStatus === 'cancelling') await refundSummaryUsage(userId, row.id);
    if (row.sessionId) {
      const [live] = await db.select({ id: realtimeSessions.id }).from(realtimeSessions).where(and(eq(realtimeSessions.id, row.sessionId), isNull(realtimeSessions.endedAt)));
      if (live) await endLiveSession(live.id);
      await db.transaction(async (tx) => {
        await tx.update(realtimeSessions).set({
          endedAt: new Date(),
          endReason: 'purged',
          segmentSnapshot: [],
          speakerNames: {},
          gaps: [],
          title: null,
          recordingRelPath: null
        }).where(eq(realtimeSessions.id, row.sessionId!));
        await tx.delete(sessionTokenChunks).where(eq(sessionTokenChunks.sessionId, row.sessionId!));
        await tx.delete(sessionMarkers).where(eq(sessionMarkers.sessionId, row.sessionId!));
      });
    }
    await db.delete(transcripts).where(and(eq(transcripts.id, row.id), eq(transcripts.userId, userId)));
    if (row.audioRelPath) await removeRecording(row.audioRelPath);
    if (row.audioRelPath?.endsWith('.mp3')) await removeRecording(row.audioRelPath.replace(/\.mp3$/i, '.wav'));
  }
  return rows.length;
}

export async function purgeExpiredTrash(now = new Date()) {
  const due = await db.select({ id: transcripts.id, userId: transcripts.userId }).from(transcripts).where(and(isNotNull(transcripts.deletedAt), lte(transcripts.purgeAfter, now)));
  const byUser = new Map<string, string[]>();
  for (const row of due) {
    const list = byUser.get(row.userId) ?? [];
    list.push(row.id);
    byUser.set(row.userId, list);
  }
  for (const [userId, ids] of byUser) await hardDeleteTranscripts(userId, ids);
  return due.length;
}
