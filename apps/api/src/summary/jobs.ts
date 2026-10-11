import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { sanitizeModelMarkdown, sourceHash, summaryAttemptOutcome, summaryInputHash, summaryReplay, preserveCitationSnapshot, type SummarySegmentInput } from '@linguaflow/shared';
import { db } from '../db/index.js';
import { noteVersions, realtimeSessions, summaryProviders, summaryRequests, transcriptSegments, transcriptTasks, transcripts, usageLedger } from '../db/schema.js';
import { formatClock } from '../export/meeting.js';
import { config } from '../config.js';
import { assertFreeTranslation, latestUserDevice } from '../lib/device-store.js';
import { confirmSummaryUsage, ensureEntitlement, platformSummarySeconds, refundSummaryUsage, remainingSeconds, reserveQuotedSummary } from '../lib/quota.js';
import { recordEvent } from '../lib/events.js';
import type { DeviceRef } from '../lib/device.js';
import { decryptSecret } from '../lib/secrets.js';
import { assertSummaryEndpoint, endpointAllowsMissingKey } from '../lib/ssrf.js';
import { extractActionItems, PLANS, type Plan } from '@linguaflow/shared';
import { chatComplete } from './client.js';
import { summarize, SUMMARY_TEMPLATES, SummaryError, type SummaryEntry, type SummaryTemplate } from './pipeline.js';

type Job = { transcriptId: string; controller: AbortController };
const inflight = new Map<string, Job>();

const httpError = (statusCode: number, message: string, code?: string) => Object.assign(new Error(message), { statusCode, code });

export async function markInterruptedSummaries() {
  const running = await db.select().from(summaryRequests).where(eq(summaryRequests.status, 'running'));
  for (const request of running) {
    const [transcript] = await db.select({
      summaryStatus: transcripts.summaryStatus,
      summarySourceHash: transcripts.summarySourceHash,
      summaryGeneratedAt: transcripts.summaryGeneratedAt,
      summaryMarkdown: transcripts.summaryMarkdown
    }).from(transcripts).where(and(eq(transcripts.id, request.transcriptId), eq(transcripts.userId, request.userId)));
    const ledgers = await db.select({ status: usageLedger.status, requestId: usageLedger.requestId, createdAt: usageLedger.createdAt }).from(usageLedger).where(and(eq(usageLedger.userId, request.userId), eq(usageLedger.transcriptId, request.transcriptId), eq(usageLedger.kind, 'summary')));
    const mine = ledgers.filter((row) => row.requestId === request.id || (row.requestId == null && row.createdAt >= request.createdAt));
    const ledger = mine.some((row) => row.status === 'held') ? 'held' as const : mine.some((row) => row.status === 'settled') ? 'settled' as const : 'none' as const;
    const outcome = summaryAttemptOutcome({
      requestHash: request.inputHash,
      requestCreatedAtMs: request.createdAt.getTime(),
      transcriptStatus: transcript?.summaryStatus ?? null,
      sourceHash: transcript?.summarySourceHash ?? null,
      generatedAtMs: transcript?.summaryGeneratedAt?.getTime() ?? null,
      ledger
    });
    if (outcome === 'settle') await confirmSummaryUsage(request.userId, request.transcriptId);
    if (outcome === 'settle' || outcome === 'complete') {
      await db.update(summaryRequests).set({ status: 'ready' }).where(and(eq(summaryRequests.id, request.id), eq(summaryRequests.status, 'running')));
      if (transcript?.summaryMarkdown) await syncSummaryTasks(request.transcriptId, transcript.summaryMarkdown);
    } else if (outcome === 'refund') await refundSummaryUsage(request.userId, request.transcriptId);
  }
  const held = await db.select({ userId: usageLedger.userId, transcriptId: usageLedger.transcriptId }).from(usageLedger).where(and(eq(usageLedger.kind, 'summary'), eq(usageLedger.status, 'held')));
  for (const row of held) {
    if (row.transcriptId) await refundSummaryUsage(row.userId, row.transcriptId);
  }
  await db.update(transcripts).set({ summaryStatus: 'failed', summaryError: '总结已中断。' }).where(eq(transcripts.summaryStatus, 'running'));
  await db.update(summaryRequests).set({ status: 'failed' }).where(eq(summaryRequests.status, 'running'));
}

