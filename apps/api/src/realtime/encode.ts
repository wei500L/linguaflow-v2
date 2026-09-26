import { rm, stat } from 'node:fs/promises';
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { transcripts } from '../db/schema.js';
import { resolveRecording } from '../lib/recordings.js';
import { transcodeWav } from './recorder.js';

const pending = new Set<Promise<void>>();

function wavRelative(relPath: string) {
  return relPath.replace(/\.mp3$/i, '.wav');
}

export function scheduleRecordingEncode(transcriptId: string) {
  const job = encodeRecording(transcriptId).finally(() => pending.delete(job));
  pending.add(job);
}

export async function resumeRecordingEncodes() {
  const rows = await db.select({ id: transcripts.id }).from(transcripts).where(eq(transcripts.audioStatus, 'encoding'));
  for (const row of rows) scheduleRecordingEncode(row.id);
}

export async function drainRecordingEncodes(timeoutMs = 15_000) {
  await Promise.race([
    Promise.allSettled([...pending]),
    new Promise((resolve) => setTimeout(resolve, timeoutMs))
  ]);
}

async function encodeRecording(transcriptId: string) {
  const [row] = await db.select().from(transcripts).where(eq(transcripts.id, transcriptId));
  if (!row || row.audioStatus !== 'encoding' || !row.audioRelPath) return;
  const wavRel = wavRelative(row.audioRelPath);
  const mp3Rel = wavRel.replace(/\.wav$/i, '.mp3');
  const wavPath = resolveRecording(wavRel);
  const mp3Path = resolveRecording(mp3Rel);
  if (!wavPath || !mp3Path) return;
  const wavInfo = await stat(wavPath).catch(() => null);
  const mp3Info = await stat(mp3Path).catch(() => null);
  if (!wavInfo && mp3Info) {
    await db.update(transcripts).set({ audioStatus: 'ready', audioFormat: 'mp3', audioRelPath: mp3Rel, audioBytes: mp3Info.size, audioError: null }).where(and(eq(transcripts.id, transcriptId), eq(transcripts.audioStatus, 'encoding')));
    return;
  }
  if (!wavInfo) {
    await db.update(transcripts).set({ audioStatus: 'failed', audioError: '录音文件不存在。' }).where(and(eq(transcripts.id, transcriptId), eq(transcripts.audioStatus, 'encoding')));
    return;
  }
  const tmp = `${mp3Path}.tmp`;
  try {
    await transcodeWav(wavPath, tmp);
    const { rename } = await import('node:fs/promises');
    await rename(tmp, mp3Path);
    await rm(wavPath, { force: true });
    const info = await stat(mp3Path);
    const [updated] = await db.update(transcripts).set({ audioStatus: 'ready', audioFormat: 'mp3', audioRelPath: mp3Rel, audioBytes: info.size, audioError: null }).where(and(eq(transcripts.id, transcriptId), eq(transcripts.audioStatus, 'encoding'))).returning({ id: transcripts.id });
    if (!updated) await rm(mp3Path, { force: true });
  } catch (error) {
    await rm(tmp, { force: true });
    const missing = error instanceof Error && 'code' in error && error.code === 'ENOENT';
    await db.update(transcripts).set({
      audioStatus: 'ready',
      audioFormat: 'wav',
      audioRelPath: wavRel,
      audioBytes: wavInfo.size,
      audioError: missing ? 'ffmpeg 未安装，已保留 WAV' : 'MP3 编码失败，已保留 WAV'
    }).where(and(eq(transcripts.id, transcriptId), eq(transcripts.audioStatus, 'encoding')));
  }
}
