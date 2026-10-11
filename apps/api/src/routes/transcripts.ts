import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { and, asc, desc, eq, gte, inArray, isNull, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { isIanaTimeZone, PLANS, summaryChargeSeconds, type Plan } from '@linguaflow/shared';
import { db } from '../db/index.js';
import { entitlements, noteVersions, realtimeSessions, transcriptFolders, transcriptSegments, transcriptTasks, transcripts } from '../db/schema.js';
import { recordUserDevice } from '../lib/device-store.js';
import { recordEvent } from '../lib/events.js';
import { ensureEntitlement } from '../lib/quota.js';
import { sendTranscriptFile } from '../export/download.js';
import { buildMeetingMarkdown, safeDownloadName, type MeetingDocument } from '../export/meeting.js';
import { signAudioPlayback, verifyAudioPlayback, verifyShareAudio } from '../lib/playback.js';
import { resolveRecording } from '../lib/recordings.js';
import { shareIsActive } from '../lib/shares.js';
import { hardDeleteTranscripts, restoreTranscripts, softDeleteTranscripts } from '../lib/trash.js';
import { renameLiveRoom } from '../realtime/proxy.js';
import { cancelSummary, markSummaryStale, quoteSummary, restoreNoteVersion, saveHumanNote, startSummary, SUMMARY_TEMPLATES, summarySourceHash } from '../summary/jobs.js';
import type { SummaryTemplate } from '../summary/pipeline.js';

const exportQuery = z.object({
  format: z.enum(['txt', 'srt', 'vtt', 'md', 'pdf']).default('txt'),
  scope: z.enum(['summary', 'full']).default('full'),
  tz: z.string().trim().max(64).optional()
});
const titleBody = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  folderId: z.string().uuid().nullable().optional(),
  starred: z.boolean().optional(),
  tags: z.array(z.string().trim().min(1).max(40)).max(12).optional()
});
const summaryBody = z.object({ markdown: z.string().max(200_000) });
const summaryRequest = z.object({
  template: z.enum(['meeting', 'classroom', 'interview', 'briefing']).optional(),
  outputLanguage: z.string().trim().min(1).max(40).default('中文'),
  provider: z.enum(['platform', 'byok']).default('byok'),
  idempotencyKey: z.string().trim().min(8).max(80),
  inputHash: z.string().trim().min(4).max(80),
  inputVersion: z.number().int().min(0),
  quoteSeconds: z.number().int().min(0),
  confirmOverwrite: z.boolean().optional()
});
const listQuery = z.object({
  q: z.string().trim().max(80).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
  audio: z.enum(['ready']).optional(),
  summary: z.enum(['ready']).optional(),
  language: z.string().trim().min(2).max(16).optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  folder: z.string().optional(),
  starred: z.enum(['1']).optional(),
  tag: z.string().trim().max(40).optional()
});
const segmentBody = z.object({
  sourceText: z.string().max(8000),
  translationText: z.string().max(8000),
  speaker: z.string().trim().max(80).nullable().optional()
});
const speakerBody = z.object({ from: z.string().trim().min(1).max(80), to: z.string().trim().min(1).max(80) });

