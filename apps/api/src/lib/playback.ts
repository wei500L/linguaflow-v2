import crypto from 'node:crypto';
import { config } from '../config.js';

const ttlMs = 30 * 60 * 1000;

export function signAudioPlayback(transcriptId: string, userId: string, now = Date.now()) {
  const exp = now + ttlMs;
  const payload = `${transcriptId}.${userId}.${exp}`;
  const sig = crypto.createHmac('sha256', config.jwtSecret).update(payload).digest('base64url');
  return `${payload}.${sig}`;
}

export function verifyAudioPlayback(token: string, transcriptId: string, now = Date.now()) {
  const parts = token.split('.');
  if (parts.length !== 4) return null;
  const [id, userId, expText, sig] = parts;
  if (!id || !userId || !expText || !sig || id !== transcriptId) return null;
  const exp = Number(expText);
  if (!Number.isFinite(exp) || exp < now) return null;
  const expected = crypto.createHmac('sha256', config.jwtSecret).update(`${id}.${userId}.${expText}`).digest('base64url');
  const left = Buffer.from(sig);
  const right = Buffer.from(expected);
  if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) return null;
  return userId;
}
