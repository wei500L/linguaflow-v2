import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../db/index.js';
import { activationCodes, adminAudit, authCodes, entitlements, glossaries, loginAttempts, realtimeSessions, redemptions, summaryProviders, transcriptSegments, transcripts, usageLedger, users } from '../db/schema.js';
import { closeActiveSession } from '../realtime/proxy.js';
import { completeAccountDeletion } from './account-files.js';
import { removeRecording } from './recordings.js';

export { completeAccountDeletion } from './account-files.js';

export async function deleteAccount(userId: string) {
  const [user] = await db.select().from(users).where(eq(users.id, userId));
  if (!user) return false;
  const openSessions = await db.select({ id: realtimeSessions.id }).from(realtimeSessions).where(and(eq(realtimeSessions.userId, userId), isNull(realtimeSessions.endedAt)));
  await Promise.all(openSessions.map((session) => closeActiveSession(session.id, 'account_deleted')));
  await completeAccountDeletion(() => db.transaction(async (tx) => {
    const ownedTranscripts = await tx.select({ id: transcripts.id, audioRelPath: transcripts.audioRelPath }).from(transcripts).where(eq(transcripts.userId, userId));
    const audioPaths = ownedTranscripts.flatMap((transcript) => transcript.audioRelPath ? [transcript.audioRelPath] : []);
    await tx.delete(usageLedger).where(eq(usageLedger.userId, userId));
    for (const transcript of ownedTranscripts) {
      await tx.delete(transcriptSegments).where(eq(transcriptSegments.transcriptId, transcript.id));
      await tx.delete(transcripts).where(eq(transcripts.id, transcript.id));
    }
    await tx.delete(realtimeSessions).where(eq(realtimeSessions.userId, userId));
    await tx.delete(glossaries).where(eq(glossaries.userId, userId));
    await tx.delete(summaryProviders).where(eq(summaryProviders.userId, userId));
    await tx.delete(redemptions).where(eq(redemptions.userId, userId));
    await tx.delete(entitlements).where(eq(entitlements.userId, userId));
    await tx.delete(authCodes).where(eq(authCodes.email, user.email));
    await tx.delete(loginAttempts).where(eq(loginAttempts.email, user.email));
    await tx.update(activationCodes).set({ createdBy: null }).where(eq(activationCodes.createdBy, userId));
    await tx.update(adminAudit).set({ adminId: null }).where(eq(adminAudit.adminId, userId));
    await tx.update(adminAudit).set({ targetUserId: null }).where(eq(adminAudit.targetUserId, userId));
    /* Referral rows stay after the account is gone. The invite identity has to
       keep blocking a second reward, the same way a device claim keeps the free
       quota from resetting. */
    await tx.delete(users).where(eq(users.id, userId));
    return audioPaths;
  }), removeRecording);
  return true;
}
