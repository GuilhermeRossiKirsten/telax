'use client';

import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { screenSound, screenWord } from '@/lib/screens';
import { Icon, type IconName } from './Icon';

type Sound = { muted: boolean; volume: number };

type Props = {
  /** posição do clique (coordenadas da janela) */
  x: number;
  y: number;
  /** onde o menu é desenhado: o body, ou o próprio elemento em tela cheia (o resto da página fica invisível nela) */
  host: HTMLElement;
  /** rótulo do tile e nome da pessoa (sem "(você)") */
  label: string;
  name: string;
  isSelf: boolean;
  isPerson: boolean;
  /** slot da tela deste tile, ou null */
  slot: number | null;
  showScreen: boolean;
  selected: boolean;
  fullscreen: boolean;
  voice: Sound;
  tab: Sound;
  onToggleVoice?(): void;
  onVoiceVolume?(v: number): void;
  onToggleTab?(): void;
  onTabVolume?(v: number): void;
  onOpenScreen?(): void;
  onCloseScreen?(): void;
  onStopShare?(): void;
  onHide?(): void;
  onToggleSelect?(): void;
  onToggleFullscreen(): void;
  onClose(): void;
};

const FOCUSABLE = 'button:not(:disabled), input:not(:disabled)';

function SoundGroup(p: {
  icon: IconName;
  title: string;
  groupLabel: string;
  muteLabel: string;
  unmuteLabel: string;
  volumeLabel: string;
  sound: Sound;
  note?: string;
  onToggle?(): void;
  onVolume?(v: number): void;
}) {
  const { sound } = p;
  return (
    <div role="group" aria-label={p.groupLabel} className="tile-menu-group">
      <span className="tile-menu-heading">
        <Icon name={p.icon} size={14} /> {p.title}
      </span>
      <div className="tile-menu-sound">
        <button className="tile-btn" aria-label={sound.muted ? p.unmuteLabel : p.muteLabel} title={sound.muted ? p.unmuteLabel : p.muteLabel} onClick={p.onToggle}>
          <Icon name={sound.muted || sound.volume === 0 ? 'volumeOff' : 'volume'} size={16} />
        </button>
        <input
          type="range"
          min={0}
          max={100}
          step={5}
          value={Math.round((sound.muted ? 0 : sound.volume) * 100)}
          aria-label={p.volumeLabel}
          onChange={(e) => p.onVolume?.(Number(e.target.value) / 100)}
        />
      </div>
      {p.note && <span className="tile-menu-note">{p.note}</span>}
    </div>
  );
}

/**
 * Menu de botão direito de um tile. Separa com clareza o que é a VOZ da pessoa do que é o SOM DA TRANSMISSÃO
 * (a aba/tela que ela compartilha): cada um com o seu rótulo, ícone, silenciar e volume.
 */
export function TileMenu(p: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(p.onClose);
  useEffect(() => {
    closeRef.current = p.onClose;
  });

  // encaixa na janela: o clique perto da borda não pode deixar o menu cortado
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const left = Math.max(8, Math.min(p.x, window.innerWidth - r.width - 8));
    const top = Math.max(8, Math.min(p.y, window.innerHeight - r.height - 8));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }, [p.x, p.y]);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    ref.current?.querySelector<HTMLElement>(FOCUSABLE)?.focus();

    const outside = (e: Event) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeRef.current();
    };
    // captura no document: o Esc fecha só o menu (não solta a seleção do tile nem sai de tela cheia por engano)
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

  /** ação do menu: executa e fecha (ajustar volume não fecha) */
  const act = (fn?: () => void) => () => {
    fn?.();
    p.onClose();
  };
  const Item = (props: { icon: IconName; label: string; onClick(): void }) => (
    <button role="menuitem" className="tile-menu-item" onClick={props.onClick}>
      <Icon name={props.icon} size={16} /> {props.label}
    </button>
  );

  const word = screenWord(p.slot ?? 0);
  const sound = screenSound(p.name, p.slot ?? 0);
  const showVoice = !p.isSelf && p.isPerson;
  const showTab = !p.isSelf && p.slot !== null;
  const items: ReactNode[] = [];

  items.push(<Item key="sel" icon="pin" label={p.selected ? `Soltar ${p.label}` : `Destacar ${p.label}`} onClick={act(p.onToggleSelect)} />);
  items.push(
    <Item
      key="fs"
      icon={p.fullscreen ? 'minimize' : 'maximize'}
      label={p.fullscreen ? `Sair da tela cheia ${p.label}` : `Tela cheia ${p.label}`}
      onClick={act(p.onToggleFullscreen)}
    />,
  );
  if (showTab && !p.showScreen) items.push(<Item key="open" icon="screen" label={`Ver ${word} de ${p.name}`} onClick={act(p.onOpenScreen)} />);
  if (showTab && p.showScreen) items.push(<Item key="close" icon="close" label={`Fechar ${word} de ${p.name}`} onClick={act(p.onCloseScreen)} />);
  if (p.isSelf && p.showScreen) items.push(<Item key="stop" icon="screenOff" label={`Parar de compartilhar ${word}`} onClick={act(p.onStopShare)} />);
  items.push(<Item key="hide" icon="eyeOff" label={`Fechar ${p.label}`} onClick={act(p.onHide)} />);

  return createPortal(
    <div
      ref={ref}
      className="tile-menu"
      role="menu"
      aria-label={`Menu de ${p.label}`}
      style={{ left: p.x, top: p.y }}
      // o menu vive num portal, mas os eventos sobem pela árvore do React até o tile: não pode selecionar o tile
      onClick={(e) => e.stopPropagation()}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
      }}
    >
      <div className="tile-menu-title">{p.label}</div>
      {showVoice && (
        <SoundGroup
          icon="mic"
          title={`Voz de ${p.name}`}
          groupLabel={`Voz de ${p.name}`}
          muteLabel={`Silenciar ${p.name}`}
          unmuteLabel={`Ativar som de ${p.name}`}
          volumeLabel={`Volume de ${p.name}`}
          sound={p.voice}
          onToggle={p.onToggleVoice}
          onVolume={p.onVoiceVolume}
        />
      )}
      {showTab && (
        <SoundGroup
          icon="screen"
          title={p.slot === 0 ? 'Som da transmissão' : `Som da transmissão ${(p.slot ?? 0) + 1}`}
          groupLabel={p.slot === 0 ? `Som da transmissão de ${p.name}` : `Som da transmissão ${(p.slot ?? 0) + 1} de ${p.name}`}
          muteLabel={`Silenciar ${sound}`}
          unmuteLabel={`Ativar ${sound}`}
          volumeLabel={`Volume ${sound.replace(/^som /, '')}`}
          sound={p.tab}
          note={p.showScreen ? undefined : 'Abra a tela para ouvir'}
          onToggle={p.onToggleTab}
          onVolume={p.onTabVolume}
        />
      )}
      {(showVoice || showTab) && <div className="tile-menu-sep" role="separator" />}
      {items}
    </div>,
    p.host,
  );
}
