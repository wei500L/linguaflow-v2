const storageKey = 'linguaflow_device_id';
let memoryId = '';
let cached: Promise<string> | null = null;

function randomId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
    const value = Math.floor(Math.random() * 16);
    return (char === 'x' ? value : (value & 0x3) | 0x8).toString(16);
  });
}

function deviceId() {
  try {
    const existing = localStorage.getItem(storageKey);
    if (existing && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(existing)) return existing;
    const id = randomId();
    localStorage.setItem(storageKey, id);
    return id;
  } catch {
    memoryId ||= randomId();
    return memoryId;
  }
}

async function sha256Hex(text: string) {
  if (crypto.subtle) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
    return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(16).padStart(8, '0').repeat(4);
}

async function canvasHash() {
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 240;
    canvas.height = 60;
    const context = canvas.getContext('2d');
    if (!context) return 'no-canvas';
    context.textBaseline = 'top';
    context.font = '16px Arial';
    context.fillStyle = '#f60';
    context.fillRect(0, 0, 240, 60);
    context.fillStyle = '#069';
    context.fillText('LinguaFlow', 2, 2);
    context.strokeStyle = 'rgba(120, 12, 200, 0.7)';
    context.beginPath();
    context.arc(80, 30, 18, 0, Math.PI, false);
    context.stroke();
    return (await sha256Hex(canvas.toDataURL())).slice(0, 32);
  } catch {
    return 'canvas-error';
  }
}

function isWebGL(value: unknown): value is WebGLRenderingContext {
  return !!value && typeof (value as WebGLRenderingContext).getParameter === 'function';
}

function webglRenderer() {
  try {
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') ?? canvas.getContext('experimental-webgl');
    if (!isWebGL(gl)) return '';
    const ext = gl.getExtension('WEBGL_debug_renderer_info');
    const renderer = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '') : String(gl.getParameter(gl.RENDERER) ?? '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return renderer.replace(/\s+/g, ' ').trim().slice(0, 200);
  } catch {
    return '';
  }
}

export function buildDevicePayload(input: { deviceId: string; screen: string; cores: number; memory: number | null; touch: number; platform: string; timezone: string; webgl: string; canvas: string }) {
  return {
    deviceId: input.deviceId,
    screen: input.screen,
    cores: input.cores,
    memory: input.memory,
    touch: input.touch,
    platform: input.platform.slice(0, 80),
    timezone: input.timezone.slice(0, 80),
    webgl: input.webgl.slice(0, 200),
    canvas: input.canvas
  };
}

export function encodeDeviceHeader(json: string) {
  const bytes = new TextEncoder().encode(json);
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function buildDeviceHeader() {
  const nav = navigator as Navigator & { deviceMemory?: number };
  const canvas = await canvasHash();
  return {
    weak: canvas === 'canvas-error' || canvas === 'no-canvas',
    encoded: encodeDeviceHeader(JSON.stringify(buildDevicePayload({
      deviceId: deviceId(),
      screen: `${screen.width}x${screen.height}x${screen.colorDepth}`,
      cores: navigator.hardwareConcurrency || 0,
      memory: typeof nav.deviceMemory === 'number' ? nav.deviceMemory : null,
      touch: navigator.maxTouchPoints || 0,
      platform: navigator.platform || '',
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || '',
      webgl: webglRenderer(),
      canvas
    })))
  };
}

export async function deviceHeaderValue() {
  if (cached) return cached;
  try {
    const built = await buildDeviceHeader();
    if (!built.weak) cached = Promise.resolve(built.encoded);
    return built.encoded;
  } catch (error) {
    cached = null;
    throw error;
  }
}
