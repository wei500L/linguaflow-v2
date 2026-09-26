import type { FastifyInstance } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../db/index.js';
import { glossaries, glossaryTerms, summaryProviders, transcriptSegments, transcripts, usageLedger, users } from '../db/schema.js';
import { changePassword, findUser, sendCode, verifyCode } from '../auth/service.js';
import { deleteAccount } from '../lib/account.js';
import { config } from '../config.js';
import { ensureEntitlement, publicEntitlement } from '../lib/quota.js';
import { decryptSecret, encryptSecret, keyHint } from '../lib/secrets.js';
import { assertSummaryEndpoint, endpointAllowsMissingKey } from '../lib/ssrf.js';
import { findGlossaryPreset, GLOSSARY_PRESET_KEYS, GLOSSARY_PRESETS } from '../lib/glossary-presets.js';
import { classifyGlossaryImport, GLOSSARY_TERM_LIMIT } from '../lib/glossary-import.js';
import { glossaryInjection, languageCode, type SonioxSessionInput } from '../realtime/soniox.js';
import { LANGUAGE_OPTIONS } from '@linguaflow/shared';

const glossaryBody = z.object({
  name: z.string().trim().min(1).max(80),
  languageA: z.string().trim().min(2).max(16),
  languageB: z.string().trim().min(2).max(16),
  presetKey: z.string().trim().max(80).optional(),
  terms: z.array(z.object({ source: z.string().trim().min(1).max(200), target: z.string().trim().min(1).max(200) })).max(1000).optional()
});

function assertLanguagePair(languageA: string, languageB: string) {
  if (languageCode(languageA) && languageCode(languageA) === languageCode(languageB)) {
    throw Object.assign(new Error('源语言和目标语言不能相同。'), { statusCode: 400 });
  }
}
const termBody = z.object({ source: z.string().trim().min(1).max(200), target: z.string().trim().min(1).max(200), pinned: z.boolean().optional() });

function uniqueTerms(terms: Array<{ source: string; target: string }>) {
  const unique = new Map<string, { source: string; target: string }>();
  for (const term of terms) unique.set(term.source, term);
  return [...unique.values()];
}

async function ownedGlossary(userId: string, id: string) {
  const [glossary] = await db.select().from(glossaries).where(and(eq(glossaries.id, id), eq(glossaries.userId, userId)));
  if (!glossary) throw Object.assign(new Error('找不到术语库。'), { statusCode: 404 });
  return glossary;
}

async function assertUniqueSource(glossaryId: string, source: string, exceptId?: string) {
  const rows = await db.select({ id: glossaryTerms.id, source: glossaryTerms.source }).from(glossaryTerms).where(eq(glossaryTerms.glossaryId, glossaryId));
  if (rows.some((row) => row.source === source && row.id !== exceptId)) throw Object.assign(new Error('这条原文已经在词库里。'), { statusCode: 409 });
}

const providerBody = z.object({
  apiBase: z.string().trim().min(1).max(300),
  model: z.string().trim().min(1).max(120),
  apiKey: z.string().max(500).optional()
});

async function presentProvider(userId: string) {
  const [row] = await db.select().from(summaryProviders).where(eq(summaryProviders.userId, userId));
  if (!row) return { configured: false as const };
  const secret = row.apiKeyCipher ? decryptSecret(row.apiKeyCipher) : null;
  return {
    configured: true as const,
    apiBase: row.apiBase,
    model: row.model,
    hasKey: Boolean(row.apiKeyCipher),
    keyHint: secret ? keyHint(secret) : '',
    keyUnreadable: Boolean(row.apiKeyCipher) && !secret
  };
}

