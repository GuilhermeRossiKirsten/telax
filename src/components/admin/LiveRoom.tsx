'use client';

import { useEffect, useRef, useState } from 'react';
import { useAdminLive } from '@/hooks/use-admin-live';
import type { AdminPeer } from '@/lib/admin-types';
import { screenLabel, slotsFromMask } from '@/lib/screens';
import './admin.css';

const STATUS_TEXT: Record<string, string> = {
  connecting: 'Conectando à sala…',
  online: 'Ao vivo',
  reconnecting: 'Reconectando…',
};

/** O fluxo tem vídeo agora? Acompanha faixas que chegam ou saem depois. */
function useHasVideo(stream: MediaStream | null): boolean {
  const [has, setHas] = useState(() => !!stream && stream.getVideoTracks().length > 0);
  useEffect(() => {
    if (!stream) {
      setHas(false);
      return;
    }
    const sync = () => setHas(stream.getVideoTracks().length > 0);
    sync();
    stream.addEventListener('addtrack', sync);
    stream.addEventListener('removetrack', sync);
    return () => {
      stream.removeEventListener('addtrack', sync);
      stream.removeEventListener('removetrack', sync);
    };
  }, [stream]);
  return has;
}

/** Vídeo sempre mudo (o som é opcional e separado); "sem vídeo" quando não há imagem chegando. */
function StreamTile({ stream, label, enabled }: { stream: MediaStream | null; label: string; enabled: boolean }) {
  const ref = useRef<HTMLVideoElement>(null);
  const hasVideo = useHasVideo(stream) && enabled;

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    v.srcObject = hasVideo ? stream : null;
    if (hasVideo) v.play().catch(() => {});
    return () => {
      v.srcObject = null;
    };
  }, [stream, hasVideo]);

  return (
    <div className="adm-stream" role="group" aria-label={label}>
      <video ref={ref} autoPlay playsInline muted aria-label={`Imagem: ${label}`} style={{ visibility: hasVideo ? 'visible' : 'hidden' }} />
      {!hasVideo && <div className="adm-stream-empty">sem vídeo</div>}
      <span className="adm-stream-label">{label}</span>
    </div>
  );
}

/** Som da câmera da pessoa, só enquanto o admin escolhe ouvir (o clique é o gesto que libera o áudio). */
function Listen({ stream }: { stream: MediaStream }) {
  const ref = useRef<HTMLAudioElement>(null);
  useEffect(() => {
    const a = ref.current;
    if (!a) return;
    a.srcObject = stream;
    a.play().catch(() => {});
    return () => {
      a.srcObject = null;
    };
  }, [stream]);
  return <audio ref={ref} autoPlay />;
}

/**
 * Visão ao vivo: o admin entra na sala como observador (só recebe) e vê a câmera e as telas de cada pessoa.
 * Monte-o apenas enquanto estiver aberto: desmontar sai da sala e fecha as conexões extras.
 */
export function LiveRoom({ room, peers }: { room: string; peers: AdminPeer[] }) {
  const live = useAdminLive(room);
  const [listening, setListening] = useState<Record<string, boolean>>({});
  const people = peers.filter((p) => !p.observer);
  const statusText = STATUS_TEXT[live.status] ?? 'Não foi possível observar a sala agora.';
  const failed = !(live.status in STATUS_TEXT);

  return (
    <section aria-label={`Visão ao vivo da sala ${room}`} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
      <p className="adm-feedback" data-kind={failed ? 'error' : 'ok'} role={failed ? 'alert' : 'status'}>
        {statusText}
      </p>
      <p className="adm-note">
        Enquanto esta visão está aberta, os participantes veem um aviso de que a administração pode estar vendo as câmeras e telas. O áudio fica mudo até
        você escolher ouvir.
      </p>

      {people.length === 0 ? (
        <p className="adm-muted">Ninguém na sala para mostrar.</p>
      ) : (
        <div className="adm-live">
          {people.map((p) => {
            const streams = live.remoteStreams[p.id];
            const slots = slotsFromMask(p.screenSlots);
            const isListening = !!listening[p.id];
            return (
              <article key={p.id} className="adm-person" aria-label={`Ao vivo: ${p.name}`}>
                <div className="adm-person-head">
                  <span>{p.name}</span>
                  <span className="adm-spacer" />
                  <button
                    type="button"
                    className="adm-btn adm-btn-sm"
                    aria-pressed={isListening}
                    aria-label={isListening ? `Parar de ouvir ${p.name}` : `Ouvir ${p.name}`}
                    disabled={!streams}
                    onClick={() => setListening((cur) => ({ ...cur, [p.id]: !cur[p.id] }))}
                  >
                    {isListening ? 'Mudo' : 'Ouvir'}
                  </button>
                </div>
                <div className="adm-person-media">
                  <StreamTile stream={streams?.camera ?? null} label={`Câmera de ${p.name}`} enabled={p.video} />
                  {slots.map((slot) => (
                    <StreamTile key={slot} stream={streams?.screens?.[slot] ?? null} label={screenLabel(p.name, slot)} enabled />
                  ))}
                </div>
                {isListening && streams && <Listen stream={streams.camera} />}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
}
