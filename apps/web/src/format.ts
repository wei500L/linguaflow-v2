import { tr } from './lib/i18n';

export function formatDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds >= Number.MAX_SAFE_INTEGER / 2) return tr('无限');
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  if (minutes <= 0) return `${rest} ${tr('秒')}`;
  if (rest === 0) return `${minutes} ${tr('分钟')}`;
  return `${minutes} ${tr('分钟')} ${rest} ${tr('秒')}`;
}

export function formatDate(iso: string | null) {
  if (!iso) return tr('无到期日');
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleDateString(document.documentElement.lang === 'en' ? 'en' : 'zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}

export function usableSeconds(entitlement: { remainingSeconds: number; addonSeconds: number }) {
  if (entitlement.remainingSeconds >= Number.MAX_SAFE_INTEGER / 2) return entitlement.remainingSeconds;
  return entitlement.remainingSeconds + Math.max(0, entitlement.addonSeconds);
}

export function formatRemain(seconds: number) {
  const whole = Math.max(0, Math.floor(seconds));
  const minutes = Math.floor(whole / 60);
  return `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}
