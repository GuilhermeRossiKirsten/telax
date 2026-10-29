'use client';

import { useEffect, useLayoutEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { screenWord } from '@/lib/screens';
import { Icon } from './Icon';

type Props = {
  /** posição do botão "Parar compartilhamento" (o menu abre acima dele) */
  anchor: DOMRect;
  /** telas próprias por slot (null = slot livre) */
  screens: Array<MediaStream | null>;
  onStop(slot: number): void;
  onStopAll(): void;
  onClose(): void;
};

const FOCUSABLE = 'button:not(:disabled)';

/** Miniatura ao vivo de uma das telas que estou compartilhando: é como a pessoa reconhece qual é qual. */
function Preview({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLVideoElement>(null);
  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = stream;
    v.play().catch(() => {});
    return () => {
      v.srcObject = null;
    };
  }, [stream]);
  return <video ref={ref} className="stop-menu-preview" autoPlay playsInline muted />;
}

/** Seletor de "qual tela parar" quando há mais de uma sendo compartilhada (ou todas de uma vez). */
export function ScreenStopMenu({ anchor, screens, onStop, onStopAll, onClose }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  // abre acima do botão, centralizado nele e encaixado na janela
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - r.width / 2, window.innerWidth - r.width - 8));
    el.style.left = `${left}px`;
    el.style.bottom = `${Math.max(8, window.innerHeight - anchor.top + 8)}px`;
  }, [anchor]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();
    const outside = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
    };
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return;
      const items = Array.from(ref.current?.querySelectorAll<HTMLElement>(FOCUSABLE) ?? []);
      if (items.length === 0) return;
      e.preventDefault();
      const i = items.indexOf(document.activeElement as HTMLElement);
      items[(i + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length].focus();
    };
    const dismiss = () => closeRef.current();
    document.addEventListener('pointerdown', outside, true);
    document.addEventListener('keydown', key, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      document.removeEventListener('pointerdown', outside, true);
      document.removeEventListener('keydown', key, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const active = screens.flatMap((stream, slot) => (stream ? [{ stream, slot }] : []));
  const act = (fn: () => void) => () => {
    fn();
    onClose();
  };

  return createPortal(
    <div ref={ref} className="stop-menu" role="menu" aria-label="Parar qual tela?" style={{ left: anchor.left, bottom: 8 }}>
      <div className="stop-menu-title">Parar qual tela?</div>
      {active.map(({ stream, slot }) => (
        <button key={slot} role="menuitem" className="stop-menu-item" onClick={act(() => onStop(slot))}>
          <Preview stream={stream} />
          <span>Parar {screenWord(slot)}</span>
        </button>
      ))}
      <button role="menuitem" className="stop-menu-item stop-menu-all" onClick={act(onStopAll)}>
        <Icon name="screenOff" size={18} />
        <span>Parar todas as telas</span>
      </button>
    </div>,
    document.body,
  );
}
