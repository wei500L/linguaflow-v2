import crypto from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { summaryProviders, transcriptSegments, transcriptTasks, transcripts } from '../db/schema.js';
import { formatClock } from '../export/meeting.js';
import { config } from '../config.js';
import { confirmSummaryUsage, refundSummaryUsage, reserveSummaryUsage } from '../lib/quota.js';
import { decryptSecret } from '../lib/secrets.js';
import { assertSummaryEndpoint, endpointAllowsMissingKey } from '../lib/ssrf.js';
import { extractActionItems } from '@linguaflow/shared';
import { chatComplete } from './client.js';
import { summarize, SUMMARY_TEMPLATES, SummaryError, type SummaryEntry, type SummaryTemplate } from './pipeline.js';

type Job = { transcriptId: string; controller: AbortController };
const inflight = new Map<string, Job>();

const httpError = (statusCode: number, message: string) => Object.assign(new Error(message), { statusCode });

export async function markInterruptedSummaries() {
  const rows = await db.select({ id: transcripts.id, userId: transcripts.userId }).from(transcripts).where(eq(transcripts.summaryStatus, 'running'));
  await Promise.all(rows.map((row) => refundSummaryUsage(row.userId, row.id)));
  await db.update(transcripts).set({ summaryStatus: 'failed', summaryError: '总结已中断。' }).where(eq(transcripts.summaryStatus, 'running'));
}

export function summarySourceHash(segments: Array<{ startMs: number | null; sourceText: string; translationText: string }>) {
  return crypto.createHash('sha256').update(segments.map((segment) => `${segment.startMs ?? ''}|${segment.sourceText}|${segment.translationText}`).join('\n')).digest('hex');
}

async function restoreSummary(userId: string, transcriptId: string) {
  const [row] = await db.select({ summaryMarkdown: transcripts.summaryMarkdown }).from(transcripts).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), inArray(transcripts.summaryStatus, ['running', 'cancelling'])));
  if (!row) return;
  await db.update(transcripts).set({ summaryStatus: row.summaryMarkdown ? 'ready' : 'none', summaryError: null }).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), inArray(transcripts.summaryStatus, ['running', 'cancelling'])));
}

async function summaryWasCancelled(userId: string, transcriptId: string) {
  const [row] = await db.select({ summaryStatus: transcripts.summaryStatus }).from(transcripts).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId)));
  return row?.summaryStatus === 'cancelling';
}

async function runSummary(userId: string, transcriptId: string, template: SummaryTemplate, outputLanguage: string, apiBase: string, apiKey: string | undefined, model: string, billing: 'platform' | 'byok', entries: SummaryEntry[], hash: string, controller: AbortController) {
  try {
    const markdown = await summarize(entries, {
      template,
      outputLanguage,
      signal: controller.signal,
      shouldStop: () => summaryWasCancelled(userId, transcriptId),
      chat: (messages, signal) => chatComplete({ apiBase, apiKey, model, messages, signal })
    });
    if (controller.signal.aborted) {
      await refundSummaryUsage(userId, transcriptId);
      await restoreSummary(userId, transcriptId);
      return;
    }
    const [updated] = await db.update(transcripts).set({
      summaryMarkdown: markdown,
      summaryStatus: 'ready',
      summaryError: null,
      summaryTemplate: template,
      summaryLanguage: outputLanguage,
      summaryModel: model,
      summarySourceHash: hash,
      summaryGeneratedAt: new Date(),
      summaryEditedAt: null,
      summaryBilling: billing
    }).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), eq(transcripts.summaryStatus, 'running'))).returning({ id: transcripts.id });
    if (updated) {
      await confirmSummaryUsage(userId, transcriptId);
      await syncSummaryTasks(transcriptId, markdown);
    } else await refundSummaryUsage(userId, transcriptId);
  } catch (error) {
    await refundSummaryUsage(userId, transcriptId);
    if (controller.signal.aborted || (error instanceof SummaryError && error.kind === 'cancelled')) {
      await restoreSummary(userId, transcriptId);
      return;
    }
    const message = error instanceof SummaryError ? error.message : '总结失败。';
    await db.update(transcripts).set({ summaryStatus: 'failed', summaryError: message }).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), inArray(transcripts.summaryStatus, ['running', 'cancelling'])));
  }
}