export async function meRoutes(app: FastifyInstance) {
  app.post('/v1/me/password', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const body = z.object({ currentPassword: z.string().min(1).max(200), newPassword: z.string().min(8).max(200) }).parse(request.body);
    if (body.currentPassword === body.newPassword) return reply.code(400).send({ message: '新密码需要和当前密码不同。' });
    if (!await changePassword(userId, body.currentPassword, body.newPassword)) return reply.code(401).send({ message: '当前密码不正确。' });
    return { updated: true };
  });

  app.get('/v1/me/profile', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    const [user] = await db.select({ id: users.id, email: users.email, displayName: users.displayName, role: users.role }).from(users).where(eq(users.id, userId));
    return user;
  });

  app.get('/v1/me/entitlement', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    return publicEntitlement(await ensureEntitlement(userId));
  });

  app.get('/v1/me/languages', { preHandler: app.authenticate }, async () => LANGUAGE_OPTIONS);

  app.get('/v1/me/glossaries', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    const rows = await db.select().from(glossaries).where(eq(glossaries.userId, userId));
    return Promise.all(rows.map(async (glossary) => ({ ...glossary, terms: await db.select().from(glossaryTerms).where(eq(glossaryTerms.glossaryId, glossary.id)) })));
  });

  app.post('/v1/me/glossaries', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const body = glossaryBody.parse(request.body);
    assertLanguagePair(body.languageA, body.languageB);
    const [glossary] = await db.insert(glossaries).values({ userId, name: body.name, languageA: body.languageA, languageB: body.languageB, presetKey: body.presetKey }).returning();
    const terms = uniqueTerms(body.terms ?? []);
    if (terms.length) await db.insert(glossaryTerms).values(terms.map((term) => ({ glossaryId: glossary.id, ...term })));
    return reply.code(201).send(glossary);
  });

  app.post('/v1/me/glossaries/:id/terms', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const body = termBody.parse(request.body);
    await ownedGlossary(userId, id);
    const existing = await db.select({ id: glossaryTerms.id }).from(glossaryTerms).where(eq(glossaryTerms.glossaryId, id));
    if (existing.length >= GLOSSARY_TERM_LIMIT) throw Object.assign(new Error('词库已达到 1000 条上限。'), { statusCode: 400 });
    await assertUniqueSource(id, body.source);
    const [term] = await db.insert(glossaryTerms).values({ glossaryId: id, source: body.source, target: body.target, pinned: body.pinned ?? false }).returning();
    return reply.code(201).send(term);
  });

  app.patch('/v1/me/glossaries/:id/terms/:termId', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    const { id, termId } = request.params as { id: string; termId: string };
    const body = termBody.parse(request.body);
    await ownedGlossary(userId, id);
    const [existing] = await db.select().from(glossaryTerms).where(and(eq(glossaryTerms.id, termId), eq(glossaryTerms.glossaryId, id)));
    if (!existing) throw Object.assign(new Error('找不到这条术语。'), { statusCode: 404 });
    await assertUniqueSource(id, body.source, termId);
    const [term] = await db.update(glossaryTerms).set({ source: body.source, target: body.target, pinned: body.pinned ?? existing.pinned }).where(eq(glossaryTerms.id, termId)).returning();
    return term;
  });

  app.delete('/v1/me/glossaries/:id/terms/:termId', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id, termId } = request.params as { id: string; termId: string };
    await ownedGlossary(userId, id);
    await db.delete(glossaryTerms).where(and(eq(glossaryTerms.id, termId), eq(glossaryTerms.glossaryId, id)));
    return reply.code(204).send();
  });

  app.delete('/v1/me/glossaries/:id', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    await db.delete(glossaries).where(and(eq(glossaries.id, id), eq(glossaries.userId, userId)));
    return reply.code(204).send();
  });

  app.get('/v1/me/summary-provider', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    return { ...await presentProvider(userId), platformAvailable: Boolean(config.platformSummary.apiBase && config.platformSummary.apiKey && config.platformSummary.model) };
  });

  app.put('/v1/me/summary-provider', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    const body = providerBody.parse(request.body);
    await assertSummaryEndpoint(body.apiBase);
    const apiKey = body.apiKey?.trim() ?? '';
    const [existing] = await db.select().from(summaryProviders).where(eq(summaryProviders.userId, userId));
    const apiKeyCipher = apiKey ? encryptSecret(apiKey) : existing?.apiKeyCipher ?? null;
    if (!apiKeyCipher && !endpointAllowsMissingKey(body.apiBase)) {
      throw Object.assign(new Error('公网地址必须填写密钥。'), { statusCode: 400 });
    }
    if (existing) {
      await db.update(summaryProviders).set({ apiBase: body.apiBase, model: body.model, apiKeyCipher, updatedAt: new Date() }).where(eq(summaryProviders.userId, userId));
    } else {
      await db.insert(summaryProviders).values({ userId, apiBase: body.apiBase, model: body.model, apiKeyCipher });
    }
    return { ...await presentProvider(userId), platformAvailable: Boolean(config.platformSummary.apiBase && config.platformSummary.apiKey && config.platformSummary.model) };
  });

  app.patch('/v1/me/profile', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const body = z.object({ displayName: z.string().trim().min(1).max(80) }).parse(request.body);
    const [user] = await db.update(users).set({ displayName: body.displayName }).where(eq(users.id, userId)).returning({ id: users.id, email: users.email, displayName: users.displayName, role: users.role });
    if (!user) return reply.code(404).send({ message: 'Account not found' });
    return user;
  });

  app.post('/v1/me/email/code', { preHandler: app.authenticate }, async (request, reply) => {
    const body = z.object({ email: z.string().email() }).parse(request.body);
    const email = body.email.trim().toLowerCase();
    if (await findUser(email)) return reply.code(409).send({ message: 'Email already registered' });
    await sendCode(email, 'email_change');
    return { sent: true };
  });

  app.post('/v1/me/email', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const body = z.object({ email: z.string().email(), code: z.string().length(6) }).parse(request.body);
    const email = body.email.trim().toLowerCase();
    if (await findUser(email)) return reply.code(409).send({ message: 'Email already registered' });
    if (!await verifyCode(email, 'email_change', body.code)) return reply.code(400).send({ message: 'Invalid verification code' });
    const [user] = await db.update(users).set({ email }).where(eq(users.id, userId)).returning({ id: users.id, email: users.email, displayName: users.displayName, role: users.role });
    return user;
  });

  app.get('/v1/me/usage', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    const rows = await db.select({
      id: usageLedger.id,
      kind: usageLedger.kind,
      source: usageLedger.source,
      seconds: usageLedger.seconds,
      createdAt: usageLedger.createdAt,
      title: transcripts.title
    }).from(usageLedger).leftJoin(transcripts, eq(usageLedger.transcriptId, transcripts.id)).where(and(eq(usageLedger.userId, userId), eq(usageLedger.status, 'settled'))).orderBy(desc(usageLedger.createdAt)).limit(30);
    return { items: rows };
  });

  app.get('/v1/me/export', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const [user] = await db.select({ id: users.id, email: users.email, displayName: users.displayName, createdAt: users.createdAt }).from(users).where(eq(users.id, userId));
    const glossaryRows = await db.select().from(glossaries).where(eq(glossaries.userId, userId));
    const glossaryExport = await Promise.all(glossaryRows.map(async (glossary) => ({ ...glossary, terms: await db.select().from(glossaryTerms).where(eq(glossaryTerms.glossaryId, glossary.id)) })));
    const transcriptRows = await db.select().from(transcripts).where(eq(transcripts.userId, userId)).orderBy(desc(transcripts.createdAt));
    const transcriptExport = await Promise.all(transcriptRows.map(async (transcript) => {
      const { audioRelPath: _path, ...rest } = transcript;
      return { ...rest, segments: await db.select().from(transcriptSegments).where(eq(transcriptSegments.transcriptId, transcript.id)).orderBy(transcriptSegments.idx) };
    }));
    reply.header('content-disposition', 'attachment; filename="linguaflow-export.json"');
    return { user, glossaries: glossaryExport, transcripts: transcriptExport };
  });

  app.post('/v1/me/delete', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const body = z.object({ email: z.string().email() }).parse(request.body);
    const [user] = await db.select({ email: users.email }).from(users).where(eq(users.id, userId));
    if (!user || user.email !== body.email.trim().toLowerCase()) return reply.code(400).send({ message: '邮箱确认不一致。' });
    await deleteAccount(userId);
    return reply.code(204).send();
  });

  app.patch('/v1/me/glossaries/:id', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const body = z.object({ name: z.string().trim().min(1).max(80), languageA: z.string().trim().min(2).max(16), languageB: z.string().trim().min(2).max(16) }).parse(request.body);
    assertLanguagePair(body.languageA, body.languageB);
    await ownedGlossary(userId, id);
    const [glossary] = await db.update(glossaries).set({ name: body.name, languageA: body.languageA, languageB: body.languageB }).where(and(eq(glossaries.id, id), eq(glossaries.userId, userId))).returning();
    return glossary;
  });

  app.post('/v1/me/glossaries/:id/import', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const body = z.object({ text: z.string().max(100_000) }).parse(request.body);
    await ownedGlossary(userId, id);
    const existing = await db.select().from(glossaryTerms).where(eq(glossaryTerms.glossaryId, id));
    const classified = classifyGlossaryImport(body.text, existing.map((term) => term.source));
    if (classified.accepted.length) await db.insert(glossaryTerms).values(classified.accepted.map((term) => ({ glossaryId: id, ...term })));
    const skipped = classified.skippedDuplicate + classified.skippedInvalid + classified.skippedLimit;
    return { added: classified.accepted.length, skipped, skippedDuplicate: classified.skippedDuplicate, skippedInvalid: classified.skippedInvalid, skippedLimit: classified.skippedLimit };
  });

  app.get('/v1/me/glossaries/:id/export', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const glossary = await ownedGlossary(userId, id);
    const terms = await db.select().from(glossaryTerms).where(eq(glossaryTerms.glossaryId, id));
    reply.header('content-disposition', `attachment; filename="${encodeURIComponent(glossary.name)}.txt"`);
    return reply.type('text/plain; charset=utf-8').send(terms.map((term) => `${term.source}\t${term.target}`).join('\n'));
  });

  app.get('/v1/me/glossaries/:id/coverage', { preHandler: app.authenticate }, async (request) => {
    const userId = (request.user as { sub: string }).sub;
    const { id } = request.params as { id: string };
    const query = z.object({ type: z.enum(['one_way', 'two_way']), languageA: z.string().min(2), languageB: z.string().optional(), targetLanguage: z.string().optional() }).parse(request.query);
    const glossary = await ownedGlossary(userId, id);
    const terms = await db.select({ source: glossaryTerms.source, target: glossaryTerms.target, pinned: glossaryTerms.pinned }).from(glossaryTerms).where(eq(glossaryTerms.glossaryId, id));
    const session: SonioxSessionInput = { id: 'preview', mode: query.type, languageA: query.languageA, languageB: query.languageB ?? null, targetLanguage: query.targetLanguage ?? null };
    const packed = glossaryInjection(session, terms, { languageA: glossary.languageA, languageB: glossary.languageB, presetKey: glossary.presetKey });
    return { used: packed.used, dropped: packed.dropped, droppedTerms: packed.droppedTerms.slice(0, 40), aligned: packed.aligned };
  });

  app.get('/v1/me/glossary-presets', { preHandler: app.authenticate }, async () => {
    return GLOSSARY_PRESETS.map(({ key, name, languageA, languageB, terms }) => ({ key, name, languageA, languageB, count: terms.length }));
  });

  app.post('/v1/me/glossaries/from-preset', { preHandler: app.authenticate }, async (request, reply) => {
    const userId = (request.user as { sub: string }).sub;
    const body = z.object({ preset: z.enum(GLOSSARY_PRESET_KEYS) }).parse(request.body);
    const preset = findGlossaryPreset(body.preset);
    if (!preset) return reply.code(404).send({ message: '找不到预置词库。' });
    const [glossary] = await db.insert(glossaries).values({ userId, name: preset.name, languageA: preset.languageA, languageB: preset.languageB, presetKey: preset.key }).returning();
    await db.insert(glossaryTerms).values(preset.terms.map((term) => ({ glossaryId: glossary.id, ...term, pinned: false })));
    return reply.code(201).send({ ...glossary, terms: preset.terms });
  });
}
