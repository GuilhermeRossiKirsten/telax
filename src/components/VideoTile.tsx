'use client';

import { useEffect, useRef, useState, type MouseEvent } from 'react';
import type { ConnState } from '@/lib/peer-manager';
import { screenLabel, screenSound, screenWord } from '@/lib/screens';
import type { TileKind } from '@/lib/view-state';
import { Icon } from './Icon';

export const CONN_LABEL: Record<ConnState | 'self', string> = {
  self: 'Você',
  connecting: 'Conectando',
  connected: 'Conectado',
  reconnecting: 'Reconectando',
  failed: 'Falhou',
};

type Sound = { muted: boolean; volume: number };

type Props = {
  /** `person`: avatar/câmera (e a tela de menor slot no lugar deles); `screen`: tile extra de uma tela adicional */
  kind: TileKind;
  /** nome da pessoa (sem "(você)"); `label` é o rótulo exibido */
  name: string;
  label: string;
  isSelf?: boolean;
  conn: ConnState | 'self';
  camera: MediaStream | null;
  /** a tela que este tile mostra (própria ou de outra pessoa) */
  screen: MediaStream | null;
  /** slot da tela deste tile; null se a pessoa não compartilha */
  slot: number | null;
  audioOn?: boolean;
  videoOn?: boolean;
  /** o tile está mostrando a tela (no lugar do avatar/câmera) */
  showScreen?: boolean;
  selected?: boolean;
  /** voz e som da aba: silenciar e volume só neste navegador (o som toca no RemoteAudio) */
  voice: Sound;
  tab: Sound;
  onToggleVoice?(): void;
  onVoiceVolume?(v: number): void;
  onToggleTab?(): void;
  onTabVolume?(v: number): void;
  onOpenScreen?(): void;
  onCloseScreen?(): void;
  /** parar de compartilhar ESTA tela (só no tile da própria pessoa) */
  onStopShare?(): void;
  /** esconder o tile (a faixa "Fechadas" traz de volta) */
  onHide?(): void;
  onToggleSelect?(): void;
};

const hasVideoTrack = (s: MediaStream | null) => !!s && s.getVideoTracks().length > 0;

function SoundControl(p: {
  muteLabel: string;
  unmuteLabel: string;
  volumeLabel: string;
  title: string;
  sound: Sound;
  onToggle?(): void;
  onVolume?(v: number): void;
  stop(fn?: () => void): (e: MouseEvent) => void;
}) {
  const { sound } = p;
  return (
    <div className="tile-volume">
      <button className="tile-btn" aria-label={sound.muted ? p.unmuteLabel : p.muteLabel} title={p.title} onClick={p.stop(p.onToggle)}>
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
  );
}

/**
 * Um tile por participante. Compartilhando, a tela substitui o avatar/câmera neste mesmo tile (mesmo <video>);
 * se a câmera está ligada, ela passa a um quadro pequeno no canto. Telas adicionais têm tiles próprios.
 */
