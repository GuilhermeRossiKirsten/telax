'use client';

import { useEffect, useRef, type MouseEvent } from 'react';
import type { ConnState } from '@/lib/peer-manager';
import { Icon } from './Icon';

export const CONN_LABEL: Record<ConnState | 'self', string> = {
  self: 'Você',
  connecting: 'Conectando',
  connected: 'Conectado',
  reconnecting: 'Reconectando',
  failed: 'Falhou',
};

type Props = {
  stream: MediaStream | null;
  /** nome completo mostrado no tile e nos botões (ex.: "Tela de Ana") */
  label: string;
  name: string;
  isSelf?: boolean;
  kind?: 'camera' | 'screen';
  audioOn?: boolean;
  videoOn?: boolean;
  conn: ConnState | 'self';
  /** áudio silenciado só neste navegador (o som em si toca no RemoteAudio; aqui só os controles e o selo) */
  muted?: boolean;
  /** volume de 0 a 1 só neste navegador */
  volume?: number;
  /** é o tile em destaque */
  selected?: boolean;
  onToggleMuted?(): void;
  onVolume?(volume: number): void;
  /** fechar = parar de visualizar (a faixa "Fechadas" permite abrir de novo) */
  onClose?(): void;
  onToggleSelect?(): void;
};

export function VideoTile({
  stream,
  label,
  name,
  isSelf = false,
  kind = 'camera',
  audioOn = true,
  videoOn = true,
  conn,
  muted = false,
  volume = 1,
  selected = false,
  onToggleMuted,
  onVolume,
  onClose,
  onToggleSelect,
}: Props) {
  const ref = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    if (stream) video.play().catch(() => {}); // mudo: o autoplay é sempre permitido
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  const hasVideo = !!stream && stream.getVideoTracks().length > 0 && (kind === 'screen' || videoOn);
  // a própria imagem não tem som para ajustar (evita eco); câmera e tela dos outros sim
  const hasSound = !isSelf;
  const stop = (fn?: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn?.();
  };

  return (
    <figure
      className={`tile ${kind === 'screen' ? 'tile-screen' : ''}`}
      data-conn={conn}
      data-testid={`tile-${kind}`}
      data-selected={selected ? 'true' : undefined}
      onClick={onToggleSelect}
    >
      <video
        ref={ref}
        autoPlay
        playsInline
        muted
        className={isSelf && kind === 'camera' ? 'mirrored' : undefined}
        style={{ visibility: hasVideo ? 'visible' : 'hidden' }}
      />
      {!hasVideo && (
        <div className="avatar" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </div>
      )}
      {/* overlay sobre a imagem: aparece ao passar o mouse ou focar; o clique no corpo do tile seleciona */}
      <div className="tile-actions" onClick={(e) => e.stopPropagation()}>
        {hasSound && (
          <div className="tile-volume">
            <button
              className="tile-btn"
              aria-label={muted ? `Ativar som de ${label}` : `Silenciar ${label}`}
              title={muted ? 'Voltar a ouvir (só para você)' : 'Silenciar (só para você)'}
              onClick={stop(onToggleMuted)}
            >
              <Icon name={muted || volume === 0 ? 'volumeOff' : 'volume'} size={16} />
            </button>
            <input
              type="range"
              min={0}
              max={100}
              step={5}
              value={Math.round((muted ? 0 : volume) * 100)}
              aria-label={`Volume de ${label}`}
              onChange={(e) => onVolume?.(Number(e.target.value) / 100)}
            />
          </div>
        )}
        <button
          className="tile-btn"
          aria-pressed={selected}
          aria-label={selected ? `Soltar ${label}` : `Destacar ${label}`}
          title={selected ? 'Voltar ao layout normal' : 'Destacar: fica grande e os outros ficam embaixo'}
          onClick={stop(onToggleSelect)}
        >
          <Icon name={selected ? 'minimize' : 'maximize'} size={16} />
        </button>
        <button className="tile-btn" aria-label={`Fechar ${label}`} title="Parar de visualizar (só para você)" onClick={stop(onClose)}>
          <Icon name="close" size={16} />
        </button>
      </div>
      <figcaption>
        <span className="tile-name">{label}</span>
        {kind === 'camera' && !audioOn && (
          <span className="tile-flag" title="Microfone desligado">
            <Icon name="micOff" size={14} />
          </span>
        )}
        {muted && (
          <span className="tile-flag tile-flag-local" title="Você silenciou esta pessoa">
            <Icon name="volumeOff" size={14} />
          </span>
        )}
        {!isSelf && (
          <span className={`badge badge-${conn}`} data-testid="conn-badge">
            {CONN_LABEL[conn]}
          </span>
        )}
      </figcaption>
    </figure>
  );
}
