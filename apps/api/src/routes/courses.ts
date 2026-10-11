import type { FastifyInstance } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { SUMMARY_TEMPLATE_IDS } from '@linguaflow/shared';
import { db } from '../db/index.js';
import { courses, glossaries, transcripts } from '../db/schema.js';

const courseBody = z.object({
  name: z.string().trim().min(1).max(80),
  languageA: z.string().trim().min(2).max(16),
  languageB: z.string().trim().min(2).max(16),
  mode: z.enum(['one_way', 'two_way']).default('one_way'),
  glossaryId: z.string().uuid().nullable().optional(),
  recordAudio: z.boolean().optional(),
  summaryTemplate: z.enum(SUMMARY_TEMPLATE_IDS).optional(),
  titlePattern: z.string().trim().max(120).nullable().optional()
});

export async function courseRoutes(app: FastifyInstance) {
  app.get('/v1/courses', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    return db.select().from(courses).where(eq(courses.userId, userId)).orderBy(asc(courses.name));
  });

  app.post('/v1/courses', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const body = courseBody.parse(request.body);
    if (body.glossaryId) {
      const [glossary] = await db.select({ id: glossaries.id }).from(glossaries).where(and(eq(glossaries.id, body.glossaryId), eq(glossaries.userId, userId)));
      if (!glossary) return reply.code(404).send({ message: '找不到术语库。' });
    }
    const [created] = await db.insert(courses).values({
      userId,
      name: body.name,
      languageA: body.languageA,
      languageB: body.languageB,
      mode: body.mode,
      glossaryId: body.glossaryId ?? null,
      recordAudio: body.recordAudio ?? true,
      summaryTemplate: body.summaryTemplate ?? (body.mode === 'one_way' ? 'classroom' : 'meeting'),
      titlePattern: body.titlePattern ?? null
    }).returning();
    return reply.code(201).send(created);
  });

  app.patch('/v1/courses/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const body = courseBody.partial().parse(request.body);
    const [updated] = await db.update(courses).set({ ...body, glossaryId: body.glossaryId === undefined ? undefined : body.glossaryId, updatedAt: new Date() }).where(and(eq(courses.id, id), eq(courses.userId, userId))).returning();
    if (!updated) return reply.code(404).send({ message: '找不到这门课。' });
    return updated;
  });

  app.delete('/v1/courses/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    await db.update(transcripts).set({ courseId: null }).where(and(eq(transcripts.courseId, id), eq(transcripts.userId, userId)));
    const [removed] = await db.delete(courses).where(and(eq(courses.id, id), eq(courses.userId, userId))).returning({ id: courses.id });
    if (!removed) return reply.code(404).send({ message: '找不到这门课。' });
    return reply.code(204).send();
  });

  app.get('/v1/transcripts/trash', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    const { desc, isNotNull } = await import('drizzle-orm');
    return db.select().from(transcripts).where(and(eq(transcripts.userId, userId), isNotNull(transcripts.deletedAt))).orderBy(desc(transcripts.deletedAt));
  });

  app.post('/v1/transcripts/:id/restore', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const { restoreTranscripts } = await import('../lib/trash.js');
    const restored = await restoreTranscripts(userId, [id]);
    if (!restored) return reply.code(404).send({ message: '回收站里没有这条记录。' });
    return { restored };
  });

  app.get('/v1/transcripts/search', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    const query = z.object({ q: z.string().trim().min(1).max(80), limit: z.coerce.number().int().min(1).max(20).default(20) }).parse(request.query);
    const pattern = `%${query.q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    const { sql } = await import('drizzle-orm');
    const hits = await db.execute(sql`
      select s.id as "segmentId", s.transcript_id as "transcriptId", t.title, s.source_text as "sourceText", s.translation_text as "translationText", s.start_ms as "startMs", s.idx,
        lag(s.source_text) over (partition by s.transcript_id order by s.idx) as "before",
        lead(s.source_text) over (partition by s.transcript_id order by s.idx) as "after"
      from transcript_segments s
      join transcripts t on t.id = s.transcript_id
      where t.user_id = ${userId}::uuid and t.deleted_at is null and t.record_status <> 'active'
        and (s.source_text ilike ${pattern} escape '\\' or s.translation_text ilike ${pattern} escape '\\')
      order by t.created_at desc
      limit ${query.limit}
    `);
    return { hits: hits };
  });
}