export function summarySourceHash(segments: SummarySegmentInput[]) {
  return summaryInputHash(segments);
}

async function restoreSummary(userId: string, transcriptId: string) {
  const [row] = await db.select({ summaryMarkdown: transcripts.summaryMarkdown }).from(transcripts).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), inArray(transcripts.summaryStatus, ['running', 'cancelling']), isNull(transcripts.deletedAt)));
  if (!row) return;
  await db.update(transcripts).set({ summaryStatus: row.summaryMarkdown ? 'ready' : 'none', summaryError: null }).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), inArray(transcripts.summaryStatus, ['running', 'cancelling']), isNull(transcripts.deletedAt)));
}

async function summaryWasCancelled(userId: string, transcriptId: string) {
  const [row] = await db.select({ summaryStatus: transcripts.summaryStatus, deletedAt: transcripts.deletedAt }).from(transcripts).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId)));
  return !row || Boolean(row.deletedAt) || row.summaryStatus === 'cancelling';
}

async function snapshotNote(userId: string, transcript: typeof transcripts.$inferSelect) {
  if (!transcript.summaryMarkdown) return;
  const [latest] = await db.select({ body: noteVersions.body }).from(noteVersions).where(eq(noteVersions.transcriptId, transcript.id)).orderBy(desc(noteVersions.createdAt)).limit(1);
  if (latest?.body === transcript.summaryMarkdown) return;
  await db.insert(noteVersions).values({
    transcriptId: transcript.id,
    userId,
    authorType: transcript.summaryEditedAt ? 'human' : 'ai',
    template: transcript.summaryTemplate,
    inputVersion: transcript.summaryInputVersion,
    provider: transcript.summaryBilling,
    body: transcript.summaryMarkdown,
    inputHash: transcript.summarySourceHash,
    outputLanguage: transcript.summaryLanguage,
    citationHashes: transcript.summaryCitationsVerified ? transcript.summaryCitationHashes : null,
    sourceHash: transcript.summaryCitationsVerified ? transcript.summarySourceHash : null
  });
}

