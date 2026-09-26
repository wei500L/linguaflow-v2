import { spawn } from 'node:child_process';
import { mkdir, open, rm, stat } from 'node:fs/promises';
import path from 'node:path';
import { markLiveRecording, recordingRelative, resolveRecording, unmarkLiveRecording } from '../lib/recordings.js';

export type RecordingArtifact = {
  relPath: string | null;
  status: 'none' | 'encoding' | 'ready' | 'failed';
  format: 'mp3' | 'wav' | null;
  bytes: number | null;
  durationMs: number | null;
  error: string | null;
};

const empty = (status: RecordingArtifact['status'], error: string | null): RecordingArtifact => ({
  relPath: null, status, format: null, bytes: null, durationMs: null, error
});

export function wavHeader(dataLength: number) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0);
  header.writeUInt32LE(36 + dataLength, 4);
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
  header.writeUInt32LE(dataLength, 40);
  return header;
}

export function transcodeWav(wavPath: string, mp3Path: string, timeoutMs = 10 * 60 * 1000) {
  return new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-i', wavPath, '-codec:a', 'libmp3lame', '-b:a', '64k', '-f', 'mp3', mp3Path], { stdio: 'ignore' });
    const timer = setTimeout(() => { proc.kill('SIGKILL'); reject(new Error('ffmpeg timed out')); }, timeoutMs);
    proc.on('error', (error) => { clearTimeout(timer); reject(error); });
    proc.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}`));
    });
  });
}

export class SessionRecorder {
  private handle: Awaited<ReturnType<typeof open>> | null = null;
  private chain: Promise<void> = Promise.resolve();
  private bytes = 0;
  private stopped = false;
  private failed: string | null = null;
  private readonly wavPath: string;

  constructor(private readonly userId: string, private readonly sessionId: string) {
    const full = resolveRecording(recordingRelative(userId, sessionId, 'wav'));
    if (!full) throw new Error('Invalid recording path');
    this.wavPath = full;
  }

  async open() {
    await mkdir(path.dirname(this.wavPath), { recursive: true });
    this.handle = await open(this.wavPath, 'w');
    await this.handle.write(wavHeader(0));
    markLiveRecording(recordingRelative(this.userId, this.sessionId, 'wav'));
  }

  push(chunk: Buffer) {
    if (this.stopped || !this.handle || chunk.length === 0) return;
    const copy = Buffer.from(chunk);
    const handle = this.handle;
    this.chain = this.chain.then(async () => {
      await handle.write(copy);
      this.bytes += copy.length;
    }).catch((error: unknown) => {
      this.failed = error instanceof Error ? error.message : 'Recording write failed.';
    });
  }

  async finish(): Promise<RecordingArtifact> {
    const wavRel = recordingRelative(this.userId, this.sessionId, 'wav');
    this.stopped = true;
    try {
      await this.chain;
      if (this.handle) {
        if (this.bytes % 2) {
          this.bytes -= 1;
          await this.handle.truncate(44 + this.bytes);
        }
        await this.handle.write(wavHeader(this.bytes), 0, 44, 0);
        await this.handle.close();
        this.handle = null;
      }
      if (this.bytes < 2) {
        await rm(this.wavPath, { force: true });
        return empty(this.failed ? 'failed' : 'none', this.failed);
      }
      const info = await stat(this.wavPath);
      return {
        relPath: wavRel,
        status: 'encoding',
        format: 'wav',
        bytes: info.size,
        durationMs: Math.round((this.bytes / 2 / 16000) * 1000),
        error: null
      };
    } finally {
      unmarkLiveRecording(wavRel);
    }
  }
}
