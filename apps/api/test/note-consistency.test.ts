import assert from 'node:assert/strict';
import test from 'node:test';
import { citationState, sourceHash } from '@linguaflow/shared';
import { commitFinishedSummary, restoreNoteVersion, saveHumanNote } from '../src/summary/jobs.ts';
import { createMemoryDb, type MemoryRows } from './memory-db.ts';

const userId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const transcriptId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const versionId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const requestId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const segA = '11111111-1111-4111-8111-111111111111';
const segB = '22222222-2222-4222-8222-222222222222';

function segment(id: string, source: string, idx = 1) {
  return { id, transcriptId, idx, speaker: '老师', startMs: 0, sourceText: source, translationText: '' };
}

function note(overrides: Record<string, unknown> = {}) {
  return {
    id: transcriptId,
    userId,
    summaryMarkdown: `见 [[seg:${segA}]]`,
    summaryStatus: 'ready',
    summaryCitationHashes: {},
    summaryCitationsVerified: false,
    noteEpoch: 1,
    deletedAt: null,
    summaryTemplate: 'classroom',
    summaryLanguage: 'zh',
    summaryBilling: 'byok',
    summarySourceHash: 'src',
    summaryInputVersion: 1,
    ...overrides
  };
}

function database(seed: MemoryRows, fail: { op: 'insert' | 'delete'; table: string } | null = null) {
  return createMemoryDb(seed, fail);
}

test('a cosmetic edit does not promote an unknown citation', async () => {
  const memory = database({
    transcripts: [note()],
    transcript_segments: [segment(segA, '原句')],
    transcript_tasks: [],
    note_versions: []
  });
  const saved = await saveHumanNote(userId, transcriptId, `见 [[seg:${segA}]]\n`, memory.db as never);
  assert.ok(saved);
  const row = memory.state.transcripts[0];
  assert.equal(row?.summaryCitationsVerified, false);
  assert.equal((row?.summaryCitationHashes as Record<string, string>)[segA], undefined);
  assert.equal(citationState(segA, (row?.summaryCitationHashes as Record<string, string>)[segA], { source: '原句' }, Boolean(row?.summaryCitationsVerified)), 'unverified');
});

test('an upgraded note with an empty hash map stays unverified after a cosmetic edit', async () => {
  const memory = database({
    transcripts: [note({ summaryCitationsVerified: true, summaryCitationHashes: {} })],
    transcript_segments: [segment(segA, '原句')],
    transcript_tasks: [],
    note_versions: []
  });
  await saveHumanNote(userId, transcriptId, `见 [[seg:${segA}]]\n`, memory.db as never);
  const row = memory.state.transcripts[0];
  const hashes = row?.summaryCitationHashes as Record<string, string>;
  assert.equal(hashes[segA], undefined);
  assert.equal(row?.summaryCitationsVerified, false);
  assert.equal(citationState(segA, hashes[segA], { source: '原句' }, true), 'unverified');
});

test('a newly inserted citation uses the current subtitle, not the old full-input hash', async () => {
  const memory = database({
    transcripts: [note({
      summaryMarkdown: `只引用 [[seg:${segA}]]`,
      summaryCitationHashes: { [segA]: sourceHash('甲'), [segB]: sourceHash('旧乙') },
      summaryCitationsVerified: true
    })],
    transcript_segments: [segment(segA, '甲', 1), segment(segB, '新乙', 2)],
    transcript_tasks: [],
    note_versions: []
  });
  await saveHumanNote(userId, transcriptId, `引用 [[seg:${segA}]] 和 [[seg:${segB}]]`, memory.db as never);
  const hashes = memory.state.transcripts[0]?.summaryCitationHashes as Record<string, string>;
  assert.equal(hashes[segA], sourceHash('甲'));
  assert.equal(hashes[segB], sourceHash('新乙'));
  assert.equal(citationState(segB, hashes[segB], { source: '新乙' }, true), 'ok');
});

