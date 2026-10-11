import assert from 'node:assert/strict';
import test from 'node:test';
import { acknowledgeControls, createControlQueue, enqueueControls, flushControlQueue, pendingControlMessage, postControlBatches, type ControlEntry } from './control-queue.ts';

const sessionA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const sessionB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const sessionC = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

function entry(id: string, label: string): ControlEntry {
  return { payload: { id, type: 'marker' }, label };
}

function ids(queue: ReturnType<typeof createControlQueue>, sessionId: string) {
  return (queue.get(sessionId) ?? []).map((item) => item.payload.id);
}

test('three failed sessions stay queued and a later retry submits each original session once', async () => {
  const queue = createControlQueue();
  enqueueControls(queue, sessionA, [entry('a1', '标记')]);
  enqueueControls(queue, sessionB, [entry('b1', '缺口')]);
  enqueueControls(queue, sessionC, [entry('c1', '标记')]);
  enqueueControls(queue, sessionA, [entry('a1', '标记')]);
  const calls: Array<{ sessionId: string; ids: string[] }> = [];
  const failed = await flushControlQueue({
    queue,
    post: async () => { throw new Error('offline'); }
  });
  assert.deepEqual(failed.failedSessions, [sessionA, sessionB, sessionC]);
  assert.deepEqual(ids(queue, sessionA), ['a1']);
  const recovered = await flushControlQueue({
    queue,
    post: async (sessionId, items) => {
      calls.push({ sessionId, ids: items.map((item) => String(item.id)) });
      return { saved: items.map((item) => String(item.id)) };
    }
  });
  assert.deepEqual(recovered.failedSessions, []);
  assert.deepEqual(calls, [
    { sessionId: sessionA, ids: ['a1'] },
    { sessionId: sessionB, ids: ['b1'] },
    { sessionId: sessionC, ids: ['c1'] }
  ]);
  assert.equal(queue.size, 0);
});

test('a late acknowledgement removes only the session and ids that succeeded', async () => {
  const queue = createControlQueue();
  enqueueControls(queue, sessionA, [entry('a1', '标记')]);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const flushing = flushControlQueue({
    queue,
    post: async (sessionId, items) => {
      if (sessionId === sessionA) {
        enqueueControls(queue, sessionB, [entry('b1', '主动暂停')]);
        await gate;
      }
      return { saved: items.map((item) => String(item.id)) };
    }
  });
  release();
  await flushing;
  assert.equal(queue.has(sessionA), false);
  assert.deepEqual(ids(queue, sessionB), ['b1']);
  const pending = pendingControlMessage(queue);
  assert.match(pending?.detail ?? '', new RegExp(sessionB));
  assert.match(pending?.detail ?? '', /主动暂停/);
  assert.equal(pending?.detail.includes(sessionA), false);
});

test('an older success does not drop a message added while that request was in flight', async () => {
  const queue = createControlQueue();
  enqueueControls(queue, sessionA, [entry('a-old', '标记')]);
  const calls: string[][] = [];
  await flushControlQueue({
    queue,
    post: async (_sessionId, items) => {
      const batch = items.map((item) => String(item.id));
      calls.push(batch);
      if (batch.includes('a-old')) enqueueControls(queue, sessionA, [entry('a-new', '缺口')]);
      return { saved: batch };
    }
  });
  assert.deepEqual(calls[0], ['a-old']);
  assert.equal(calls[0]?.includes('a-new'), false);
  assert.ok(calls.some((batch) => batch.includes('a-new')));
  assert.equal(queue.size, 0);
});

test('the first batch of 40 is confirmed when the next batch fails', async () => {
  const queue = createControlQueue();
  const entries = Array.from({ length: 41 }, (_item, index) => entry(`m${index}`, '标记'));
  enqueueControls(queue, sessionA, entries);
  let calls = 0;
  const result = await flushControlQueue({
    queue,
    post: async (_sessionId, items) => {
      calls += 1;
      if (calls === 1) {
        assert.equal(items.length, 40);
        return { saved: items.map((item) => String(item.id)) };
      }
      throw new Error('batch failed');
    }
  });
  assert.deepEqual(result.failedSessions, [sessionA]);
  assert.deepEqual(ids(queue, sessionA), ['m40']);
});

test('a retry already in flight does not send the same ids again', async () => {
  const queue = createControlQueue();
  const inFlight = new Map<string, Set<string>>();
  enqueueControls(queue, sessionA, [entry('a1', '标记')]);
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let posts = 0;
  const first = flushControlQueue({
    queue,
    inFlight,
    post: async () => {
      posts += 1;
      await gate;
      return { saved: ['a1'] };
    }
  });
  const second = await flushControlQueue({
    queue,
    inFlight,
    post: async () => {
      posts += 1;
      return { saved: ['a1'] };
    }
  });
  assert.deepEqual(second.failedSessions, []);
  release();
  await first;
  assert.equal(posts, 1);
  assert.equal(queue.size, 0);
});

test('confirmed ids in an earlier batch stay confirmed when a later batch throws', async () => {
  const entries = [entry('p1', '标记'), entry('p2', '缺口')];
  const removed: string[] = [];
  await assert.rejects(() => postControlBatches({
    sessionId: sessionA,
    entries,
    batchSize: 1,
    post: async (_sessionId, items) => {
      if (items[0]?.id === 'p2') throw new Error('second batch');
      return { saved: ['p1'] };
    },
    onConfirmed: (savedIds) => { for (const id of savedIds) removed.push(id); }
  }));
  assert.deepEqual(removed, ['p1']);
});

test('acknowledgement of one session leaves the other session in place', () => {
  const queue = createControlQueue();
  enqueueControls(queue, sessionA, [entry('a1', '标记')]);
  enqueueControls(queue, sessionB, [entry('b1', '缺口')]);
  acknowledgeControls(queue, sessionA, new Set(['a1']));
  assert.equal(queue.has(sessionA), false);
  assert.deepEqual(ids(queue, sessionB), ['b1']);
});
