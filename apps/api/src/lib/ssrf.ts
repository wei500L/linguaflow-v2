import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export function normalizeIp(ip: string) {
  const lower = ip.toLowerCase().replace(/^\[|\]$/g, '');
  if (lower.startsWith('::ffff:')) {
    const mapped = lower.slice('::ffff:'.length);
    if (isIP(mapped) === 4) return mapped;
  }
  return lower;
}

export function isLoopbackIp(ip: string) {
  const normalized = normalizeIp(ip);
  return normalized === '::1' || normalized.startsWith('127.');
}

export function isDisallowedIp(ip: string) {
  const normalized = normalizeIp(ip);
  if (normalized.includes(':')) {
    if (normalized === '::' || normalized === '::1') return normalized === '::';
    if (/^f[cd][0-9a-f]{0,2}:/.test(normalized) || normalized === 'fc00::' || normalized === 'fd00::') return true;
    if (/^fe[89ab][0-9a-f]:/.test(normalized)) return true;
    if (normalized.startsWith('ff')) return true;
    return false;
  }
  const parts = normalized.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return true;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return a !== 127;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a >= 224) return true;
  return false;
}

function hostName(url: URL) {
  return url.hostname.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
}

export function isExplicitLoopbackHost(host: string) {
  return host === 'localhost' || host === '::1' || isLoopbackIp(host);
}

export function endpointAllowsMissingKey(apiBase: string) {
  try {
    return isExplicitLoopbackHost(hostName(new URL(apiBase)));
  } catch {
    return false;
  }
}

/** Returns null when the endpoint is allowed. `addresses` are the resolved A/AAAA records. */
export function assessSummaryEndpoint(raw: string, addresses: string[]) {
  let url: URL;
  try { url = new URL(raw); } catch { return 'invalid'; }
  if (url.username || url.password) return 'invalid';
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return 'invalid';
  const host = hostName(url);
  if (!host) return 'invalid';
  const loopback = isExplicitLoopbackHost(host);
  if (url.protocol === 'http:' && !loopback) return 'https-required';
  if (isIP(host)) {
    if (isLoopbackIp(host)) return null;
    return isDisallowedIp(host) ? 'blocked' : null;
  }
  if (loopback) return null;
  if (!addresses.length || addresses.some((address) => isLoopbackIp(address) || isDisallowedIp(address))) return 'blocked';
  return null;
}

export async function resolveEndpointAddresses(raw: string) {
  const url = new URL(raw);
  const host = hostName(url);
  if (isIP(host)) return [host];
  if (host === 'localhost') return ['127.0.0.1'];
  const records = await lookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

export async function assertSummaryEndpoint(raw: string) {
  let addresses: string[] = [];
  try {
    addresses = await resolveEndpointAddresses(raw);
  } catch {
    throw Object.assign(new Error('无法解析总结地址。'), { statusCode: 400 });
  }
  const reason = assessSummaryEndpoint(raw, addresses);
  if (reason === 'https-required') throw Object.assign(new Error('公网地址必须使用 https。'), { statusCode: 400 });
  if (reason) throw Object.assign(new Error('不允许使用这个总结地址。'), { statusCode: 400 });
}
