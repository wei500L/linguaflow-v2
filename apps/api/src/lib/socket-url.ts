import type { FastifyRequest } from 'fastify';

function firstValue(header: string | string[] | undefined) {
  const raw = Array.isArray(header) ? header[0] : header;
  return raw?.split(',')[0]?.trim().toLowerCase() ?? '';
}

/* Proxies chain their own value onto X-Forwarded-Proto ("https, http"), and some
   only send Forwarded: proto=https. Missing either one used to hand an https page
   a ws:// URL, which phone browsers block as mixed content. */
export function socketUrl(request: FastifyRequest, path: string) {
  const host = request.headers.host ?? 'localhost:3000';
  const forwarded = firstValue(request.headers.forwarded).match(/proto=([a-z]+)/)?.[1];
  const proto = firstValue(request.headers['x-forwarded-proto']) || forwarded || request.protocol;
  return `${proto === 'https' ? 'wss' : 'ws'}://${host}${path}`;
}