test('a second save keeps a known snapshot and leaves an unknown citation unknown', async () => {
  const known = sourceHash('乙');
  const memory = database({
    transcripts: [note({
      summaryMarkdown: `[[seg:${segA}]] [[seg:${segB}]]`,
      summaryCitationHashes: { [segB]: known },
      summaryCitationsVerified: false
    })],
    transcript_segments: [segment(segA, '甲', 1), segment(segB, '乙', 2)],
    transcript_tasks: [],
    note_versions: []
  });
  await saveHumanNote(userId, transcriptId, `[[seg:${segA}]]\n[[seg:${segB}]]`, memory.db as never);
  const segmentB = memory.state.transcript_segments[1];
  if (segmentB) segmentB.sourceText = '乙改了';
  await saveHumanNote(userId, transcriptId, `[[seg:${segA}]] [[seg:${segB}]]。`, memory.db as never);
  const hashes = memory.state.transcripts[0]?.summaryCitationHashes as Record<string, string>;
  assert.equal(hashes[segA], undefined);
  assert.equal(hashes[segB], known);
  assert.equal(memory.state.transcripts[0]?.summaryCitationsVerified, false);
  assert.equal(citationState(segA, hashes[segA], { source: '甲' }, false), 'unverified');
  assert.equal(citationState(segB, hashes[segB], { source: '乙改了' }, false), 'changed');
});

test('editing the note does not clear a citation whose source already changed', async () => {
  const oldHash = sourceHash('旧词');
  const memory = database({
    transcripts: [note({
      summaryMarkdown: `见 [[seg:${segA}]]`,
      summaryCitationHashes: { [segA]: oldHash },
      summaryCitationsVerified: true
    })],
    transcript_segments: [segment(segA, '新词')],
    transcript_tasks: [],
    note_versions: []
  });
  await saveHumanNote(userId, transcriptId, `见，[[seg:${segA}]]`, memory.db as never);
  const hashes = memory.state.transcripts[0]?.summaryCitationHashes as Record<string, string>;
  assert.equal(hashes[segA], oldHash);
  assert.equal(citationState(segA, hashes[segA], { source: '新词' }, true), 'changed');
});

test('restoring an unknown citation and editing it again leaves the citation unknown', async () => {
  const memory = database({
    transcripts: [note({ summaryMarkdown: '当前正文', summaryCitationHashes: { [segA]: sourceHash('原句') }, summaryCitationsVerified: true })],
    transcript_segments: [segment(segA, '原句')],
    transcript_tasks: [{ transcriptId, text: '新任务', done: false, position: 0 }],
    note_versions: [{
      id: versionId,
      transcriptId,
      userId,
      body: `旧正文 [[seg:${segA}]]\n\n## 待办\n- 旧任务`,
      citationHashes: null,
      citationsVerified: false,
      sourceHash: null,
      template: 'classroom',
      outputLanguage: 'zh',
      inputVersion: 1,
      inputHash: null
    }]
  });
  const restored = await restoreNoteVersion(userId, transcriptId, versionId, memory.db as never);
  assert.ok(restored);
  assert.equal(memory.state.transcripts[0]?.summaryCitationsVerified, false);
  assert.deepEqual(memory.state.transcript_tasks.map((task) => task.text), ['旧任务']);
  await saveHumanNote(userId, transcriptId, `旧正文\n[[seg:${segA}]]\n\n## 待办\n- 旧任务`, memory.db as never);
  const hashes = memory.state.transcripts[0]?.summaryCitationHashes as Record<string, string>;
  assert.equal(hashes[segA], undefined);
  assert.equal(citationState(segA, hashes[segA], { source: '原句' }, false), 'unverified');
  assert.equal(memory.state.transcript_tasks.find((task) => task.text === '旧任务')?.done, false);
});

test('a human save keeps done on the same task text', async () => {
  const memory = database({
    transcripts: [note({ summaryMarkdown: '## 待办\n- 复习' })],
    transcript_segments: [segment(segA, '原句')],
    transcript_tasks: [{ transcriptId, text: '复习', done: true, position: 0 }],
    note_versions: []
  });
  await saveHumanNote(userId, transcriptId, `见 [[seg:${segA}]]\n\n## 待办\n- 复习\n- 预习`, memory.db as never);
  const tasks = memory.state.transcript_tasks;
  assert.equal(tasks.find((task) => task.text === '复习')?.done, true);
  assert.equal(tasks.find((task) => task.text === '预习')?.done, false);
});

test('a failed version insert rolls the restored note back', async () => {
  const memory = database({
    transcripts: [note({ summaryMarkdown: '## 待办\n- 新版 B' })],
    transcript_segments: [segment(segA, '原句')],
    transcript_tasks: [{ transcriptId, text: '新版 B', done: false, position: 0 }],
    note_versions: [{ id: versionId, transcriptId, userId, body: '## 待办\n- 旧版 A', citationHashes: null, citationsVerified: false, sourceHash: null }]
  }, { op: 'insert', table: 'note_versions' });
  await assert.rejects(() => restoreNoteVersion(userId, transcriptId, versionId, memory.db as never));
  assert.equal(memory.state.transcripts[0]?.summaryMarkdown, '## 待办\n- 新版 B');
  assert.deepEqual(memory.state.transcript_tasks.map((task) => task.text), ['新版 B']);
  assert.equal(memory.state.note_versions.length, 1);
});