function likePattern(value: string) {
  return `%${value.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

async function ownedTranscript(userId: string, id: string, trash = false) {
  const filters = [eq(transcripts.id, id), eq(transcripts.userId, userId)];
  if (!trash) filters.push(isNull(transcripts.deletedAt));
  const [transcript] = await db.select().from(transcripts).where(and(...filters));
  return transcript;
}

async function meetingDocument(transcript: typeof transcripts.$inferSelect, segments: Array<typeof transcriptSegments.$inferSelect>, timeZone?: string | null): Promise<MeetingDocument> {
  let startedAt = transcript.startedAt;
  let endedAt = transcript.endedAt;
  if ((!startedAt || !endedAt) && transcript.sessionId) {
    const [session] = await db.select({ startedAt: realtimeSessions.startedAt, endedAt: realtimeSessions.endedAt, activeUntil: realtimeSessions.activeUntil }).from(realtimeSessions).where(eq(realtimeSessions.id, transcript.sessionId));
    startedAt = startedAt ?? session?.startedAt ?? null;
    endedAt = endedAt ?? session?.activeUntil ?? null;
    if (!transcript.recordStatus || transcript.recordStatus === 'complete') endedAt = transcript.endedAt ?? session?.endedAt ?? endedAt;
  }
  return {
    title: transcript.title,
    createdAt: transcript.createdAt,
    startedAt,
    endedAt,
    mode: transcript.mode,
    timeZone: timeZone && isIanaTimeZone(timeZone) ? timeZone : null,
    durationMs: transcript.durationMs,
    audioDurationMs: transcript.audioDurationMs,
    languageA: transcript.languageA,
    languageB: transcript.languageB,
    summaryMarkdown: transcript.summaryMarkdown,
    gaps: Array.isArray(transcript.gaps) ? transcript.gaps : [],
    recordStatus: transcript.recordStatus,
    segments: segments.map((segment) => ({ id: segment.id, sourceText: segment.sourceText, translationText: segment.translationText, startMs: segment.startMs, endMs: segment.endMs, speaker: segment.speaker }))
  };
}

export async function transcriptRoutes(app: FastifyInstance) {
  app.get('/v1/transcripts', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    const query = listQuery.parse(request.query);
    const filters = [eq(transcripts.userId, userId), isNull(transcripts.deletedAt)];
    if (query.q) {
      const pattern = likePattern(query.q);
      filters.push(sql`(${transcripts.title} ilike ${pattern} escape '\\' or exists (select 1 from transcript_segments s where s.transcript_id = ${transcripts.id} and (s.source_text ilike ${pattern} escape '\\' or s.translation_text ilike ${pattern} escape '\\')))`);
    }
    if (query.audio === 'ready') filters.push(eq(transcripts.audioStatus, 'ready'));
    if (query.summary === 'ready') filters.push(eq(transcripts.summaryStatus, 'ready'));
    if (query.language) {
      const code = query.language.toLowerCase();
      filters.push(or(eq(transcripts.languageA, code), eq(transcripts.languageB, code))!);
    }
    if (query.from) {
      const from = new Date(query.from);
      if (!Number.isNaN(from.getTime())) filters.push(gte(transcripts.createdAt, from));
    }
    if (query.to) {
      const to = new Date(query.to);
      if (!Number.isNaN(to.getTime())) filters.push(lte(transcripts.createdAt, to));
    }
    if (query.starred === '1') filters.push(eq(transcripts.starred, true));
    if (query.folder === 'none') filters.push(isNull(transcripts.folderId));
    else if (query.folder) filters.push(eq(transcripts.folderId, query.folder));
    if (query.tag) filters.push(sql`${transcripts.tags} @> ARRAY[${query.tag}]::text[]`);
    if (query.cursor) {
      const [createdAt, id] = query.cursor.split('_');
      const cursorDate = new Date(createdAt ?? '');
      if (!Number.isNaN(cursorDate.getTime()) && id) filters.push(sql`(${transcripts.createdAt}, ${transcripts.id}) < (${cursorDate}, ${id}::uuid)`);
    }
    const rows = await db.select().from(transcripts).where(and(...filters)).orderBy(desc(transcripts.createdAt), desc(transcripts.id)).limit(query.limit + 1);
    const page = rows.slice(0, query.limit);
    const last = page.at(-1);
    const nextCursor = rows.length > query.limit && last ? `${last.createdAt.toISOString()}_${last.id}` : null;
    return { items: page.map(({ summaryMarkdown: _summary, ...row }) => row), nextCursor };
  });

  app.get('/v1/transcript-folders', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    return db.select().from(transcriptFolders).where(eq(transcriptFolders.userId, userId)).orderBy(asc(transcriptFolders.name));
  });

  app.post('/v1/transcript-folders', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const body = z.object({ name: z.string().trim().min(1).max(80) }).parse(request.body);
    const [folder] = await db.insert(transcriptFolders).values({ userId, name: body.name }).returning();
    return reply.code(201).send(folder);
  });

  app.delete('/v1/transcript-folders/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const [removed] = await db.delete(transcriptFolders).where(and(eq(transcriptFolders.id, id), eq(transcriptFolders.userId, userId))).returning({ id: transcriptFolders.id });
    if (!removed) return reply.code(404).send({ message: '找不到文件夹。' });
    return reply.code(204).send();
  });

  app.post('/v1/transcripts/batch', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const body = z.object({
      ids: z.array(z.string().uuid()).min(1).max(50),
      action: z.enum(['delete', 'star', 'unstar', 'move', 'export']),
      folderId: z.string().uuid().nullable().optional()
    }).parse(request.body);
    const rows = await db.select().from(transcripts).where(and(eq(transcripts.userId, userId), inArray(transcripts.id, body.ids), isNull(transcripts.deletedAt)));
    if (body.action === 'export') {
      const parts = await Promise.all(rows.map(async (transcript) => {
        const segments = await db.select().from(transcriptSegments).where(eq(transcriptSegments.transcriptId, transcript.id)).orderBy(transcriptSegments.idx);
        return buildMeetingMarkdown(await meetingDocument(transcript, segments));
      }));
      reply.header('content-disposition', safeDownloadName('linguaflow-transcripts', 'md'));
      return reply.type('text/markdown; charset=utf-8').send(parts.join('\n\n---\n\n'));
    }
    if (body.action === 'delete') {
      const deleted = await softDeleteTranscripts(userId, rows.map((transcript) => transcript.id));
      return { deleted };
    }
    if (body.action === 'move') {
      if (body.folderId) {
        const [folder] = await db.select({ id: transcriptFolders.id }).from(transcriptFolders).where(and(eq(transcriptFolders.id, body.folderId), eq(transcriptFolders.userId, userId)));
        if (!folder) return reply.code(404).send({ message: '找不到文件夹。' });
      }
      await db.update(transcripts).set({ folderId: body.folderId ?? null }).where(and(eq(transcripts.userId, userId), inArray(transcripts.id, rows.map((row) => row.id))));
      return { updated: rows.length };
    }
    await db.update(transcripts).set({ starred: body.action === 'star' }).where(and(eq(transcripts.userId, userId), inArray(transcripts.id, rows.map((row) => row.id))));
    return { updated: rows.length };
  });

  app.get('/v1/transcripts/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const transcript = await ownedTranscript(userId, id);
    if (!transcript) return reply.code(404).send({ message: 'Transcript not found' });
    const playable = transcript.audioStatus === 'ready' || transcript.audioStatus === 'encoding';
    const segments = await db.select().from(transcriptSegments).where(eq(transcriptSegments.transcriptId, id)).orderBy(transcriptSegments.idx);
    const entitlement = await ensureEntitlement(userId);
    const charCount = segments.reduce((sum, segment) => sum + segment.sourceText.length + segment.translationText.length, 0);
    const unlimited = PLANS[entitlement.plan as Plan].monthlySeconds === null;
    const hash = summarySourceHash(segments);
    const tasks = await db.select().from(transcriptTasks).where(eq(transcriptTasks.transcriptId, id)).orderBy(transcriptTasks.position);
    await recordEvent({ userId, name: 'record_opened', dedupeKey: `record_opened:${id}:${userId}:${Math.floor(Date.now() / 60_000)}`, props: { transcriptId: id, sessionId: transcript.sessionId } });
    return {
      ...transcript,
      audioPlaybackToken: playable && transcript.audioRelPath ? signAudioPlayback(transcript.id, userId) : null,
      summaryStale: !transcript.summaryCitationsVerified || Boolean(transcript.summarySourceHash && transcript.summarySourceHash !== hash),
      summaryQuoteSeconds: summaryChargeSeconds(charCount, unlimited),
      segments,
      tasks
    };
  });

  app.patch('/v1/transcripts/:id/segments/:segmentId', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id, segmentId } = request.params as { id: string; segmentId: string };
    const body = segmentBody.parse(request.body);
    const transcript = await ownedTranscript(userId, id);
    if (!transcript) return reply.code(404).send({ message: 'Transcript not found' });
    if (transcript.recordStatus === 'active') return reply.code(409).send({ message: '这场记录还在进行，不能修订字幕。' });
    const [segment] = await db.update(transcriptSegments).set({ sourceText: body.sourceText, translationText: body.translationText, speaker: body.speaker ?? null }).where(and(eq(transcriptSegments.id, segmentId), eq(transcriptSegments.transcriptId, id))).returning();
    if (!segment) return reply.code(404).send({ message: '找不到这句字幕。' });
    const segments = await db.select().from(transcriptSegments).where(eq(transcriptSegments.transcriptId, id));
    const refresh = await markSummaryStale(userId, id);
    return { segment, summaryStale: refresh.stale, summaryRefresh: { refreshed: false as const } };
  });

  app.post('/v1/transcripts/:id/speakers', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const body = speakerBody.parse(request.body);
    const transcript = await ownedTranscript(userId, id);
    if (!transcript) return reply.code(404).send({ message: 'Transcript not found' });
    if (transcript.recordStatus === 'active') return reply.code(409).send({ message: '这场记录还在进行，不能修订字幕。' });
    const updated = await db.update(transcriptSegments).set({ speaker: body.to }).where(and(eq(transcriptSegments.transcriptId, id), eq(transcriptSegments.speaker, body.from))).returning({ id: transcriptSegments.id });
    const segments = await db.select().from(transcriptSegments).where(eq(transcriptSegments.transcriptId, id));
    const refresh = await markSummaryStale(userId, id);
    return { updated: updated.length, summaryStale: refresh.stale, summaryRefresh: { refreshed: false as const } };
  });

  app.patch('/v1/transcripts/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const body = titleBody.parse(request.body);
    const patch: { title?: string; folderId?: string | null; starred?: boolean; tags?: string[] } = {};
    if (body.title) patch.title = body.title;
    if (body.folderId !== undefined) patch.folderId = body.folderId;
    if (body.starred !== undefined) patch.starred = body.starred;
    if (body.tags) patch.tags = [...new Set(body.tags)];
    if (!Object.keys(patch).length) return reply.code(400).send({ message: '没有要保存的内容。' });
    const [updated] = await db.update(transcripts).set(patch).where(and(eq(transcripts.id, id), eq(transcripts.userId, userId))).returning();
    if (!updated) return reply.code(404).send({ message: 'Transcript not found' });
    if (body.title && updated.sessionId && updated.recordStatus === 'active') {
      await db.update(realtimeSessions).set({ title: body.title }).where(and(eq(realtimeSessions.id, updated.sessionId), eq(realtimeSessions.userId, userId), isNull(realtimeSessions.endedAt)));
      renameLiveRoom(updated.sessionId, body.title);
    }
    return updated;
  });

  app.patch('/v1/transcripts/:id/tasks/:taskId', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id, taskId } = request.params as { id: string; taskId: string };
    const body = z.object({ done: z.boolean() }).parse(request.body);
    if (!await ownedTranscript(userId, id)) return reply.code(404).send({ message: 'Transcript not found' });
    const [task] = await db.update(transcriptTasks).set({ done: body.done }).where(and(eq(transcriptTasks.id, taskId), eq(transcriptTasks.transcriptId, id))).returning();
    if (!task) return reply.code(404).send({ message: '找不到这条待办。' });
    return task;
  });

  app.patch('/v1/transcripts/:id/summary-checks', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const body = z.object({ checks: z.array(z.string().max(500)).max(200) }).parse(request.body);
    const [updated] = await db.update(transcripts).set({ summaryChecks: body.checks }).where(and(eq(transcripts.id, id), eq(transcripts.userId, userId))).returning({ id: transcripts.id, summaryChecks: transcripts.summaryChecks });
    if (!updated) return reply.code(404).send({ message: 'Transcript not found' });
    return updated;
  });

  app.patch('/v1/transcripts/:id/summary', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const body = summaryBody.parse(request.body);
    const updated = await saveHumanNote(userId, id, body.markdown);
    if (!updated) return reply.code(404).send({ message: 'Transcript not found' });
    return updated;
  });

  app.post('/v1/transcripts/:id/summary', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const body = summaryRequest.parse(request.body ?? {});
    const transcript = await ownedTranscript(userId, id);
    if (!transcript) return reply.code(404).send({ message: 'Transcript not found' });
    const template = (body.template ?? transcript.summaryTemplate ?? (transcript.mode === 'one_way' ? 'classroom' : 'meeting'));
    if (!(SUMMARY_TEMPLATES as readonly string[]).includes(template)) return reply.code(400).send({ message: '不支持这个笔记模板。' });
    const device = await recordUserDevice(userId, request);
    return startSummary(userId, id, template as SummaryTemplate, body.outputLanguage, body.provider, device, body);
  });

  app.post('/v1/transcripts/:id/summary/cancel', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    return cancelSummary(userId, id);
  });

  app.post('/v1/transcripts/:id/summary/quote', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const body = z.object({ template: z.enum(['meeting', 'classroom', 'interview', 'briefing']).optional(), provider: z.enum(['platform', 'byok']).default('byok') }).parse(request.body ?? {});
    const transcript = await ownedTranscript(userId, id);
    if (!transcript) return reply.code(404).send({ message: 'Transcript not found' });
    const template = (body.template ?? transcript.summaryTemplate ?? (transcript.mode === 'one_way' ? 'classroom' : 'meeting')) as SummaryTemplate;
    return quoteSummary(userId, id, template, body.provider);
  });

  app.get('/v1/transcripts/:id/notes', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    if (!await ownedTranscript(userId, id)) return reply.code(404).send({ message: 'Transcript not found' });
    const versions = await db.select({ id: noteVersions.id, authorType: noteVersions.authorType, template: noteVersions.template, inputVersion: noteVersions.inputVersion, provider: noteVersions.provider, createdAt: noteVersions.createdAt }).from(noteVersions).where(and(eq(noteVersions.transcriptId, id), eq(noteVersions.userId, userId))).orderBy(desc(noteVersions.createdAt));
    return { versions };
  });

  app.post('/v1/transcripts/:id/notes/:versionId/restore', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id, versionId } = request.params as { id: string; versionId: string };
    const updated = await restoreNoteVersion(userId, id, versionId);
    if (!updated) return reply.code(404).send({ message: '找不到这个版本。' });
    return updated;
  });

  app.delete('/v1/transcripts/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const permanent = (request.query as { permanent?: string }).permanent === '1';
    const removed = permanent ? await hardDeleteTranscripts(userId, [id]) : await softDeleteTranscripts(userId, [id]);
    if (!removed) return reply.code(404).send({ message: 'Transcript not found' });
    return reply.code(204).send();
  });

  app.get('/v1/transcripts/:id/audio', async (request, reply) => {
    const { id } = request.params as { id: string };
    const query = request.query as { playback?: string; download?: string; share?: string };
    let userId = '';
    if (query.share) {
      const { openShare, sharePasswordMatches } = await import('../lib/shares.js');
      const share = await openShare(query.share);
      if (!share || share.transcriptId !== id || !share.includeAudio) return reply.code(401).send({ message: 'Authentication required' });
      const supplied = typeof request.headers['x-share-password'] === 'string' ? request.headers['x-share-password'] : '';
      if (!await sharePasswordMatches(share, supplied)) return reply.code(401).send({ code: 'share_password_required', message: '需要分享密码。' });
      const [owner] = await db.select({ userId: transcripts.userId }).from(transcripts).where(eq(transcripts.id, id));
      if (!owner) return reply.code(404).send({ message: '找不到录音。' });
      userId = owner.userId;
    } else if (query.playback) {
      const shareId = verifyShareAudio(query.playback, id);
      if (shareId) {
        const { transcriptShares } = await import('../db/schema.js');
        const [share] = await db.select().from(transcriptShares).where(eq(transcriptShares.id, shareId));
        const [owner] = await db.select().from(transcripts).where(eq(transcripts.id, id));
        if (!share || share.transcriptId !== id || !share.includeAudio || share.scope === 'summary' || !shareIsActive(share) || !owner || owner.deletedAt) return reply.code(401).send({ message: 'Authentication required' });
        userId = owner.userId;
      } else {
        const owner = verifyAudioPlayback(query.playback, id);
        if (!owner) return reply.code(401).send({ message: 'Authentication required' });
        userId = owner;
      }
    } else {
      try { await request.jwtVerify(); } catch { return reply.code(401).send({ message: 'Authentication required' }); }
      userId = (request.user as { sub: string }).sub;
    }
    const transcript = await ownedTranscript(userId, id);
    if (!transcript?.audioRelPath || (transcript.audioStatus !== 'ready' && transcript.audioStatus !== 'encoding')) return reply.code(404).send({ message: '找不到录音。' });
    const full = resolveRecording(transcript.audioRelPath);
    if (!full) return reply.code(404).send({ message: '找不到录音。' });
    const info = await stat(full).catch(() => null);
    if (!info) return reply.code(404).send({ message: '录音文件不存在。' });
    const type = transcript.audioFormat === 'wav' ? 'audio/wav' : 'audio/mpeg';
    const disposition = query.download === '1' ? safeDownloadName(transcript.title, transcript.audioFormat === 'wav' ? 'wav' : 'mp3') : 'inline';
    reply.header('accept-ranges', 'bytes');
    reply.header('content-disposition', disposition);
    reply.header('cache-control', 'private, no-store');
    const range = request.headers.range;
    if (range) {
      const match = /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match ? Number(match[1]) : NaN;
      const end = match && match[2] ? Number(match[2]) : info.size - 1;
      if (!match || start > end || start >= info.size) {
        reply.header('content-range', `bytes */${info.size}`);
        return reply.code(416).send();
      }
      reply.header('content-range', `bytes ${start}-${end}/${info.size}`);
      reply.header('content-length', String(end - start + 1));
      return reply.code(206).type(type).send(createReadStream(full, { start, end }));
    }
    reply.header('content-length', info.size);
    return reply.type(type).send(createReadStream(full));
  });

  app.post('/v1/transcripts/:id/playback', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const transcript = await ownedTranscript(userId, id);
    if (!transcript) return reply.code(404).send({ message: 'Transcript not found' });
    await recordEvent({ userId, name: 'audio_playback_started', dedupeKey: `audio_playback:${id}:${userId}`, props: { transcriptId: id, sessionId: transcript.sessionId } });
    return { ok: true };
  });

  app.get('/v1/transcripts/:id/export', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const query = exportQuery.parse(request.query);
    const transcript = await ownedTranscript(userId, id);
    if (!transcript) return reply.code(404).send({ message: 'Transcript not found' });
    const segments = await db.select().from(transcriptSegments).where(eq(transcriptSegments.transcriptId, id)).orderBy(transcriptSegments.idx);
    const zone = query.tz && isIanaTimeZone(query.tz) ? query.tz : null;
    await sendTranscriptFile(reply, await meetingDocument(transcript, segments, zone), query.format, query.scope);
    if (reply.statusCode < 400) await recordEvent({ userId, name: 'export_succeeded', dedupeKey: `export:${id}:${query.format}:${userId}:${Math.floor(Date.now() / 60_000)}`, props: { transcriptId: id, sessionId: transcript.sessionId } });
  });

  app.get('/v1/transcripts/:id/markers', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const transcript = await ownedTranscript(userId, id);
    if (!transcript) return reply.code(404).send({ message: 'Transcript not found' });
    const { sessionMarkers } = await import('../db/schema.js');
    const { isNull: absent } = await import('drizzle-orm');
    return db.select().from(sessionMarkers).where(and(eq(sessionMarkers.userId, userId), eq(sessionMarkers.transcriptId, id), absent(sessionMarkers.deletedAt))).orderBy(sessionMarkers.createdAt);
  });

  app.patch('/v1/transcripts/:id/markers/:markerId', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id, markerId } = request.params as { id: string; markerId: string };
    if (!await ownedTranscript(userId, id)) return reply.code(404).send({ message: 'Transcript not found' });
    const body = z.object({ note: z.string().max(500).nullable().optional(), kind: z.enum(['important', 'unclear', 'assignment']).optional() }).parse(request.body);
    const { sessionMarkers } = await import('../db/schema.js');
    const [updated] = await db.update(sessionMarkers).set({
      ...(body.note !== undefined ? { note: body.note } : {}),
      ...(body.kind ? { kind: body.kind } : {}),
      updatedAt: new Date()
    }).where(and(eq(sessionMarkers.id, markerId), eq(sessionMarkers.userId, userId), eq(sessionMarkers.transcriptId, id))).returning();
    if (!updated) return reply.code(404).send({ message: '找不到这个标记。' });
    return updated;
  });

  app.delete('/v1/transcripts/:id/markers/:markerId', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id, markerId } = request.params as { id: string; markerId: string };
    const { sessionMarkers } = await import('../db/schema.js');
    const [updated] = await db.update(sessionMarkers).set({ deletedAt: new Date() }).where(and(eq(sessionMarkers.id, markerId), eq(sessionMarkers.userId, userId), eq(sessionMarkers.transcriptId, id))).returning({ id: sessionMarkers.id });
    if (!updated) return reply.code(404).send({ message: '找不到这个标记。' });
    return reply.code(204).send();
  });
}
