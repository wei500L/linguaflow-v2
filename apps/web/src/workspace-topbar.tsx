import { useEffect, useRef, useState } from 'react';
import type { Entitlement } from '@linguaflow/shared';
import { tr } from './lib/i18n';
import { LanguageToggle } from './language-toggle';
import { ThemeToggle } from './theme-toggle';

export type Panel = 'none' | 'transcripts' | 'glossary' | 'pricing' | 'admin' | 'account';
export type ServiceStatus = 'checking' | 'online' | 'offline';

const navItems: Array<{ panel: Panel; label: string; adminOnly?: boolean }> = [
  { panel: 'transcripts', label: '字幕库' },
  { panel: 'glossary', label: '术语库' },
  { panel: 'pricing', label: '会员' },
  { panel: 'account', label: '账户' },
  { panel: 'admin', label: '后台', adminOnly: true }
];

type TopbarProps = {
  entitlement: Entitlement | null;
  serviceStatus: ServiceStatus;
  isAdmin: boolean;
  live: { label: string; remaining: string; warning: boolean; paused: boolean } | null;
  onPanel: (panel: Panel) => void;
  onLogout: () => void;
};

export function Topbar({ entitlement, serviceStatus, isAdmin, live, onPanel, onLogout }: TopbarProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const statusLabel = serviceStatus === 'checking' ? tr('检查服务中') : serviceStatus === 'online' ? tr('实时服务正常') : tr('实时服务异常');
  const quota = entitlement ? `${entitlement.plan.toUpperCase()} · ${entitlement.remainingSeconds === Number.MAX_SAFE_INTEGER ? '∞' : Math.ceil(entitlement.remainingSeconds / 60)} ${tr('分钟')}` : '';
  const items = navItems.filter((item) => !item.adminOnly || isAdmin);

  useEffect(() => {
    if (!menuOpen) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') setMenuOpen(false); };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [menuOpen]);

  const openPanel = (panel: Panel) => { onPanel(panel); setMenuOpen(false); };

  return <header className="topbar">
    {live
      ? <p className={`topbar-status${live.warning ? ' is-warning' : ''}${live.paused ? ' is-paused' : ''}`}>
          <i />
          <b>{live.paused ? tr('暂停收音') : live.label}</b>
          {live.remaining && <small>{live.remaining}</small>}
        </p>
      : <div className="wordmark"><span className="brand-mark small">L</span><strong>LinguaFlow</strong></div>}
    <div className="topbar-actions">
      <div className="desktop-nav">
        <ThemeToggle />
        <LanguageToggle />
        {items.map((item) => <button key={item.panel} className="topbar-link" onClick={() => onPanel(item.panel)}>{tr(item.label)}</button>)}
      </div>
      <span className={`status-pill ${serviceStatus}`}><i />{statusLabel}</span>
      {quota && <span className="quota-pill">{quota}</span>}
      <div className="topbar-menu" ref={menuRef}>
        <button className="icon-button" aria-expanded={menuOpen} aria-haspopup="menu" aria-label={tr('菜单')} onClick={() => setMenuOpen((open) => !open)}>☰</button>
        {menuOpen && <div className="menu-card" role="menu">
          {items.map((item) => <button key={item.panel} role="menuitem" onClick={() => openPanel(item.panel)}>{tr(item.label)}</button>)}
          <div className="menu-divider" />
          <div className="menu-row"><span>{tr('外观')}</span><ThemeToggle /></div>
          <div className="menu-row"><span>{tr('界面语言')}</span><LanguageToggle className="secondary-button" /></div>
          <div className="menu-row"><span>{statusLabel}</span>{quota && <span className="quota-pill">{quota}</span>}</div>
          <div className="menu-divider" />
          <button role="menuitem" onClick={() => { setMenuOpen(false); onLogout(); }}>{tr('退出登录')}</button>
        </div>}
      </div>
    </div>
  </header>;
}
