import crypto from 'node:crypto';
import { config } from '../config.js';

function encryptionKey() {
  const material = config.settingsEncryptionKey || config.jwtSecret;
  return crypto.createHash('sha256').update(`linguaflow-settings:${material}`).digest();
}

export function encryptSecret(plain: string) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString('base64url')}.${tag.toString('base64url')}.${data.toString('base64url')}`;
}

export function decryptSecret(payload: string) {
  const [version, iv, tag, data] = payload.split('.');
  if (version !== 'v1' || !iv || !tag || !data) return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', encryptionKey(), Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

export function keyHint(secret: string) {
  const trimmed = secret.trim();
  if (trimmed.length < 8) return '';
  return trimmed.slice(-4);
}
