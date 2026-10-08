import { useEffect, useId, useRef, type ReactNode } from 'react';
import { tr } from './lib/i18n';
import { CloseIcon } from './icons';

export function ListSkeleton({ label, rows = 3 }: { label: string; rows?: number }) {
  return <div className="list-skeleton" role="status" aria-busy="true">
    <span className="visually-hidden">{label}</span>
    {Array.from({ length: rows }, (_, index) => <div className="skeleton-row" key={index} aria-hidden="true"><i /><i /></div>)}
  </div>;
}

export function PanelShell({ title, onClose, children, wide = false }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    previousFocus.current = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onCloseRef.current();
      if (event.key !== 'Tab' || !panelRef.current) return;
      const focusable = Array.from(panelRef.current.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], summary'))
        .filter((node) => typeof node.checkVisibility === 'function' ? node.checkVisibility() : node.getClientRects().length > 0);
      if (!focusable.length) return;
      if (event.shiftKey && document.activeElement === focusable[0]) { event.preventDefault(); focusable[focusable.length - 1]?.focus(); }
      else if (!event.shiftKey && document.activeElement === focusable[focusable.length - 1]) { event.preventDefault(); focusable[0]?.focus(); }
    };
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('keydown', onKeyDown);
    return () => { window.removeEventListener('keydown', onKeyDown); document.body.style.overflow = previousOverflow; previousFocus.current?.focus(); };
  }, []);
  return <div className="panel-backdrop" onClick={onClose}><section ref={panelRef} className={`panel${wide ? ' panel-wide' : ''}`} role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1} onClick={(event) => event.stopPropagation()}><div className="panel-header"><div><p className="eyebrow">LINGUAFLOW</p><h2 id={titleId}>{title}</h2></div><button ref={closeRef} className="icon-button" onClick={onClose} aria-label={tr('关闭')}><CloseIcon /></button></div><div className="panel-body">{children}</div></section></div>;
}
