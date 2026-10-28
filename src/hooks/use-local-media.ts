'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeMediaError } from './media-errors';

export type LocalTracks = {
  audio: MediaStreamTrack | null;
  camera: MediaStreamTrack | null;
  screen: MediaStreamTrack | null;
};

const ATTEMPTS: MediaStreamConstraints[] = [{ audio: true, video: true }, { audio: true }, { video: true }];

const stopStream = (s: MediaStream | null) => s?.getTracks().forEach((t) => t.stop());

/**
 * Captura câmera+microfone uma vez e tela sob demanda. Mutar/desligar usa `track.enabled`,
 * então o envio continua negociado (sem renegociar) e o estado vai para os outros via servidor.
 */
export function useLocalMedia() {
  const [camera, setCamera] = useState<MediaStream | null>(null);
  const [screen, setScreen] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const screenRef = useRef<MediaStream | null>(null);

  useEffect(() => {
    let cancelled = false;
    let acquired: MediaStream | null = null;

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Este navegador não oferece acesso à câmera. Use HTTPS ou localhost.');
        return;
      }
      let lastError: unknown;
      for (const constraints of ATTEMPTS) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          if (cancelled) return stopStream(stream);
          acquired = stream;
          setCamera(stream);
          setMicOn(stream.getAudioTracks().length > 0);
          setCamOn(stream.getVideoTracks().length > 0);
          if (constraints !== ATTEMPTS[0]) {
            setError(
              constraints.video
                ? 'Microfone indisponível: você entrou só com vídeo.'
                : 'Câmera indisponível: você entrou só com áudio.',
            );
          }
          return;
        } catch (e) {
          lastError = e;
        }
      }
      if (!cancelled) setError(describeMediaError(lastError));
    })();

    return () => {
      cancelled = true;
      stopStream(acquired);
      stopStream(screenRef.current);
      screenRef.current = null;
    };
  }, []);

  const toggleMic = useCallback(() => {
    const t = camera?.getAudioTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    setMicOn(t.enabled);
  }, [camera]);

  const toggleCam = useCallback(() => {
    const t = camera?.getVideoTracks()[0];
    if (!t) return;
    t.enabled = !t.enabled;
    setCamOn(t.enabled);
  }, [camera]);

  const stopScreen = useCallback(() => {
    stopStream(screenRef.current);
    screenRef.current = null;
    setScreen(null);
  }, []);

  const toggleScreen = useCallback(async () => {
    if (screenRef.current) return stopScreen();
    try {
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      // o botão "parar compartilhamento" do navegador encerra o track por fora do nosso botão
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        if (screenRef.current === stream) stopScreen();
      }, { once: true });
      screenRef.current = stream;
      setScreen(stream);
    } catch (e) {
      if (e instanceof Error && e.name === 'NotAllowedError') return; // usuário cancelou o seletor
      setError('Não foi possível compartilhar a tela neste navegador.');
    }
  }, [stopScreen]);

  const tracks = useMemo<LocalTracks>(
    () => ({
      audio: camera?.getAudioTracks()[0] ?? null,
      camera: camera?.getVideoTracks()[0] ?? null,
      screen: screen?.getVideoTracks()[0] ?? null,
    }),
    [camera, screen],
  );

  return {
    camera,
    screen,
    tracks,
    micOn,
    camOn,
    sharing: screen !== null,
    hasMic: tracks.audio !== null,
    hasCam: tracks.camera !== null,
    error,
    toggleMic,
    toggleCam,
    toggleScreen,
  };
}