async function runSummary(userId: string, transcriptId: string, template: SummaryTemplate, outputLanguage: string, apiBase: string, apiKey: string | undefined, model: string, billing: 'platform' | 'byok', entries: SummaryEntry[], segments: SummarySegmentInput[], hash: string, epoch: number, controller: AbortController, requestId: string | null) {
  let committed = false;
  try {
    const markdown = await summarize(entries, {
      template,
      outputLanguage,
      signal: controller.signal,
      shouldStop: () => summaryWasCancelled(userId, transcriptId),
      chat: (messages, signal) => chatComplete({ apiBase, apiKey, model, messages, signal })
    });
    if (controller.signal.aborted || await summaryWasCancelled(userId, transcriptId)) {
      await refundSummaryUsage(userId, transcriptId);
      await restoreSummary(userId, transcriptId);
      await db.update(summaryRequests).set({ status: 'cancelled' }).where(and(eq(summaryRequests.transcriptId, transcriptId), eq(summaryRequests.userId, userId), eq(summaryRequests.status, 'running')));
      await recordEvent({ userId, name: 'summary_cancelled', dedupeKey: `summary_cancelled:${transcriptId}:${hash}:${epoch}`, props: { transcriptId, template, provider: billing } });
      return;
    }
    const ids = new Set(segments.map((segment) => segment.id));
    const hashes = Object.fromEntries(segments.map((segment) => [segment.id, segment.sourceText ? sourceHash(segment.sourceText) : '']));
    const sources = Object.fromEntries(segments.map((segment) => [segment.id, segment.sourceText]));
    const clean = sanitizeModelMarkdown(markdown, ids, hashes, sources);
    const [updated] = await db.transaction(async (tx) => {
      const [row] = await tx.update(transcripts).set({
        summaryMarkdown: clean,
        summaryStatus: 'ready',
        summaryError: null,
        summaryTemplate: template,
        summaryLanguage: outputLanguage,
        summaryModel: model,
        summarySourceHash: hash,
        summaryGeneratedAt: new Date(),
        summaryEditedAt: null,
        summaryBilling: billing,
        summaryStale: false,
        summaryCitationHashes: hashes,
        summaryCitationsVerified: true
      }).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), eq(transcripts.summaryStatus, 'running'), eq(transcripts.noteEpoch, epoch), isNull(transcripts.deletedAt))).returning({ id: transcripts.id });
      if (!row) return [];
      await tx.update(usageLedger).set({ status: 'settled' }).where(and(eq(usageLedger.userId, userId), eq(usageLedger.transcriptId, transcriptId), eq(usageLedger.kind, 'summary'), eq(usageLedger.status, 'held'), requestId ? or(eq(usageLedger.requestId, requestId), isNull(usageLedger.requestId)) : isNull(usageLedger.requestId)));
      await tx.insert(noteVersions).values({ transcriptId, userId, authorType: 'ai', template, inputVersion: null, provider: billing, body: clean, inputHash: hash, outputLanguage, citationHashes: hashes, citationsVerified: true, sourceHash: hash });
      await tx.update(summaryRequests).set({ status: 'ready' }).where(and(eq(summaryRequests.transcriptId, transcriptId), eq(summaryRequests.userId, userId), eq(summaryRequests.noteEpoch, epoch), eq(summaryRequests.status, 'running')));
      return [row];
    });
    if (updated) {
      committed = true;
      await syncSummaryTasks(transcriptId, clean);
      await recordEvent({ userId, name: 'summary_succeeded', dedupeKey: `summary_succeeded:${transcriptId}:${hash}:${epoch}`, props: { transcriptId, template, provider: billing } });
    } else {
      await refundSummaryUsage(userId, transcriptId);
      await db.update(summaryRequests).set({ status: 'cancelled' }).where(and(eq(summaryRequests.transcriptId, transcriptId), eq(summaryRequests.userId, userId), eq(summaryRequests.status, 'running'), eq(summaryRequests.noteEpoch, epoch)));
    }
  } catch (error) {
    if (committed) return;
    await refundSummaryUsage(userId, transcriptId);
    if (controller.signal.aborted || (error instanceof SummaryError && error.kind === 'cancelled')) {
      await restoreSummary(userId, transcriptId);
      await recordEvent({ userId, name: 'summary_cancelled', dedupeKey: `summary_cancelled:${transcriptId}:${hash}:${epoch}`, props: { transcriptId, template, provider: billing } });
      return;
    }
    const message = error instanceof SummaryError ? error.message : '总结失败。';
    await db.update(transcripts).set({ summaryStatus: 'failed', summaryError: message }).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), inArray(transcripts.summaryStatus, ['running', 'cancelling']), isNull(transcripts.deletedAt)));
    await db.update(summaryRequests).set({ status: 'failed' }).where(and(eq(summaryRequests.transcriptId, transcriptId), eq(summaryRequests.userId, userId), eq(summaryRequests.status, 'running')));
    await recordEvent({ userId, name: 'summary_failed', dedupeKey: `summary_failed:${transcriptId}:${hash}:${epoch}`, props: { transcriptId, template, provider: billing } });
  }
}

async function recordedDevice(userId: string, sessionId: string | null) {
  if (sessionId) {
    const [session] = await db.select({ fingerprintHash: realtimeSessions.fingerprintHash, deviceId: realtimeSessions.deviceId }).from(realtimeSessions).where(eq(realtimeSessions.id, sessionId));
    if (session?.fingerprintHash && session.deviceId) return { fingerprintHash: session.fingerprintHash, deviceId: session.deviceId };
  }
  return latestUserDevice(userId);
}

function toEntries(segments: Array<typeof transcriptSegments.$inferSelect>): SummaryEntry[] {
  return segments.map((segment) => ({
    timestamp: formatClock(segment.startMs),
    original: segment.sourceText.trim(),
    translation: segment.translationText.trim(),
    segmentId: segment.id,
    speaker: segment.speaker,
    startMs: segment.startMs
  })).filter((entry) => entry.original || entry.translation);
}

