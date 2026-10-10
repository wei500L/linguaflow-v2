import crypto from 'node:crypto';
import { z } from 'zod';
import { canonicalEmail } from './email.js';
import { emailDomain, isCustomReferralDomain, isDisposableDomain } from './referral-risk.js';

/* User-Agent, UI language and timezone stay out of the hash. A browser upgrade,
   a language toggle, or a clock-zone change would otherwise look like a new
   device and reset the free quota. */
const deviceSignalSchema = z.object({
  deviceId: z.string().uuid(),
  screen: z.string().trim().min(1).max(40),
  cores: z.number().int().min(0).max(512),
  memory: z.number().min(0).max(1024).nullable(),
  touch: z.number().int().min(0).max(64),
  platform: z.string().trim().max(80),
  timezone: z.string().trim().max(80),
  webgl: z.string().trim().max(200),
  canvas: z.string().trim().min(8).max(128)
});

export type DeviceSignals = z.infer<typeof deviceSignalSchema>;
export type DeviceRef = { fingerprintHash: string; deviceId: string; strong?: boolean };
export type DeviceClaimView = { userId: string; releasedAt: Date | null; key?: string; claimedAt?: Date | null };

export function claimBlocks(claim: DeviceClaimView, userId: string, now = new Date()) {
  if (claim.releasedAt || claim.userId === userId) return false;
  if (claim.key?.startsWith('ip:')) {
    const at = claim.claimedAt?.getTime();
    if (at == null) return true;
    return now.getTime() - at < FREE_IP_WINDOW_MS;
  }
  return true;
}

export function serverClaimKeys(input: { signupIp?: string | null; email?: string | null }) {
  const keys: string[] = [];
  const ip = input.signupIp ? normalizeIp(input.signupIp) : '';
  if (ip) keys.push(`ip:${crypto.createHash('sha256').update(ip).digest('hex')}`);
  const domain = emailDomain(input.email ? canonicalEmail(input.email) : '');
  if (domain && (isDisposableDomain(domain) || isCustomReferralDomain(domain))) keys.push(`dom:${domain}`);
  return keys;
}

export const freeDeviceBlockedMessage = '浏览器指纹不能单独防止多开。这台设备，或同一网络上短时间内注册的新免费账号，已经使用过免费额度。开通套餐后可以继续使用。';
export const FREE_IP_WINDOW_MS = 24 * 60 * 60 * 1000;
export const deviceRequiredMessage = '无法识别这台设备，请刷新页面后再试。';

/* Portrait and landscape report the same screen with the axes swapped.
   Keeping the raw order made one phone look like two browsers. */
export function canonicalScreen(screen: string) {
  const match = /^(\d+)x(\d+)x(\d+)$/.exec(screen.trim());
  if (!match) return screen.trim();
  const width = Number(match[1]);
  const height = Number(match[2]);
  const [shorter, longer] = width < height ? [width, height] : [height, width];
  return `${shorter}x${longer}x${match[3]}`;
}

export function fingerprintMaterial(signals: DeviceSignals) {
  return [
    canonicalScreen(signals.screen),
    String(signals.cores),
    signals.memory === null ? '' : String(signals.memory),
    String(signals.touch),
    signals.platform,
    signals.webgl,
    signals.canvas
  ].join('\n');
}

export function fingerprintHash(signals: DeviceSignals) {
  return crypto.createHash('sha256').update(fingerprintMaterial(signals)).digest('hex');
}

export const fingerprintKey = (hash: string) => `fp:${hash}`;
export const deviceKey = (deviceId: string) => `dev:${deviceId}`;
export const isStrongCanvas = (canvas: string) => canvas !== 'no-canvas' && canvas !== 'canvas-error';
/* A failed canvas read is shared by many browsers. Only the local device id
   is enforced then, so one blocked phone does not lock out everyone else. */
export const claimKeys = (hash: string, deviceId: string, strong = true) => strong ? [fingerprintKey(hash), deviceKey(deviceId)] : [deviceKey(deviceId)];

export function freeDeviceDecision(input: {
  plan: string;
  userId: string;
  hasDevice: boolean;
  claims: DeviceClaimView[];
  now?: Date;
}): { ok: true } | { ok: false; code: 'free_device_blocked' | 'device_required' } {
  if (input.plan !== 'free') return { ok: true };
  if (!input.hasDevice) return { ok: false, code: 'device_required' };
  const blocked = input.claims.some((claim) => claimBlocks(claim, input.userId, input.now));
  return blocked ? { ok: false, code: 'free_device_blocked' } : { ok: true };
}

function decodeDeviceHeader(value: string) {
  const trimmed = value.trim();
  if (trimmed.startsWith('{')) return trimmed;
  try {
    const padded = trimmed.replace(/-/g, '+').replace(/_/g, '/');
    const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
    return Buffer.from(padded + pad, 'base64').toString('utf8');
  } catch {
    return trimmed;
  }
}

export function parseDeviceHeader(value: string | string[] | undefined): DeviceSignals | null {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw || raw.length > 4096) return null;
  try {
    const parsed = deviceSignalSchema.safeParse(JSON.parse(decodeDeviceHeader(raw)));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export function normalizeIp(value: string) {
  let ip = value.trim();
  if (!ip || ip.toLowerCase() === 'unknown') return '';
  if (ip.toLowerCase().startsWith('::ffff:')) ip = ip.slice(7);
  if (ip.startsWith('[') && ip.includes(']')) ip = ip.slice(1, ip.indexOf(']'));
  const zone = ip.indexOf('%');
  if (zone !== -1) ip = ip.slice(0, zone);
  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(ip)) ip = ip.slice(0, ip.lastIndexOf(':'));
  return ip;
}

/* Only addresses that belong to this process's own proxies. A visitor on a
   home router is 192.168.x and must not be skipped, or their forged
   X-Forwarded-For would replace the real address. */
export function isTrustedProxy(value: string) {
  const ip = normalizeIp(value).toLowerCase();
  if (!ip) return false;
  if (ip === '127.0.0.1' || ip === '::1') return true;
  if (ip.startsWith('fe80:') || /^f[cd][0-9a-f]*:/i.test(ip)) return true;
  const parts = ip.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  return parts[0] === 172 && parts[1] >= 16 && parts[1] <= 31;
}

/* Walk from the TCP peer toward the left of X-Forwarded-For and stop at the
   first address that is not one of our proxies. The leftmost value is whatever
   the client typed, so it cannot be the source of truth. */
export function clientAddress(headers: Record<string, string | string[] | undefined>, socketAddr = '') {
  const forwarded = headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded.join(',') : forwarded;
  const forwardedHops = (raw ?? '').split(',').map(normalizeIp).filter(Boolean).reverse();
  const chain = [normalizeIp(socketAddr), ...forwardedHops].filter(Boolean);
  let chosen = chain[0] ?? '';
  for (const hop of chain) {
    chosen = hop;
    if (!isTrustedProxy(hop)) break;
  }
  return chosen.slice(0, 64) || null;
}

export function clientUserAgent(headers: Record<string, string | string[] | undefined>) {
  const header = headers['user-agent'];
  const raw = Array.isArray(header) ? header[0] : header;
  return raw?.slice(0, 300) ?? null;
}
