import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  billableSecondsFromCheckpoint,
  captureLossFromSignals,
  checkpointFailureAction,
  citationState,
  classCoverage,
  CLASS_EXAMPLE_SECONDS,
  mergePersistedSegments,
  parseSafeMarkdown,
  percentile,
  purgeDue,
  quoteMatches,
  renderMathPlain,
  sanitizeEventProps,
  sanitizeModelMarkdown,
  sessionOutcome,
  sharesRevivedOnRestore,
  shouldRecordReconnectGap,
  shouldRecoverSession,
  sourceHash,
  summarizeProductMetrics,
  summaryInputHash,
  summaryRefreshAction,
  TRASH_RETAIN_MS,
  PLANS
} from '@linguaflow/shared';

const id = '11111111-1111-4111-8111-111111111111';

test('checkpoint billing ignores the cleanup clock and keeps the session cap', () => {
  const started = Date.parse('2026-10-11T08:00:00Z');
  const activeUntil = started + 10_000;
  const hoursLater = started + 5 * 60 * 60 * 1000;
  assert.equal(billableSecondsFromCheckpoint({
    startedAtMs: started,
    activeUntilMs: activeUntil,
    audioMs: 4_000,
    maxSessionSeconds: 90 * 60,
    reservedSeconds: 90 * 60,
    nowMs: hoursLater
  }), 10);
  assert.equal(billableSecondsFromCheckpoint({
    startedAtMs: started,
    activeUntilMs: started + 3 * 60 * 60 * 1000,
    audioMs: 1_000,
    maxSessionSeconds: 15 * 60,
    reservedSeconds: 15 * 60,
    nowMs: hoursLater
  }), 15 * 60);
});

test('a fresh heartbeat is left alone and a dead owner is recoverable', () => {
  const now = 1_000_000;
  assert.equal(shouldRecoverSession({ endedAtMs: null, status: 'active', ownerHeartbeatMs: now - 1_000, nowMs: now, hasLiveRoom: false }), false);
  assert.equal(shouldRecoverSession({ endedAtMs: null, status: 'active', ownerHeartbeatMs: now - 50_000, nowMs: now, hasLiveRoom: false }), true);
  assert.equal(shouldRecoverSession({ endedAtMs: null, status: 'active', ownerHeartbeatMs: now - 50_000, nowMs: now, hasLiveRoom: true }), false);
  assert.equal(shouldRecoverSession({ endedAtMs: now, status: 'active', ownerHeartbeatMs: null, nowMs: now, hasLiveRoom: false }), false);
});

test('segment ids survive a late translation and a replay', () => {
  const first = mergePersistedSegments([], [{ source: '积分', translation: '', speaker: '1', startMs: 1000, endMs: 1500, interim: false }], () => id);
  const late = mergePersistedSegments(first, [{ source: '积分', translation: 'integral', speaker: '1', startMs: 1000, endMs: 1600, interim: false }], () => '22222222-2222-4222-8222-222222222222');
  assert.equal(late[0]?.id, id);
  assert.equal(late[0]?.translation, 'integral');
  assert.equal(late.length, 1);
  const replay = mergePersistedSegments(late, [{ source: '积分', translation: 'integral', startMs: 1000, endMs: 1600, interim: false }], () => '33333333-3333-4333-8333-333333333333');
  assert.equal(replay[0]?.id, id);
});

test('an interim token is not stored as a final segment', () => {
  const stored = mergePersistedSegments([], [{ source: '还在说', translation: '', startMs: 1, endMs: 2, interim: true }], () => id);
  assert.equal(stored.length, 0);
});

test('summary edits are marked stale and do not imply a model call', () => {
  const before = summaryInputHash([{ id, idx: 1, speaker: '老师', startMs: 1, sourceText: '不是', translationText: 'no' }]);
  const same = summaryInputHash([{ id, idx: 1, startMs: 1, speaker: '老师', sourceText: '不是', translationText: 'no' }]);
  const changed = summaryInputHash([{ id, idx: 1, speaker: '老师', startMs: 1, sourceText: '不是', translationText: 'not' }]);
  assert.equal(before, same);
  assert.equal(summaryRefreshAction(before, same), 'unchanged');
  assert.equal(summaryRefreshAction(before, changed), 'mark_stale');
});

test('a quote is bound to the input, provider, and price', () => {
  const quote = { provider: 'platform' as const, seconds: 60, inputHash: 'abc', inputVersion: 2, template: 'classroom' as const };
  assert.equal(quoteMatches(quote, { ...quote }), true);
  assert.equal(quoteMatches(quote, { ...quote, seconds: 120 }), false);
  assert.equal(quoteMatches(quote, { ...quote, provider: 'byok', seconds: 0 }), false);
});

test('citations and unsafe markup cannot point at or run foreign content', () => {
  const other = '22222222-2222-4222-8222-222222222222';
  const clean = sanitizeModelMarkdown(`<script>alert(1)</script>[点我](javascript:alert(1)) [[seg:${id}]] [[seg:${other}]]`, new Set([id]), { [id]: sourceHash('原词') }, { [id]: '改过' });
  assert.equal(clean.includes('script'), false);
  assert.equal(clean.includes('javascript:'), false);
  assert.match(clean, /来源已变化/);
  assert.match(clean, /来源不可用/);
  assert.equal(citationState(id, sourceHash('原词'), undefined), 'missing');
  const blocks = parseSafeMarkdown(clean, () => 'changed');
  assert.equal(JSON.stringify(blocks).includes('javascript:'), false);
  const math = renderMathPlain('\\frac{1}{2}+x^{2}');
  assert.match(math.text, /1/);
  assert.match(math.text, /2/);
  const broken = renderMathPlain('\\unknown{x}');
  assert.equal(broken.ok, false);
  assert.match(broken.text, /unknown/);
});

