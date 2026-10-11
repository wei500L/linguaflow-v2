export const CONTROL_BATCH_SIZE = 40;

export type ControlEntry = { payload: Record<string, unknown>; label: string };
export type ControlQueue = Map<string, ControlEntry[]>;
export type ControlPoster = (sessionId: string, items: Array<Record<string, unknown>>) => Promise<{ saved?: string[] }>;

export function createControlQueue(): ControlQueue {
  return new Map();
}

export function controlEntryId(entry: ControlEntry) {
  return typeof entry.payload.id === 'string' ? entry.payload.id : null;
}

export function enqueueControls(queue: ControlQueue, sessionId: string, entries: ControlEntry[]) {
  if (!sessionId || !entries.length) return;
  const existing = queue.get(sessionId) ?? [];
  const seen = new Set(existing.map(controlEntryId).filter((id): id is string => Boolean(id)));
  const next = [...existing];
  for (const entry of entries) {
    const id = controlEntryId(entry);
    if (id && seen.has(id)) continue;
    if (id) seen.add(id);
    next.push(entry);
  }
  queue.set(sessionId, next);
}

export function acknowledgeControls(queue: ControlQueue, sessionId: string, savedIds: ReadonlySet<string>) {
  const existing = queue.get(sessionId);
  if (!existing || !savedIds.size) return;
  const left = existing.filter((entry) => {
    const id = controlEntryId(entry);
    return !id || !savedIds.has(id);
  });
  if (left.length) queue.set(sessionId, left);
  else queue.delete(sessionId);
}

export function pendingControlMessage(queue: ControlQueue) {
  const groups = [...queue.entries()].filter(([, entries]) => entries.length > 0);
  const count = groups.reduce((sum, [, entries]) => sum + entries.length, 0);
  if (!count) return null;
  const detail = groups.map(([sessionId, entries]) => `${sessionId}：${entries.map((entry) => entry.label).join('、')}`).join('；');
  return { count: String(count), detail };
}

function claim(queue: ControlQueue, sessionId: string, inFlight: Map<string, Set<string>>, limit: number) {
  const flying = inFlight.get(sessionId) ?? new Set<string>();
  inFlight.set(sessionId, flying);
  const batch: ControlEntry[] = [];
  for (const entry of queue.get(sessionId) ?? []) {
    const id = controlEntryId(entry);
    if (id && flying.has(id)) continue;
    if (id) flying.add(id);
    batch.push(entry);
    if (batch.length >= limit) break;
  }
  return batch;
}

function release(inFlight: Map<string, Set<string>>, sessionId: string, entries: ControlEntry[]) {
  const flying = inFlight.get(sessionId);
  if (!flying) return;
  for (const entry of entries) {
    const id = controlEntryId(entry);
    if (id) flying.delete(id);
  }
  if (!flying.size) inFlight.delete(sessionId);
}

export async function postControlBatches(input: {
  sessionId: string;
  entries: ControlEntry[];
  post: ControlPoster;
  onConfirmed: (savedIds: Set<string>) => void;
  batchSize?: number;
}) {
  const batchSize = input.batchSize ?? CONTROL_BATCH_SIZE;
  for (let index = 0; index < input.entries.length; index += batchSize) {
    const batch = input.entries.slice(index, index + batchSize);
    const saved = await input.post(input.sessionId, batch.map((entry) => entry.payload));
    input.onConfirmed(new Set(saved.saved ?? []));
  }
}

async function flushSession(queue: ControlQueue, sessionId: string, post: ControlPoster, inFlight: Map<string, Set<string>>, batchSize: number) {
  while (true) {
    const batch = claim(queue, sessionId, inFlight, batchSize);
    if (!batch.length) return;
    try {
      const saved = await post(sessionId, batch.map((entry) => entry.payload));
      const savedIds = new Set(saved.saved ?? []);
      acknowledgeControls(queue, sessionId, savedIds);
      release(inFlight, sessionId, batch);
      const ids = batch.map(controlEntryId).filter((id): id is string => Boolean(id));
      if (!ids.length || ids.some((id) => !savedIds.has(id))) return;
    } catch (error) {
      release(inFlight, sessionId, batch);
      throw error;
    }
  }
}

export async function flushControlQueue(input: {
  queue: ControlQueue;
  post: ControlPoster;
  inFlight?: Map<string, Set<string>>;
  batchSize?: number;
}) {
  const inFlight = input.inFlight ?? new Map<string, Set<string>>();
  const batchSize = input.batchSize ?? CONTROL_BATCH_SIZE;
  const failedSessions: string[] = [];
  for (const sessionId of [...input.queue.keys()]) {
    try {
      await flushSession(input.queue, sessionId, input.post, inFlight, batchSize);
    } catch {
      failedSessions.push(sessionId);
    }
  }
  return { failedSessions };
}
