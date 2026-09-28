import { tr } from './lib/i18n';
import { getTheme, setTheme, useTheme, type ThemeChoice } from './lib/theme';

const options: Array<{ value: ThemeChoice; label: string; glyph: string }> = [
  { value: 'light', label: '浅色', glyph: '☀' },
  { value: 'dark', label: '深色', glyph: '☾' },
  { value: 'system', label: '跟随系统', glyph: '◐' }
];

export function ThemeToggle({ className = '' }: { className?: string }) {
  useTheme();
  const active = getTheme();
  return <div className={`theme-toggle ${className}`.trim()} role="group" aria-label={tr('外观')}>
    {options.map((option) => <button
      key={option.value}
      type="button"
      className={active === option.value ? 'active' : ''}
      aria-pressed={active === option.value}
      aria-label={tr(option.label)}
      title={tr(option.label)}
      onClick={() => setTheme(option.value)}
    ><span aria-hidden="true">{option.glyph}</span></button>)}
  </div>;
}
