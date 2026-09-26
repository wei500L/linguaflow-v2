import { LANGUAGE_OPTIONS } from '@linguaflow/shared';

export function languageBase(code: string) {
  return code.trim().toLowerCase().split('-')[0];
}

export function sameLanguageCode(left: string, right: string) {
  const a = languageBase(left);
  const b = languageBase(right);
  return Boolean(a && b && a === b);
}

export function languageNative(code: string) {
  return LANGUAGE_OPTIONS.find((item) => item.code === languageBase(code))?.nativeName ?? code.toUpperCase();
}

export function glossaryOptionLabel(item: { name: string; languageA: string; languageB: string; terms?: unknown[] }) {
  const direction = `${languageNative(item.languageA)} → ${languageNative(item.languageB)}`;
  return item.terms ? `${item.name} · ${direction} · ${item.terms.length}` : `${item.name} · ${direction}`;
}

export function glossaryDirection(glossary: { languageA: string; languageB: string }, spoken: string, other: string) {
  const left = languageBase(glossary.languageA);
  const right = languageBase(glossary.languageB);
  const source = languageBase(spoken);
  const target = languageBase(other);
  if (left === source && right === target) return 'forward' as const;
  if (left === target && right === source) return 'reversed' as const;
  return 'mismatch' as const;
}