export async function quoteSummary(userId: string, transcriptId: string, template: SummaryTemplate, provider: 'platform' | 'byok') {
  const [transcript] = await db.select().from(transcripts).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), isNull(transcripts.deletedAt)));
  if (!transcript) throw httpError(404, 'Transcript not found');
  if (transcript.recordStatus === 'active') throw httpError(409, '这场记录还在进行，结束后再生成笔记。');
  const segments = await db.select().from(transcriptSegments).where(eq(transcriptSegments.transcriptId, transcriptId)).orderBy(transcriptSegments.idx);
  const usable = toEntries(segments);
  if (!usable.length) throw httpError(400, '这条记录没有可总结的文本。');
  const entitlement = await ensureEntitlement(userId);
  const plan = entitlement.plan as Plan;
  const charCount = usable.reduce((sum, entry) => sum + entry.original.length + entry.translation.length, 0);
  const seconds = provider === 'platform' ? platformSummarySeconds(charCount, plan) : 0;
  const unlimited = PLANS[plan].monthlySeconds === null;
  const available = unlimited ? null : remainingSeconds(entitlement) + entitlement.addonSeconds;
  return {
    provider,
    template,
    seconds,
    remainingAfter: available === null ? null : Math.max(0, available - seconds),
    inputHash: summaryInputHash(segments),
    inputVersion: transcript.summaryInputVersion,
    edited: Boolean(transcript.summaryEditedAt),
    notice: provider === 'byok' ? '不扣平台分钟；模型服务可能自行收费。' : null
  };
}