export function VideoTile({
  kind,
  name,
  label,
  isSelf = false,
  conn,
  camera,
  screen,
  slot,
  audioOn = true,
  videoOn = true,
  showScreen = false,
  selected = false,
  voice,
  tab,
  onToggleVoice,
  onVoiceVolume,
  onToggleTab,
  onTabVolume,
  onOpenScreen,
  onCloseScreen,
  onStopShare,
  onHide,
  onToggleSelect,
}: Props) {
  const figureRef = useRef<HTMLElement>(null);
  const mainRef = useRef<HTMLVideoElement>(null);
  const insetRef = useRef<HTMLVideoElement>(null);
  const isPerson = kind === 'person';
  const cameraLive = isPerson && hasVideoTrack(camera) && videoOn;
  const main = showScreen ? screen : isPerson ? camera : null;
  const hasMain = showScreen ? hasVideoTrack(screen) : cameraLive;
  const showInset = isPerson && showScreen && cameraLive;
  const sharing = slot !== null;
  const word = screenWord(slot ?? 0);

  // um único <video> troca de fonte (câmera ↔ tela): não nasce outro elemento nem outro tile
  useEffect(() => {
    const video = mainRef.current;
    if (!video) return;
    video.srcObject = main;
    if (main) video.play().catch(() => {}); // mudo: o autoplay é sempre permitido
    return () => {
      video.srcObject = null;
    };
  }, [main]);

  useEffect(() => {
    const video = insetRef.current;
    if (!video || !showInset) return;
    video.srcObject = camera;
    video.play().catch(() => {});
    return () => {
      video.srcObject = null;
    };
  }, [camera, showInset]);

  // tela cheia de verdade (API do navegador) neste mesmo tile; sair por Esc também é refletido aqui
  const [fullscreen, setFullscreen] = useState(false);
  useEffect(() => {
    const sync = () => setFullscreen(document.fullscreenElement === figureRef.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);
  const toggleFullscreen = () => {
    const el = figureRef.current;
    if (!el) return;
    if (document.fullscreenElement === el) void document.exitFullscreen().catch(() => {});
    else void el.requestFullscreen?.().catch(() => {}); // sem suporte ou negado: o botão só não faz nada
  };

  const stop = (fn?: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn?.();
  };

  const caption = showScreen ? screenLabel(name, slot ?? 0) : label;

  return (
    <figure
      ref={figureRef}
      className="tile"
      data-conn={conn}
      data-testid="tile"
      data-kind={kind}
      data-slot={slot ?? undefined}
      data-selected={selected ? 'true' : undefined}
      data-sharing={sharing ? 'true' : undefined}
      data-showing={showScreen ? 'screen' : 'camera'}
      onClick={onToggleSelect}
    >
      <video
        ref={mainRef}
        autoPlay
        playsInline
        muted
        className={isSelf && isPerson && !showScreen ? 'mirrored' : undefined}
        style={{ visibility: hasMain ? 'visible' : 'hidden' }}
      />
      {showInset && <video ref={insetRef} className={`tile-inset ${isSelf ? 'mirrored' : ''}`} autoPlay playsInline muted />}
      {!hasMain && !showScreen && isPerson && (
        <div className="avatar" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </div>
      )}
      {!hasMain && !showScreen && !isPerson && (
        <div className="tile-placeholder" aria-hidden="true">
          <Icon name="screen" size={40} />
        </div>
      )}
      {sharing && !showScreen && !isSelf && (
        <button className="tile-offer primary" aria-label={`Ver ${word} de ${name}`} onClick={stop(onOpenScreen)}>
          <Icon name="screen" size={16} /> Ver {word}
        </button>
      )}
      {/* overlay sobre a imagem: aparece ao passar o mouse ou focar; o clique no corpo do tile seleciona */}
      <div className="tile-actions" onClick={(e) => e.stopPropagation()}>
        {!isSelf && isPerson && (
          <SoundControl
            muteLabel={`Silenciar ${name}`}
            unmuteLabel={`Ativar som de ${name}`}
            volumeLabel={`Volume de ${name}`}
            title={voice.muted ? 'Voltar a ouvir (só para você)' : 'Silenciar (só para você)'}
            sound={voice}
            onToggle={onToggleVoice}
            onVolume={onVoiceVolume}
            stop={stop}
          />
        )}
        {!isSelf && showScreen && (
          <SoundControl
            muteLabel={`Silenciar ${screenSound(name, slot ?? 0)}`}
            unmuteLabel={`Ativar ${screenSound(name, slot ?? 0)}`}
            volumeLabel={`Volume ${screenSound(name, slot ?? 0).replace(/^som /, '')}`}
            title={tab.muted ? 'Ouvir o som da aba (só para você)' : 'Silenciar o som da aba (só para você)'}
            sound={tab}
            onToggle={onToggleTab}
            onVolume={onTabVolume}
            stop={stop}
          />
        )}
        <button
          className="tile-btn"
          aria-pressed={selected}
          aria-label={selected ? `Soltar ${label}` : `Destacar ${label}`}
          title={selected ? 'Voltar ao layout normal' : 'Destacar: fica grande e os outros ficam embaixo'}
          onClick={stop(onToggleSelect)}
        >
          <Icon name="pin" size={16} />
        </button>
        <button
          className="tile-btn"
          aria-label={fullscreen ? `Sair da tela cheia ${label}` : `Tela cheia ${label}`}
          title={fullscreen ? 'Sair da tela cheia' : 'Tela cheia'}
          onClick={stop(toggleFullscreen)}
        >
          <Icon name={fullscreen ? 'minimize' : 'maximize'} size={16} />
        </button>
        {isSelf && showScreen && (
          <button className="tile-btn" aria-label={`Parar de compartilhar ${word}`} title="Parar de compartilhar esta tela" onClick={stop(onStopShare)}>
            <Icon name="screenOff" size={16} />
          </button>
        )}
        {showScreen && !isSelf ? (
          <button className="tile-btn" aria-label={`Fechar ${word} de ${name}`} title="Parar de ver a tela (só para você)" onClick={stop(onCloseScreen)}>
            <Icon name="close" size={16} />
          </button>
        ) : (
          <button className="tile-btn" aria-label={`Fechar ${label}`} title="Parar de visualizar (só para você)" onClick={stop(onHide)}>
            <Icon name="close" size={16} />
          </button>
        )}
      </div>
      <figcaption>
        <span className="tile-name">{caption}</span>
        {isPerson && !audioOn && (
          <span className="tile-flag" title="Microfone desligado">
            <Icon name="micOff" size={14} />
          </span>
        )}
        {isPerson && voice.muted && !isSelf && (
          <span className="tile-flag tile-flag-local" title="Você silenciou esta pessoa">
            <Icon name="volumeOff" size={14} />
          </span>
        )}
        {showScreen && !isSelf && tab.muted && (
          <span className="tile-flag tile-flag-local" title="O som da aba está silenciado">
            <Icon name="volumeOff" size={14} />
          </span>
        )}
        {!isSelf && isPerson && (
          <span className={`badge badge-${conn}`} data-testid="conn-badge">
            {CONN_LABEL[conn]}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
