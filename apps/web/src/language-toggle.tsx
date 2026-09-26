import { getLang, setLang, useLang } from './lib/i18n';

export function LanguageToggle({ className = 'topbar-link' }: { className?: string }) {
  useLang();
  const englishUi = getLang() === 'en';
  return <button type="button" className={className} onClick={() => setLang(englishUi ? 'zh' : 'en')}>{englishUi ? '中文' : 'English'}</button>;
}
