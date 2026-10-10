import { normalizeInviteCode } from '@linguaflow/shared';

const storageKey = 'linguaflow_invite';

export function captureInvite() {
  try {
    const fromUrl = normalizeInviteCode(new URLSearchParams(window.location.search).get('invite') ?? '');
    if (fromUrl) {
      localStorage.setItem(storageKey, fromUrl);
      const url = new URL(window.location.href);
      url.searchParams.delete('invite');
      window.history.replaceState({}, '', `${url.pathname}${url.search}${url.hash}`);
      return fromUrl;
    }
    return normalizeInviteCode(localStorage.getItem(storageKey) ?? '') ?? '';
  } catch {
    return '';
  }
}

export function clearInvite() {
  try { localStorage.removeItem(storageKey); } catch { /* Storage can be blocked. */ }
}
