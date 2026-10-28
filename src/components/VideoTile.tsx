'use client';

import { useEffect, useRef, useState } from 'react';
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
  name: string;
  isSelf?: boolean;
  kind?: 'camera' | 'screen';
  audioOn?: boolean;
  videoOn?: boolean;
  conn: ConnState | 'self';
};

export function VideoTile({ stream, name, isSelf = false, kind = 'camera', audioOn = true, videoOn = true, conn }: Props) {
  const ref = useRef<HTMLVideoElement>(null);
  const [blocked, setBlocked] = useState(false);

  useEffect(() => {
    const video = ref.current;
    if (!video) return;
    video.srcObject = stream;
    if (stream) video.play().then(() => setBlocked(false), () => setBlocked(true));
    return () => {
      video.srcObject = null;
    };
  }, [stream]);

  const hasVideo = !!stream && stream.getVideoTracks().length > 0 && (kind === 'screen' || videoOn);
  const label = kind === 'screen' ? `Tela de ${name}` : isSelf ? `${name} (você)` : name;

  return (
    <figure className={`tile ${kind === 'screen' ? 'tile-screen' : ''}`} data-conn={conn} data-testid={`tile-${kind}`}>
      <video
        ref={ref}
        autoPlay
        playsInline
        muted={isSelf}
        className={isSelf && kind === 'camera' ? 'mirrored' : undefined}
        style={{ visibility: hasVideo ? 'visible' : 'hidden' }}
      />
      {!hasVideo && (
        <div className="avatar" aria-hidden="true">
          {name.slice(0, 1).toUpperCase()}
        </div>
      )}
      {blocked && (
        <button className="unblock" onClick={() => ref.current?.play().then(() => setBlocked(false), () => {})}>
          Clique para ativar o áudio
        </button>
      )}
      <figcaption>
        <span className="tile-name">{label}</span>
        {kind === 'camera' && !audioOn && (
          <span className="tile-flag" title="Microfone desligado">
            <Icon name="micOff" size={14} />
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