export async function startSummary(userId: string, transcriptId: string, template: SummaryTemplate, outputLanguage: string, provider: 'platform' | 'byok' = 'byok') {
  if (inflight.has(userId)) throw httpError(409, '已有一份纪要正在生成。');
  const controller = new AbortController();
  inflight.set(userId, { transcriptId, controller });
  try {
    const [transcript] = await db.select().from(transcripts).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId)));
    if (!transcript) throw httpError(404, 'Transcript not found');
    const segments = await db.select().from(transcriptSegments).where(eq(transcriptSegments.transcriptId, transcriptId)).orderBy(transcriptSegments.idx);
    const entries = segments.map((segment) => ({ timestamp: formatClock(segment.startMs), original: segment.sourceText.trim(), translation: segment.translationText.trim() })).filter((entry) => entry.original || entry.translation);
    if (!entries.length) throw httpError(400, '这条记录没有可总结的文本。');
    let apiBase = '';
    let apiKey: string | undefined;
    let model = '';
    if (provider === 'platform') {
      if (!config.platformSummary.apiBase || !config.platformSummary.apiKey || !config.platformSummary.model) throw httpError(400, '平台模型未配置。');
      apiBase = config.platformSummary.apiBase;
      apiKey = config.platformSummary.apiKey;
      model = config.platformSummary.model;
      await assertSummaryEndpoint(apiBase);
      const charCount = entries.reduce((sum, entry) => sum + entry.original.length + entry.translation.length, 0);
      await reserveSummaryUsage(userId, transcriptId, charCount);
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
    await db.transaction(async (tx) => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId})::bigint)`);
      const [busy] = await tx.select({ id: transcripts.id }).from(transcripts).where(and(eq(transcripts.userId, userId), eq(transcripts.summaryStatus, 'running')));
      if (busy) throw httpError(409, '已有一份纪要正在生成。');
      await tx.update(transcripts).set({ summaryStatus: 'running', summaryError: null, summaryTemplate: template, summaryLanguage: outputLanguage }).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId)));
    });
    void runSummary(userId, transcriptId, template, outputLanguage, apiBase, apiKey, model, provider, entries, summarySourceHash(segments), controller).finally(() => {
      if (inflight.get(userId)?.controller === controller) inflight.delete(userId);
      void maybeRefreshSummary(userId, transcriptId);
    });
    return { status: 'running' as const };
  } catch (error) {
    await refundSummaryUsage(userId, transcriptId);
    if (inflight.get(userId)?.controller === controller) inflight.delete(userId);
    throw error;
  }
}

export async function syncSummaryTasks(transcriptId: string, markdown: string) {
  const items = extractActionItems(markdown);
  const existing = await db.select().from(transcriptTasks).where(eq(transcriptTasks.transcriptId, transcriptId));
  const done = new Set(existing.filter((task) => task.done).map((task) => task.text));
  await db.delete(transcriptTasks).where(eq(transcriptTasks.transcriptId, transcriptId));
  if (!items.length) return;
  await db.insert(transcriptTasks).values(items.map((text, position) => ({ transcriptId, text, done: done.has(text), position })));
}

export async function maybeRefreshSummary(userId: string, transcriptId: string) {
  const [row] = await db.select().from(transcripts).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId)));
  if (!row || row.summaryStatus !== 'ready' || row.summaryEditedAt || !row.summaryTemplate || !row.summaryLanguage) return { refreshed: false as const };
  const segments = await db.select().from(transcriptSegments).where(eq(transcriptSegments.transcriptId, transcriptId));
  if (summarySourceHash(segments) === row.summarySourceHash) return { refreshed: false as const };
  const provider = row.summaryBilling === 'platform' ? 'platform' : 'byok';
  const template = SUMMARY_TEMPLATES.includes(row.summaryTemplate as SummaryTemplate) ? row.summaryTemplate as SummaryTemplate : 'meeting';
  try {
    await startSummary(userId, transcriptId, template, row.summaryLanguage, provider);
    return { refreshed: true as const };
  } catch (error) {
    const message = error instanceof Error ? error.message : '总结失败。';
    await db.update(transcripts).set({ summaryError: message }).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), eq(transcripts.summaryStatus, 'ready')));
    return { refreshed: false as const, message };
  }
}

export async function cancelSummary(userId: string, transcriptId: string) {
  const job = inflight.get(userId);
  if (job?.transcriptId === transcriptId) job.controller.abort();
  else await refundSummaryUsage(userId, transcriptId);
  const [updated] = await db.update(transcripts).set({ summaryStatus: 'cancelling' }).where(and(eq(transcripts.id, transcriptId), eq(transcripts.userId, userId), eq(transcripts.summaryStatus, 'running'))).returning({ id: transcripts.id });
  if (!updated && job?.transcriptId !== transcriptId) return { status: 'idle' as const };
  return { status: 'cancelling' as const };
}
