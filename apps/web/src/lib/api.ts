import { deviceHeaderValue } from './device';

const API_URL = import.meta.env.VITE_API_URL ?? (import.meta.env.DEV ? 'http://localhost:3000' : '');
export const apiOrigin = API_URL;

/* An https page may only open wss://. A proxy that drops X-Forwarded-Proto makes
   the API hand out ws://, which phone browsers refuse outright. */
export function openSocket(url: string, protocols?: string[]) {
  const target = new URL(url, window.location.href);
  if (window.location.protocol === 'https:' && target.protocol === 'ws:') target.protocol = 'wss:';
  return new WebSocket(target.toString(), protocols);
}
const tokenKey = 'linguaflow_access_token';

export const getToken = () => localStorage.getItem(tokenKey);
export const setToken = (token: string) => localStorage.setItem(tokenKey, token);
export const clearToken = () => localStorage.removeItem(tokenKey);
export class ApiError extends Error {
  status: number;
  code?: string;
  sessionId?: string;
  constructor(message: string, status: number, code?: string, sessionId?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.sessionId = sessionId;
  }
}

function tokenPayload() {
  const token = getToken();
  if (!token) return null;
  try {
    const part = token.split('.')[1];
    if (!part) return null;
    /* JWTs are base64url. atob rejects "-" and "_" and, on some phone browsers,
       a payload that is not padded to a multiple of 4. A failed decode used to
       look like an expired session and bounce the user back to sign-in. */
    const padded = part.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(part.length / 4) * 4, '=');
    return JSON.parse(atob(padded)) as { exp?: number };
  } catch { return null; }
}

export const isTokenExpired = () => {
  const payload = tokenPayload();
  if (!payload) return true;
  return typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now();
};

export const tokenExpiresWithin = (ms: number) => {
  const payload = tokenPayload();
  if (!payload || typeof payload.exp !== 'number') return true;
  return payload.exp * 1000 - Date.now() < ms;
};

function requestHeaders(init: RequestInit) {
  const headers = new Headers(init.headers);
  headers.set('content-type', 'application/json');
  const token = getToken();
  if (token && !headers.has('authorization')) headers.set('authorization', `Bearer ${token}`);
  return headers;
}

export async function apiResponse(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = requestHeaders(init);
  if (!headers.has('x-linguaflow-device')) {
    try { headers.set('x-linguaflow-device', await deviceHeaderValue()); } catch { /* free sessions reject a missing fingerprint */ }
  }
  const response = await fetch(`${API_URL}${path}`, { ...init, headers });
  if (response.status === 401 && !path.startsWith('/v1/auth/')) { clearToken(); window.dispatchEvent(new Event('linguaflow:auth-expired')); }
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ApiError(payload?.message ?? `Request failed (${response.status})`, response.status, payload?.code, payload?.sessionId);
  }
  return response;
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await apiResponse(path, init);
  return response.status === 204 ? (undefined as T) : response.json();
}