export async function startSummary(userId: string, transcriptId: string, template: SummaryTemplate, outputLanguage: string, provider: 'platform' | 'byok' = 'byok', device?: DeviceRef | null, confirmation?: { idempotencyKey: string; inputHash: string; inputVersion: number; quoteSeconds: number; confirmOverwrite?: boolean }) {
  if (!confirmation?.idempotencyKey) throw httpError(400, '请确认后再生成笔记。');
  const [transcript] = await db.select().from(transcripts).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), isNull(transcripts.deletedAt)));
  if (!transcript) throw httpError(404, 'Transcript not found');
  if (transcript.recordStatus === 'active') throw httpError(409, '这场记录还在进行，结束后再生成笔记。');
  if (transcript.summaryEditedAt && !confirmation.confirmOverwrite) throw httpError(409, '笔记已手动修改。确认后才会用新的生成结果替换它。', 'confirm_overwrite');
  const segments = await db.select().from(transcriptSegments).where(eq(transcriptSegments.transcriptId, transcriptId)).orderBy(transcriptSegments.idx);
  const entries = toEntries(segments);
  if (!entries.length) throw httpError(400, '这条记录没有可总结的文本。');
  const hash = summaryInputHash(segments);
  if (hash !== confirmation.inputHash || transcript.summaryInputVersion !== confirmation.inputVersion) throw httpError(409, '字幕已经变化，请重新确认费用。', 'quote_stale');
  const entitlement = await ensureEntitlement(userId);
  const expected = provider === 'platform' ? platformSummarySeconds(entries.reduce((sum, entry) => sum + entry.original.length + entry.translation.length, 0), entitlement.plan as Plan) : 0;
  if (expected !== confirmation.quoteSeconds) throw httpError(409, '费用已经变化，请重新确认。', 'quote_stale');
  const [existingRequest] = await db.select().from(summaryRequests).where(and(eq(summaryRequests.userId, userId), eq(summaryRequests.idempotencyKey, confirmation.idempotencyKey)));
  if (existingRequest) {
    if (existingRequest.transcriptId !== transcriptId || existingRequest.inputHash !== hash || existingRequest.provider !== provider || existingRequest.quoteSeconds !== expected || existingRequest.template !== template) throw httpError(409, '这次确认对应的内容和费用不一致。', 'quote_stale');
    if (summaryReplay(existingRequest.status) === 'return') return { status: existingRequest.status, duplicate: true as const };
    const ledgers = await db.select({ status: usageLedger.status, requestId: usageLedger.requestId, createdAt: usageLedger.createdAt }).from(usageLedger).where(and(eq(usageLedger.userId, userId), eq(usageLedger.transcriptId, transcriptId), eq(usageLedger.kind, 'summary')));
    const mine = ledgers.filter((row) => row.requestId === existingRequest.id || (row.requestId == null && row.createdAt >= existingRequest.createdAt));
    const ledger = mine.some((row) => row.status === 'held') ? 'held' as const : mine.some((row) => row.status === 'settled') ? 'settled' as const : 'none' as const;
    const outcome = summaryAttemptOutcome({
      requestHash: existingRequest.inputHash,
      requestCreatedAtMs: existingRequest.createdAt.getTime(),
      transcriptStatus: transcript.summaryStatus,
      sourceHash: transcript.summarySourceHash,
      generatedAtMs: transcript.summaryGeneratedAt?.getTime() ?? null,
      ledger
    });
    if (outcome === 'settle' || outcome === 'complete') {
      if (outcome === 'settle') await confirmSummaryUsage(userId, transcriptId);
      await db.update(summaryRequests).set({ status: 'ready' }).where(eq(summaryRequests.id, existingRequest.id));
      return { status: 'ready' as const, duplicate: true as const };
    }
  }
  if (inflight.has(userId)) throw httpError(409, '已有一份纪要正在生成。');
  const controller = new AbortController();
  inflight.set(userId, { transcriptId, controller });
  let reserved = false;
  let markedRunning = false;
  const previousStatus = transcript.summaryStatus;
  try {
    let apiBase = '';
    let apiKey: string | undefined;
    let model = '';
    if (provider === 'platform') {
      if (!config.platformSummary.apiBase || !config.platformSummary.apiKey || !config.platformSummary.model) throw httpError(400, '平台模型未配置。');
      apiBase = config.platformSummary.apiBase;
      apiKey = config.platformSummary.apiKey;
      model = config.platformSummary.model;
      await assertSummaryEndpoint(apiBase);
    } else {
      const [saved] = await db.select().from(summaryProviders).where(eq(summaryProviders.userId, userId));
      if (!saved) throw httpError(400, '请先在账户里保存你的总结模型。');
      await assertSummaryEndpoint(saved.apiBase);
      apiKey = saved.apiKeyCipher ? decryptSecret(saved.apiKeyCipher) ?? undefined : undefined;
      if (saved.apiKeyCipher && !apiKey) throw httpError(400, '已保存的密钥无法读取，请重新填写。');
      if (!apiKey && !endpointAllowsMissingKey(saved.apiBase)) throw httpError(400, '公网地址必须填写密钥。');
      apiBase = saved.apiBase;
      model = saved.model;
    }
    const seen = device === undefined ? await recordedDevice(userId, transcript.sessionId) : device;
    await snapshotNote(userId, transcript);
    let requestId = existingRequest?.id ?? null;
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId})::bigint)`);
      const [busy] = await tx.select({ id: transcripts.id }).from(transcripts).where(and(eq(transcripts.userId, userId), eq(transcripts.summaryStatus, 'running'), isNull(transcripts.deletedAt)));
      if (busy && busy.id !== transcriptId) throw httpError(409, '已有一份纪要正在生成。');
      if (existingRequest) {
        requestId = existingRequest.id;
        await tx.update(summaryRequests).set({ status: 'running', inputHash: hash, inputVersion: confirmation.inputVersion, provider, template, quoteSeconds: expected, noteEpoch: transcript.noteEpoch }).where(eq(summaryRequests.id, existingRequest.id));
      } else {
        const [created] = await tx.insert(summaryRequests).values({
          userId,
          transcriptId,
          idempotencyKey: confirmation.idempotencyKey,
          inputHash: hash,
          inputVersion: confirmation.inputVersion,
          provider,
          template,
          quoteSeconds: expected,
          status: 'running',
          noteEpoch: transcript.noteEpoch
        }).returning({ id: summaryRequests.id });
        requestId = created?.id ?? null;
      }
      await tx.update(transcripts).set({ summaryStatus: 'running', summaryError: null, summaryTemplate: template, summaryLanguage: outputLanguage }).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), isNull(transcripts.deletedAt)));
    });
    markedRunning = true;
    if (provider === 'platform') {
      if (entitlement.plan === 'free') await assertFreeTranslation(userId, seen);
      await reserveQuotedSummary(userId, transcriptId, expected, seen, requestId);
      reserved = true;
    }
    await recordEvent({ userId, name: 'summary_requested', dedupeKey: `summary_requested:${transcriptId}:${confirmation.idempotencyKey}`, props: { transcriptId, template, provider } });
    void runSummary(userId, transcriptId, template, outputLanguage, apiBase, apiKey, model, provider, entries, segments, hash, transcript.noteEpoch, controller, requestId).finally(() => {
      if (inflight.get(userId)?.controller === controller) inflight.delete(userId);
    });
    return { status: 'running' as const, duplicate: false as const };
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : '';
    if (code === '23505') {
      if (inflight.get(userId)?.controller === controller) inflight.delete(userId);
      const [raced] = await db.select().from(summaryRequests).where(and(eq(summaryRequests.userId, userId), eq(summaryRequests.idempotencyKey, confirmation.idempotencyKey)));
      return { status: raced?.status ?? 'running', duplicate: true as const };
    }
    if (reserved) await refundSummaryUsage(userId, transcriptId);
    await db.update(summaryRequests).set({ status: 'failed' }).where(and(eq(summaryRequests.userId, userId), eq(summaryRequests.idempotencyKey, confirmation.idempotencyKey), eq(summaryRequests.status, 'running'))).catch(() => undefined);
    if (markedRunning) await db.update(transcripts).set({ summaryStatus: previousStatus === 'running' ? 'failed' : previousStatus, summaryError: null }).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), eq(transcripts.summaryStatus, 'running'))).catch(() => undefined);
    if (inflight.get(userId)?.controller === controller) inflight.delete(userId);
    throw error;
  }
}

export async function syncSummaryTasks(transcriptId: string, markdown: string, executor: Pick<typeof db, 'select' | 'insert' | 'delete'> = db) {
  const items = extractActionItems(markdown);
  const existing = await executor.select().from(transcriptTasks).where(eq(transcriptTasks.transcriptId, transcriptId));
  const done = new Set(existing.filter((task) => task.done).map((task) => task.text));
  await executor.delete(transcriptTasks).where(eq(transcriptTasks.transcriptId, transcriptId));
  if (!items.length) return;
  await executor.insert(transcriptTasks).values(items.map((text, position) => ({ transcriptId, text, done: done.has(text), position })));
}

export async function markSummaryStale(userId: string, transcriptId: string) {
  const [row] = await db.select().from(transcripts).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), isNull(transcripts.deletedAt)));
  if (!row) return { stale: false as const };
  const segments = await db.select().from(transcriptSegments).where(eq(transcriptSegments.transcriptId, transcriptId)).orderBy(transcriptSegments.idx);
  const hash = summaryInputHash(segments);
  const stale = !row.summaryCitationsVerified || Boolean(row.summaryMarkdown && row.summarySourceHash && row.summarySourceHash !== hash);
  const inputVersion = stale ? row.summaryInputVersion + 1 : row.summaryInputVersion;
  await db.update(transcripts).set({ summaryStale: stale, summaryInputVersion: inputVersion }).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId)));
  return { stale, inputHash: hash, inputVersion };
}

export async function saveHumanNote(userId: string, transcriptId: string, markdown: string) {
  const [row] = await db.select().from(transcripts).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), isNull(transcripts.deletedAt)));
  if (!row) return null;
  const segments = await db.select().from(transcriptSegments).where(eq(transcriptSegments.transcriptId, transcriptId));
  const clean = sanitizeModelMarkdown(markdown, new Set(segments.map((segment) => segment.id)), undefined, undefined, false);
  const currentHashes = Object.fromEntries(segments.map((segment) => [segment.id, segment.sourceText ? sourceHash(segment.sourceText) : '']));
  const kept = preserveCitationSnapshot(clean, { hashes: row.summaryCitationsVerified ? row.summaryCitationHashes : null, verified: row.summaryCitationsVerified }, currentHashes);
  const [updated] = await db.transaction(async (tx) => {
    const [saved] = await tx.update(transcripts).set({
      summaryMarkdown: clean,
      summaryStatus: 'ready',
      summaryError: null,
      summaryEditedAt: new Date(),
      summaryCitationHashes: kept.hashes,
      summaryCitationsVerified: kept.verified,
      noteEpoch: row.noteEpoch + 1
    }).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), isNull(transcripts.deletedAt))).returning();
    if (!saved) return [];
    await tx.insert(noteVersions).values({ transcriptId, userId, authorType: 'human', template: row.summaryTemplate, inputVersion: row.summaryInputVersion, provider: row.summaryBilling, body: clean, inputHash: row.summarySourceHash, outputLanguage: row.summaryLanguage, citationHashes: kept.hashes, citationsVerified: kept.verified, sourceHash: row.summarySourceHash });
    await syncSummaryTasks(transcriptId, clean, tx);
    return [saved];
  });
  return updated ?? null;
}

export async function restoreNoteVersion(userId: string, transcriptId: string, versionId: string) {
  const [version] = await db.select().from(noteVersions).where(and(eq(noteVersions.id, versionId), eq(noteVersions.transcriptId, transcriptId), eq(noteVersions.userId, userId)));
  if (!version) return null;
  const [row] = await db.select().from(transcripts).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), isNull(transcripts.deletedAt)));
  if (!row) return null;
  const segments = await db.select().from(transcriptSegments).where(eq(transcriptSegments.transcriptId, transcriptId)).orderBy(transcriptSegments.idx);
  const currentHash = summaryInputHash(segments);
  const verified = version.citationsVerified ?? version.citationHashes != null;
  const [updated] = await db.update(transcripts).set({
    summaryMarkdown: version.body,
    summaryStatus: 'ready',
    summaryError: null,
    summaryEditedAt: new Date(),
    summaryTemplate: version.template ?? row.summaryTemplate,
    summaryLanguage: version.outputLanguage ?? row.summaryLanguage,
    summarySourceHash: version.sourceHash,
    summaryCitationHashes: version.citationHashes ?? {},
    summaryCitationsVerified: verified,
    summaryStale: !verified || Boolean(version.sourceHash && version.sourceHash !== currentHash),
    noteEpoch: row.noteEpoch + 1
  }).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), isNull(transcripts.deletedAt))).returning();
  if (!updated) return null;
  await db.insert(noteVersions).values({
    transcriptId,
    userId,
    authorType: 'restore',
    template: version.template,
    inputVersion: version.inputVersion,
    provider: null,
    body: version.body,
    inputHash: version.inputHash,
    outputLanguage: version.outputLanguage,
    citationHashes: version.citationHashes,
    citationsVerified: version.citationsVerified,
    sourceHash: version.sourceHash
  });
  await syncSummaryTasks(transcriptId, version.body);
  return updated;
}

export async function cancelSummary(userId: string, transcriptId: string) {
  const job = inflight.get(userId);
  if (job?.transcriptId === transcriptId) job.controller.abort();
  else await refundSummaryUsage(userId, transcriptId);
  const [updated] = await db.update(transcripts).set({ summaryStatus: 'cancelling' }).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), eq(transcripts.summaryStatus, 'running'))).returning({ id: transcripts.id });
  await db.update(summaryRequests).set({ status: 'cancelled' }).where(and(eq(summaryRequests.transcriptId, transcriptId), eq(summaryRequests.userId, userId), eq(summaryRequests.status, 'running')));
  if (!updated && job?.transcriptId !== transcriptId) return { status: 'idle' as const };
  return { status: 'cancelling' as const };
}

export { SUMMARY_TEMPLATES };
