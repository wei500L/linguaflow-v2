import type { ComponentType } from 'react';
import { tr } from './lib/i18n';
import { getTheme, setTheme, useTheme, type ThemeChoice } from './lib/theme';
import { MoonIcon, SunIcon, SystemIcon } from './icons';

const options: Array<{ value: ThemeChoice; label: string; Icon: ComponentType<{ size?: number }> }> = [
  { value: 'light', label: '浅色', Icon: SunIcon },
  { value: 'dark', label: '深色', Icon: MoonIcon },
  { value: 'system', label: '跟随系统', Icon: SystemIcon }
];

export function ThemeToggle({ className = '' }: { className?: string }) {
  useTheme();
  const active = getTheme();
  return <div className={`theme-toggle ${className}`.trim()} role="group" aria-label={tr('外观')}>
    {options.map(({ value, label, Icon }) => <button
      key={value}
      type="button"
      className={active === value ? 'active' : ''}
      aria-pressed={active === value}
      aria-label={tr(label)}
      title={tr(label)}
      onClick={() => setTheme(value)}
    ><Icon size={16} /></button>)}
  </div>;
}
