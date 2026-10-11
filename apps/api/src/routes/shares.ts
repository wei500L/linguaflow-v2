import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import argon2 from 'argon2';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { transcriptSegments, transcriptTasks, transcripts } from '../db/schema.js';
import { sendTranscriptFile } from '../export/download.js';
import { signShareAudio } from '../lib/playback.js';
import { createShare, listShares, openShare, recordShareView, reissueShare, resolveShareExpiry, revokeShare, sharePasswordMatches } from '../lib/shares.js';

async function owned(userId: string, id: string) {
  const [transcript] = await db.select({ id: transcripts.id }).from(transcripts).where(and(eq(transcripts.id, id), eq(transcripts.userId, userId)));
  return transcript;
}

function shareAudioUrl(share: { id: string; includeAudio: boolean; passwordHash: string | null; scope: string }, transcript: { id: string; userId: string; audioRelPath: string | null; audioStatus: string | null }, _token: string) {
  if (share.scope === 'summary' || !share.includeAudio || !transcript.audioRelPath) return null;
  if (transcript.audioStatus !== 'ready' && transcript.audioStatus !== 'encoding') return null;
  return `/v1/transcripts/${transcript.id}/audio?playback=${encodeURIComponent(signShareAudio(share.id, transcript.id))}`;
}

async function readShare(request: FastifyRequest, reply: FastifyReply) {
  const { token } = request.params as { token: string };
  const share = await openShare(token);
  if (!share) return null;
  const supplied = typeof request.headers['x-share-password'] === 'string' ? request.headers['x-share-password'] : '';
  if (!await sharePasswordMatches(share, supplied)) {
    reply.code(401).send({ code: 'share_password_required', message: '需要分享密码。' });
    return null;
  }
  return share;
}

export async function shareRoutes(app: FastifyInstance) {
  app.get('/v1/shares/:token', async (request, reply) => {
    const share = await readShare(request, reply);
    if (!share) return reply.sent ? reply : reply.code(404).send({ message: '分享链接已失效。' });
    const [transcript] = await db.select().from(transcripts).where(eq(transcripts.id, share.transcriptId));
    if (!transcript || transcript.deletedAt) return reply.code(404).send({ message: '分享链接已失效。' });
    await recordShareView(share.id);
    const summaryOnly = share.scope === 'summary';
    const segments = summaryOnly ? [] : await db.select({
      id: transcriptSegments.id,
      speaker: transcriptSegments.speaker,
      language: transcriptSegments.language,
      sourceText: transcriptSegments.sourceText,
      translationText: transcriptSegments.translationText,
      startMs: transcriptSegments.startMs,
      endMs: transcriptSegments.endMs
    }).from(transcriptSegments).where(eq(transcriptSegments.transcriptId, transcript.id)).orderBy(transcriptSegments.idx);
    const tasks = await db.select({ id: transcriptTasks.id, text: transcriptTasks.text, done: transcriptTasks.done }).from(transcriptTasks).where(eq(transcriptTasks.transcriptId, transcript.id)).orderBy(transcriptTasks.position);
    return {
      id: transcript.id,
      title: transcript.title,
      mode: transcript.mode,
      languageA: transcript.languageA,
      languageB: transcript.languageB,
      createdAt: transcript.createdAt,
      durationMs: transcript.durationMs,
      expiresAt: share.expiresAt,
      summaryMarkdown: transcript.summaryMarkdown,
      scope: share.scope,
      viewCount: share.viewCount + 1,
      includeAudio: share.includeAudio && !summaryOnly,
      audioUrl: shareAudioUrl(share, transcript, (request.params as { token: string }).token),
      segments,
      tasks
    };
  });

  app.get('/v1/shares/:token/export', async (request, reply) => {
    const share = await readShare(request, reply);
    if (!share) return reply.sent ? reply : reply.code(404).send({ message: '分享链接已失效。' });
    const query = z.object({ format: z.enum(['txt', 'srt', 'vtt', 'md', 'pdf']).default('txt'), scope: z.enum(['summary', 'full']).default('full') }).parse(request.query);
    const [transcript] = await db.select().from(transcripts).where(eq(transcripts.id, share.transcriptId));
    if (!transcript || transcript.deletedAt) return reply.code(404).send({ message: '分享链接已失效。' });
    const summaryOnly = share.scope === 'summary' || query.scope === 'summary';
    if (share.scope === 'summary' && (query.format === 'srt' || query.format === 'vtt')) return reply.code(409).send({ message: '这份分享只有纪要。' });
    const segments = summaryOnly ? [] : await db.select().from(transcriptSegments).where(eq(transcriptSegments.transcriptId, transcript.id)).orderBy(transcriptSegments.idx);
    return sendTranscriptFile(reply, {
      title: transcript.title,
      createdAt: transcript.createdAt,
      durationMs: transcript.durationMs,
      languageA: transcript.languageA,
      languageB: transcript.languageB,
      summaryMarkdown: transcript.summaryMarkdown,
      segments
    }, query.format, summaryOnly ? 'summary' : query.scope);
  });

  app.get('/v1/transcripts/:id/shares', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    if (!await owned(userId, id)) return reply.code(404).send({ message: 'Transcript not found' });
    return listShares(id);
  });

  app.post('/v1/transcripts/:id/shares', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    if (!await owned(userId, id)) return reply.code(404).send({ message: 'Transcript not found' });
    const body = z.object({
      includeAudio: z.boolean().default(false),
      expiresInHours: z.number().int().min(1).max(24 * 30).nullable().optional(),
      password: z.string().max(80).optional(),
      scope: z.enum(['full', 'summary']).default('full')
    }).parse(request.body ?? {});
    const expiresAt = resolveShareExpiry(body.expiresInHours);
    const passwordHash = body.password?.trim() ? await argon2.hash(body.password.trim()) : null;
    const share = await createShare(id, body.includeAudio, expiresAt, { passwordHash, scope: body.scope });
    return reply.code(201).send(share);
  });

  app.post('/v1/transcripts/:id/shares/:shareId/reissue', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id, shareId } = request.params as { id: string; shareId: string };
    if (!await owned(userId, id)) return reply.code(404).send({ message: 'Transcript not found' });
    const share = await reissueShare(id, shareId);
    if (!share) return reply.code(404).send({ message: '找不到分享链接。' });
    return share;
  });

  app.delete('/v1/transcripts/:id/shares/:shareId', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id, shareId } = request.params as { id: string; shareId: string };
    if (!await owned(userId, id)) return reply.code(404).send({ message: 'Transcript not found' });
    if (!await revokeShare(id, shareId)) return reply.code(404).send({ message: '找不到分享链接。' });
    return reply.code(204).send();
  });
}
