import type { ReactNode } from 'react';

type IconProps = { size?: number; className?: string };

function Svg({ size = 18, className, children, filled = false }: IconProps & { children: ReactNode; filled?: boolean }) {
  return <svg
    className={`icon${className ? ` ${className}` : ''}`}
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill={filled ? 'currentColor' : 'none'}
    stroke={filled ? 'none' : 'currentColor'}
    strokeWidth={1.75}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >{children}</svg>;
}

export const SunIcon = (props: IconProps) => <Svg {...props}>
  <circle cx="12" cy="12" r="4" />
  <path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4" />
</Svg>;

export const MoonIcon = (props: IconProps) => <Svg {...props}>
  <path d="M20 14.5A8 8 0 1 1 9.5 4a6.5 6.5 0 0 0 10.5 10.5Z" />
</Svg>;

export const SystemIcon = (props: IconProps) => <Svg {...props}>
  <rect x="3" y="4.5" width="18" height="12" rx="2" />
  <path d="M8.5 20h7M12 16.5V20" />
</Svg>;

export const MenuIcon = (props: IconProps) => <Svg {...props}>
  <path d="M4 7h16M4 12h16M4 17h16" />
</Svg>;

export const CloseIcon = (props: IconProps) => <Svg {...props}>
  <path d="M6 6l12 12M18 6 6 18" />
</Svg>;

export const ChevronRightIcon = (props: IconProps) => <Svg {...props}>
  <path d="m9 6 6 6-6 6" />
</Svg>;

export const ChevronLeftIcon = (props: IconProps) => <Svg {...props}>
  <path d="m15 6-6 6 6 6" />
</Svg>;

export const EditIcon = (props: IconProps) => <Svg {...props}>
  <path d="M4 20h4L19 9a2.83 2.83 0 0 0-4-4L4 16v4Z" />
  <path d="m13.5 6.5 4 4" />
</Svg>;

export const BookIcon = (props: IconProps) => <Svg {...props}>
  <path d="M5 4.5A1.5 1.5 0 0 1 6.5 3H19v15H6.5A1.5 1.5 0 0 0 5 19.5v-15Z" />
  <path d="M5 19.5A1.5 1.5 0 0 0 6.5 21H19M9 7.5h6" />
</Svg>;

export const MicIcon = (props: IconProps) => <Svg {...props}>
  <rect x="9" y="3" width="6" height="11" rx="3" />
  <path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21" />
</Svg>;

export const PauseIcon = (props: IconProps) => <Svg {...props} filled>
  <rect x="6.5" y="5" width="3.5" height="14" rx="1" />
  <rect x="14" y="5" width="3.5" height="14" rx="1" />
</Svg>;

export const PlayIcon = (props: IconProps) => <Svg {...props} filled>
  <path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z" />
</Svg>;

export const StopIcon = (props: IconProps) => <Svg {...props} filled>
  <rect x="6" y="6" width="12" height="12" rx="2.5" />
</Svg>;

export const RecordIcon = (props: IconProps) => <Svg {...props} filled>
  <circle cx="12" cy="12" r="6" />
</Svg>;

export const QrIcon = (props: IconProps) => <Svg {...props}>
  <path d="M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4z" />
  <path d="M14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z" />
</Svg>;
