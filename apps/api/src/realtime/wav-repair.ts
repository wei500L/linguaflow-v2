import { open, stat } from 'node:fs/promises';
import { repairedPcmLength } from '@linguaflow/shared';
import { resolveRecording } from '../lib/recordings.js';
import { wavHeader } from './recorder.js';

export async function repairWavAbsolute(full: string) {
  const info = await stat(full).catch(() => null);
  if (!info) return null;
  const pcmBytes = repairedPcmLength(info.size);
  const handle = await open(full, 'r+');
  try {
    if (info.size !== 44 + pcmBytes) await handle.truncate(44 + pcmBytes);
    await handle.write(wavHeader(pcmBytes), 0, 44, 0);
  } finally {
    await handle.close();
  }
  return { pcmBytes, bytes: 44 + pcmBytes, durationMs: Math.round((pcmBytes / 2 / 16000) * 1000) };
}

/** Rewrite a crashed WAV header from the bytes actually on disk and drop a trailing partial sample. */
export async function repairWavFile(relPath: string) {
  const full = resolveRecording(relPath);
  if (!full) return null;
  return repairWavAbsolute(full);
}
