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
  /** áudio silenciado só neste navegador (o som em si toca no RemoteAudio; aqui só o botão e o selo) */
  muted?: boolean;
  maximized?: boolean;
  onToggleMuted?(): void;
  onHide?(): void;
  onToggleMaximize?(): void;
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
  maximized = false,
  onToggleMuted,
  onHide,
  onToggleMaximize,
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
  // a própria imagem já sai muda no elemento (evita eco); câmera e tela dos outros podem ser silenciadas
  const canMute = !isSelf;
  const stop = (fn?: () => void) => (e: MouseEvent) => {
    e.stopPropagation();
    fn?.();
  };

  return (
    <figure
      className={`tile ${kind === 'screen' ? 'tile-screen' : ''}`}
      data-conn={conn}
      data-testid={`tile-${kind}`}
      data-maximized={maximized ? 'true' : undefined}
      onClick={onToggleMaximize}
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
      <div className="tile-actions">
        {canMute && (
          <button
            className="tile-btn"
            aria-label={muted ? `Ativar som de ${label}` : `Silenciar ${label}`}
            title={muted ? 'Voltar a ouvir esta pessoa' : 'Parar de ouvir esta pessoa (só para você)'}
            onClick={stop(onToggleMuted)}
          >
            <Icon name={muted ? 'volumeOff' : 'volume'} size={16} />
          </button>
        )}
        <button className="tile-btn" aria-label={`Ocultar ${label}`} title="Ocultar esta tela (só para você)" onClick={stop(onHide)}>
          <Icon name="eyeOff" size={16} />
        </button>
        <button
          className="tile-btn"
          aria-label={maximized ? `Restaurar ${label}` : `Maximizar ${label}`}
          title={maximized ? 'Voltar ao layout' : 'Maximizar'}
          onClick={stop(onToggleMaximize)}
        >
          <Icon name={maximized ? 'minimize' : 'maximize'} size={16} />
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
