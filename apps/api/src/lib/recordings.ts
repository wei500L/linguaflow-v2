import { readdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { config } from '../config.js';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const relativePattern = new RegExp(`^${uuid}/${uuid}\\.(mp3|wav)$`, 'i');

export function isUuid(value: string) {
  return new RegExp(`^${uuid}$`, 'i').test(value);
}

export function recordingRelative(userId: string, sessionId: string, ext: 'mp3' | 'wav') {
  if (!isUuid(userId) || !isUuid(sessionId)) throw new Error('Invalid recording path');
  return `${userId}/${sessionId}.${ext}`;
}

export function resolveRecording(relPath: string) {
  if (!relativePattern.test(relPath)) return null;
  const root = path.resolve(config.recordingsDir);
  const full = path.resolve(root, relPath);
  if (full !== root && !full.startsWith(`${root}${path.sep}`)) return null;
  return full;
}

const liveRecordings = new Set<string>();
export function markLiveRecording(relPath: string) { liveRecordings.add(relPath); }
export function unmarkLiveRecording(relPath: string) { liveRecordings.delete(relPath); }

export async function sweepOrphanRecordings(referenced: Iterable<string>) {
  const keep = new Set([...referenced, ...liveRecordings]);
  const cutoff = Date.now() - 60 * 60 * 1000;
  const users = await readdir(config.recordingsDir).catch(() => [] as string[]);
  for (const user of users) {
    if (!isUuid(user)) continue;
    const dir = path.join(config.recordingsDir, user);
    const files = await readdir(dir).catch(() => [] as string[]);
    for (const file of files) {
      const rel = `${user}/${file}`;
      const normalized = rel.replace(/\.tmp$/i, '');
      if (keep.has(rel) || keep.has(normalized)) continue;
      if (!relativePattern.test(normalized)) continue;
      const full = path.join(dir, file);
      const info = await stat(full).catch(() => null);
      if (!info || info.mtimeMs > cutoff) continue;
      await rm(full, { force: true });
    }
  }
}

export async function removeRecording(relPath: string | null | undefined) {
  if (!relPath) return;
  const full = resolveRecording(relPath);
  if (!full) return;
  await rm(full, { force: true });
  const tmp = full.endsWith('.mp3') ? `${full}.tmp` : null;
  if (tmp) await rm(tmp, { force: true });
}