test('short replay is not a gap, and silence is not loss', () => {
  assert.equal(shouldRecordReconnectGap(0), false);
  assert.equal(shouldRecordReconnectGap(800), true);
  assert.equal(captureLossFromSignals({ latencyMs: 4000, captionCount: 0, quiet: true, droppedMs: 0 }), null);
  assert.equal(captureLossFromSignals({ latencyMs: null, captionCount: 3, quiet: false, droppedMs: 500 })?.source, 'queue_overflow');
});

test('trash restore does not revive shares and purge waits seven days', () => {
  assert.equal(sharesRevivedOnRestore(), false);
  const deleted = Date.parse('2026-10-01T00:00:00Z');
  assert.equal(purgeDue(deleted + TRASH_RETAIN_MS, deleted + TRASH_RETAIN_MS - 1), false);
  assert.equal(purgeDue(deleted + TRASH_RETAIN_MS, deleted + TRASH_RETAIN_MS), true);
});

test('session outcomes stay distinct', () => {
  assert.equal(sessionOutcome({ recordStatus: 'complete', saveState: 'saved', transcriptId: id }), 'saved');
  assert.equal(sessionOutcome({ recordStatus: null, saveState: 'saved', transcriptId: null }), 'empty');
  assert.equal(sessionOutcome({ recordStatus: 'incomplete', saveState: 'saved', transcriptId: id }), 'partial');
  assert.equal(sessionOutcome({ recordStatus: null, saveState: 'failed', transcriptId: null }), 'failed');
});

test('checkpoint failure stops capture without pretending the write succeeded', () => {
  assert.equal(checkpointFailureAction(1, 1_000), 'retry');
  assert.equal(checkpointFailureAction(3, 1_000), 'stop');
  assert.equal(checkpointFailureAction(1, 15_000), 'stop');
});

test('class coverage comes from the existing plan table', () => {
  assert.equal(classCoverage(PLANS.plus).classes, Math.floor((PLANS.plus.monthlySeconds ?? 0) / CLASS_EXAMPLE_SECONDS));
  assert.equal(classCoverage(PLANS.free).sessionFits, false);
  assert.equal(classCoverage(PLANS.ultra).classes, null);
});

test('events drop caption text and repeated keys do not add a second success', () => {
  assert.deepEqual(sanitizeEventProps({ sessionId: id, sourceText: '秘密字幕', recognitionP50: 120 }), { sessionId: id, recognitionP50: 120 });
  const metrics = summarizeProductMetrics([
    { name: 'session_start_attempted', createdAtMs: 10, props: {} },
    { name: 'session_start_attempted', createdAtMs: 10, props: {} },
    { name: 'session_ready', createdAtMs: 11, props: {} },
    { name: 'record_finished', createdAtMs: 12, props: {} },
    { name: 'latency_sample', createdAtMs: 13, props: { recognitionP50: 100, recognitionP95: 180, translationP50: 140, translationP95: 220, samples: 4 } }
  ], 0, 100);
  assert.equal(metrics.empty, false);
  assert.equal(metrics.counts.attempted, 2);
  assert.equal(metrics.latency.samples, 4);
  assert.equal(percentile([10, 20, 30, 40], 0.5), 20);
  assert.equal(summarizeProductMetrics([], 0, 100).empty, true);
});

test('a killed process leaves a wav whose header matches the intact samples', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'linguaflow-wav-'));
  const user = '11111111-1111-4111-8111-111111111111';
  const session = '22222222-2222-4222-8222-222222222222';
  const relative = `${user}/${session}.wav`;
  const full = path.join(root, relative);
  const child = spawn(process.execPath, ['-e', `
    const fs = require('node:fs');
    const path = require('node:path');
    const full = process.argv[1];
    fs.mkdirSync(path.dirname(full), { recursive: true });
    const header = Buffer.alloc(44);
    header.write('RIFF', 0);
    header.writeUInt32LE(36, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(16000, 24);
    header.writeUInt32LE(32000, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(0, 40);
    fs.writeFileSync(full, Buffer.concat([header, Buffer.from([1, 2, 3, 4, 5])]));
    setInterval(() => {}, 1000);
  `, full], { stdio: 'ignore' });
  const deadline = Date.now() + 3_000;
  while (Date.now() < deadline) {
    const info = await stat(full).catch(() => null);
    if (info && info.size >= 49) break;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  child.kill('SIGKILL');
  await new Promise((resolve) => child.once('exit', resolve));
  const { repairWavAbsolute } = await import('../src/realtime/wav-repair.ts');
  const repaired = await repairWavAbsolute(full);
  assert.equal(repaired?.pcmBytes, 4);
  const bytes = await readFile(full);
  assert.equal(bytes.readUInt32LE(40), 4);
  assert.equal(bytes.length, 48);
  assert.equal((await stat(full)).size, 48);
  await rm(root, { recursive: true, force: true });
});
