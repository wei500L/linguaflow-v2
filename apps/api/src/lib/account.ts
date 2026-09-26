import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { activationCodes, adminAudit, authCodes, entitlements, glossaries, loginAttempts, realtimeSessions, redemptions, summaryProviders, transcriptSegments, transcripts, usageLedger, users } from '../db/schema.js';
import { closeActiveSession } from '../realtime/proxy.js';
import { removeRecording } from './recordings.js';

export async function deleteAccount(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return false;
  const openSessions = await db.select({ id: realtimeSessions.id }).from(realtimeSessions).where(and(eq(realtimeSessions.userId, userId), isNull(realtimeSessions.endedAt)));
  await Promise.all(openSessions.map((session) => closeActiveSession(session.id, 'account_deleted')));
  const ownedTranscripts = await db.select({ id: transcripts.id, audioRelPath: transcripts.audioRelPath }).from(transcripts).where(eq(transcripts.userId, userId));
  await db.delete(usageLedger).where(eq(usageLedger.userId, userId));
  for (const transcript of ownedTranscripts) {
    await db.delete(transcriptSegments).where(eq(transcriptSegments.transcriptId, transcript.id));
    await db.delete(transcripts).where(eq(transcripts.id, transcript.id));
    if (transcript.audioRelPath) await removeRecording(transcript.audioRelPath);
  }
  await db.delete(realtimeSessions).where(eq(realtimeSessions.userId, userId));
  await db.delete(glossaries).where(eq(glossaries.userId, userId));
  await db.delete(summaryProviders).where(eq(summaryProviders.userId, userId));
  await db.delete(redemptions).where(eq(redemptions.userId, userId));
  await db.delete(entitlements).where(eq(entitlements.userId, userId));
  await db.delete(authCodes).where(eq(authCodes.email, user.email));
  await db.delete(loginAttempts).where(eq(loginAttempts.email, user.email));
  await db.update(activationCodes).set({ createdBy: null }).where(eq(activationCodes.createdBy, userId));
  await db.update(adminAudit).set({ adminId: null }).where(eq(adminAudit.adminId, userId));
  await db.update(adminAudit).set({ targetUserId: null }).where(eq(adminAudit.targetUserId, userId));
  await db.delete(users).where(eq(users.id, userId));
  return true;
}