test('a failed task insert rolls the restored note back', async () => {
  const memory = database({
    transcripts: [note({ summaryMarkdown: '## 待办\n- 新版 B' })],
    transcript_segments: [segment(segA, '原句')],
    transcript_tasks: [{ transcriptId, text: '新版 B', done: true, position: 0 }],
    note_versions: [{ id: versionId, transcriptId, userId, body: '## 待办\n- 旧版 A', citationHashes: null, citationsVerified: false, sourceHash: null }]
  }, { op: 'insert', table: 'transcript_tasks' });
  await assert.rejects(() => restoreNoteVersion(userId, transcriptId, versionId, memory.db as never));
  assert.equal(memory.state.transcripts[0]?.summaryMarkdown, '## 待办\n- 新版 B');
  assert.deepEqual(memory.state.transcript_tasks.map((task) => task.text), ['新版 B']);
  assert.equal(memory.state.transcript_tasks[0]?.done, true);
  assert.equal(memory.state.note_versions.length, 1);
});

test('a failed AI task insert does not leave a ready note or a second charge', async () => {
  const memory = database({
    transcripts: [note({ summaryMarkdown: '旧正文', summaryStatus: 'running', noteEpoch: 4 })],
    transcript_segments: [],
    transcript_tasks: [{ transcriptId, text: '旧待办', done: true, position: 0 }],
    note_versions: [],
    usage_ledger: [{ userId, transcriptId, kind: 'summary', status: 'held', requestId, seconds: 60 }],
    summary_requests: [{ id: requestId, userId, transcriptId, status: 'running', noteEpoch: 4 }]
  }, { op: 'insert', table: 'transcript_tasks' });
  await assert.rejects(() => commitFinishedSummary(memory.db as never, {
    userId,
    transcriptId,
    markdown: '## 待办\n- 新待办',
    template: 'classroom',
    outputLanguage: 'zh',
    model: 'fake',
    hash: 'hash-1',
    billing: 'platform',
    epoch: 4,
    requestId,
    citationHashes: {}
  }));
  assert.equal(memory.state.transcripts[0]?.summaryStatus, 'running');
  assert.equal(memory.state.transcripts[0]?.summaryMarkdown, '旧正文');
  assert.equal(memory.state.usage_ledger[0]?.status, 'held');
  assert.equal(memory.state.summary_requests[0]?.status, 'running');
  assert.deepEqual(memory.state.transcript_tasks.map((task) => task.text), ['旧待办']);
  assert.equal(memory.state.note_versions.length, 0);
});

test('a finished summary writes tasks once and a second commit does not settle again', async () => {
  const memory = database({
    transcripts: [note({ summaryMarkdown: '旧正文', summaryStatus: 'running', noteEpoch: 4 })],
    transcript_segments: [],
    transcript_tasks: [{ transcriptId, text: '新待办', done: true, position: 0 }],
    note_versions: [],
    usage_ledger: [{ userId, transcriptId, kind: 'summary', status: 'held', requestId, seconds: 60 }],
    summary_requests: [{ id: requestId, userId, transcriptId, status: 'running', noteEpoch: 4 }]
  });
  const input = {
    userId,
    transcriptId,
    markdown: '## 待办\n- 新待办\n- 另一件',
    template: 'classroom' as const,
    outputLanguage: 'zh',
    model: 'fake',
    hash: 'hash-1',
    billing: 'platform' as const,
    epoch: 4,
    requestId,
    citationHashes: {}
  };
  const first = await commitFinishedSummary(memory.db as never, input);
  assert.ok(first);
  assert.equal(memory.state.transcripts[0]?.summaryStatus, 'ready');
  assert.equal(memory.state.usage_ledger[0]?.status, 'settled');
  assert.equal(memory.state.summary_requests[0]?.status, 'ready');
  assert.equal(memory.state.note_versions.length, 1);
  assert.equal(memory.state.transcript_tasks.find((task) => task.text === '新待办')?.done, true);
  assert.equal(memory.state.transcript_tasks.find((task) => task.text === '另一件')?.done, false);
  const second = await commitFinishedSummary(memory.db as never, input);
  assert.equal(second, null);
  assert.equal(memory.state.note_versions.length, 1);
  assert.equal(memory.state.usage_ledger.filter((row) => row.status === 'settled').length, 1);
  assert.equal(memory.state.usage_ledger.length, 1);
});
