import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import type { Readable } from 'node:stream';
import { assessSummaryEndpoint, resolveEndpointAddresses } from '../lib/ssrf.js';
import { SummaryError, type ChatMessage } from './pipeline.js';

const maxBodyBytes = 1_000_000;

function pinnedLookup(address: string) {
  const family = isIP(address);
  return (_hostname: string, options: unknown, callback?: (error: NodeJS.ErrnoException | null, address: string, family: number) => void) => {
    const done = typeof options === 'function' ? options as (error: NodeJS.ErrnoException | null, address: string, family: number) => void : callback;
    done?.(null, address, family);
  };
}

export function readLimited(stream: Readable, limit = maxBodyBytes) {
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    stream.on('data', (chunk: Buffer | string) => {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buf.length;
      if (size > limit) {
        stream.destroy();
        reject(new SummaryError('api', '总结服务返回的内容过大。'));
        return;
      }
      chunks.push(buf);
    });
    stream.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    stream.on('error', () => reject(new SummaryError('unreachable', '无法连接总结服务。')));
  });
}

export async function chatComplete(options: { apiBase: string; apiKey?: string; model: string; messages: ChatMessage[]; signal?: AbortSignal }) {
  if (options.signal?.aborted) throw new SummaryError('cancelled', '纪要已取消。');
  let addresses: string[] = [];
  try {
    addresses = await resolveEndpointAddresses(options.apiBase);
  } catch {
    throw new SummaryError('unreachable', '无法连接总结服务。');
  }
  if (assessSummaryEndpoint(options.apiBase, addresses)) throw new SummaryError('endpoint', '不允许使用这个总结地址。');
  const endpoint = new URL('chat/completions', options.apiBase.endsWith('/') ? options.apiBase : `${options.apiBase}/`);
  const pinned = addresses[0];
  if (!pinned) throw new SummaryError('endpoint', '不允许使用这个总结地址。');
  const body = JSON.stringify({ model: options.model, messages: options.messages, max_tokens: 2048, temperature: 0.3 });
  const headers: Record<string, string> = { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) };
  if (options.apiKey) headers.authorization = `Bearer ${options.apiKey}`;
  const lib = endpoint.protocol === 'https:' ? https : http;
  try {
    const response = await new Promise<{ status: number; location: string; body: string }>((resolve, reject) => {
      const req = lib.request(endpoint, {
        method: 'POST',
        headers,
        lookup: pinnedLookup(pinned),
        signal: options.signal
      }, (res) => {
        const status = res.statusCode ?? 0;
        const location = String(res.headers.location ?? '');
        if (status >= 300 && status < 400) {
          res.resume();
          resolve({ status, location, body: '' });
          return;
        }
        const declared = Number(res.headers['content-length'] ?? 0);
        if (declared > maxBodyBytes) {
          res.destroy();
          reject(new SummaryError('api', '总结服务返回的内容过大。'));
          return;
        }
        readLimited(res).then((text) => resolve({ status, location, body: text })).catch(reject);
      });
      const timer = setTimeout(() => req.destroy(new Error('timeout')), 60_000);
      req.on('error', (error) => {
        clearTimeout(timer);
        if (options.signal?.aborted) reject(new SummaryError('cancelled', '纪要已取消。'));
        else if (error.message === 'timeout') reject(new SummaryError('timeout', '总结服务超时。'));
        else reject(error);
      });
      req.on('close', () => clearTimeout(timer));
      req.end(body);
    });
    if (response.status >= 300 && response.status < 400) throw new SummaryError('endpoint', '不允许使用这个总结地址。');
    if (response.status === 401 || response.status === 403) throw new SummaryError('auth', '总结服务拒绝了密钥。');
    if (response.status < 200 || response.status >= 300) throw new SummaryError('api', `总结服务返回了 ${response.status}。`);
    const payload = JSON.parse(response.body) as { choices?: Array<{ message?: { content?: string | null } }> };
    const text = payload.choices?.[0]?.message?.content?.trim() ?? '';
    if (!text) throw new SummaryError('empty', '总结服务没有返回内容。');
    return text;
  } catch (error) {
    if (error instanceof SummaryError) throw error;
    if (options.signal?.aborted) throw new SummaryError('cancelled', '纪要已取消。');
    throw new SummaryError('unreachable', '无法连接总结服务。');
  }
}
