import { useEffect, useState } from 'react';

export type ThemeChoice = 'light' | 'dark' | 'system';
type Resolved = 'light' | 'dark';

const themeKey = 'linguaflow_theme';
const darkQuery = '(prefers-color-scheme: dark)';

/* Kept in sync with --bg in styles/tokens.css so the browser chrome matches the page. */
const chrome: Record<Resolved, string> = { light: '#fafafa', dark: '#000000' };

function storedChoice(): ThemeChoice {
  try {
    const saved = localStorage.getItem(themeKey);
    if (saved === 'light' || saved === 'dark' || saved === 'system') return saved;
  } catch { /* Storage can be blocked. */ }
  return 'system';
}

function systemTheme(): Resolved {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia(darkQuery).matches ? 'dark' : 'light';
}

let currentChoice: ThemeChoice = typeof window === 'undefined' ? 'system' : storedChoice();
const listeners = new Set<() => void>();

export function getTheme() { return currentChoice; }
export function resolvedTheme(): Resolved { return currentChoice === 'system' ? systemTheme() : currentChoice; }

/* Colour transitions would otherwise animate every control separately on a theme
   switch, leaving a frame where half the page is light and half dark. */
function withoutTransitions(apply: () => void) {
  const root = document.documentElement;
  root.classList.add('theme-switching');
  apply();
  requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove('theme-switching')));
}

function paint() {
  if (typeof document === 'undefined') return;
  const resolved = resolvedTheme();
  if (document.documentElement.dataset.theme === resolved) return void syncChrome(resolved);
  withoutTransitions(() => { document.documentElement.dataset.theme = resolved; });
  syncChrome(resolved);
}

function syncChrome(resolved: Resolved) {
  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.append(meta);
  }
  meta.content = chrome[resolved];
}

export function setTheme(next: ThemeChoice) {
  currentChoice = next;
  try { localStorage.setItem(themeKey, next); } catch { /* Storage can be blocked. */ }
  paint();
  listeners.forEach((listener) => listener());
}

/* A projection or audience screen is always dark, so those pages opt out of the
   user's choice without overwriting it. */
export function forceDark(active: boolean) {
  if (typeof document === 'undefined') return;
  if (active) withoutTransitions(() => { document.documentElement.dataset.theme = 'dark'; });
  else paint();
}

if (typeof window !== 'undefined') {
  paint();
  window.matchMedia(darkQuery).addEventListener('change', () => {
    if (currentChoice !== 'system') return;
    paint();
    listeners.forEach((listener) => listener());
  });
}

export function useTheme() {
  const [choice, set] = useState(currentChoice);
  useEffect(() => {
    const listener = () => set(getTheme());
    listeners.add(listener);
    listener();
    return () => { listeners.delete(listener); };
  }, []);
  return choice;
}
