'use client';

import { useEffect, useRef } from 'react';
import { applySinkId } from '@/lib/devices';

type Props = {
  /** id do tile (`camera:<peer>` ou `screen:<peer>`) */
  id: string;
  stream: MediaStream | null;
  /** silenciado só neste navegador */
  muted: boolean;
  /** saída de áudio escolhida nas Configurações */
  sinkId?: string;
  /** muda a cada "ativar o áudio" do usuário, para tentar tocar de novo dentro do gesto */
  retry: number;
  onBlocked(id: string, blocked: boolean): void;
};

/**
 * O som de cada tile mora aqui, num elemento que nunca muda de lugar: ocultar, maximizar ou trocar de
 * layout só mexe na imagem (o <video> do tile fica sempre mudo), então o áudio não corta nem remonta.
 */
export function RemoteAudio({ id, stream, muted, sinkId, retry, onBlocked }: Props) {
  const ref = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    const audio = ref.current;
    if (!audio) return;
    let cancelled = false;
    (async () => {
      // a saída é escolhida antes de começar a tocar: nada vaza pelo alto-falante padrão
      if (sinkId) await applySinkId(audio, sinkId);
      if (cancelled) return;
      audio.srcObject = stream;
      if (!stream) return onBlocked(id, false);
      try {
        await audio.play();
        if (!cancelled) onBlocked(id, false);
      } catch {
        if (!cancelled) onBlocked(id, true); // o navegador exige um gesto antes de tocar som
      }
    })();
    return () => {
      cancelled = true;
      audio.srcObject = null;
      onBlocked(id, false);
    };
  }, [id, stream, sinkId, retry, onBlocked]);

  return <audio ref={ref} autoPlay muted={muted} data-testid={`audio-${id}`} />;
}
