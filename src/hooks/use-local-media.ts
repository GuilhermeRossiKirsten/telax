'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { describeMediaError } from './media-errors';

export type LocalTracks = {
  audio: MediaStreamTrack | null;
  camera: MediaStreamTrack | null;
  screen: MediaStreamTrack | null;
  /** som da aba compartilhada (só existe se o navegador o entregou e o usuário marcou "compartilhar áudio") */
  screenAudio: MediaStreamTrack | null;
};

const ATTEMPTS: MediaStreamConstraints[] = [{ audio: true, video: true }, { audio: true }, { video: true }];

const stopStream = (s: MediaStream | null) => s?.getTracks().forEach((t) => t.stop());

/**
 * Captura câmera+microfone uma vez (já mutados) e tela sob demanda. Mutar/desligar usa `track.enabled`,
 * então o envio continua negociado (sem renegociar) e o estado vai para os outros via servidor.
 */
export function useLocalMedia() {
  const [camera, setCamera] = useState<MediaStream | null>(null);
  const [screen, setScreen] = useState<MediaStream | null>(null);
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const screenRef = useRef<MediaStream | null>(null);
  const cameraRef = useRef<MediaStream | null>(null);
  const releasedRef = useRef(false);
  const aliveRef = useRef(true);
  const micSeqRef = useRef(0);

  useEffect(() => {
    let cancelled = false;
    aliveRef.current = true;

    (async () => {
      if (!navigator.mediaDevices?.getUserMedia) {
        setError('Este navegador não oferece acesso à câmera. Use HTTPS ou localhost.');
        return;
      }
      let lastError: unknown;
      for (const constraints of ATTEMPTS) {
        try {
          const stream = await navigator.mediaDevices.getUserMedia(constraints);
          // `released`: a sala recusou a entrada enquanto a permissão ainda estava pendente
          if (cancelled || releasedRef.current) return stopStream(stream);
          // entra mutado: o dispositivo fica aberto (ligar depois é instantâneo), mas nada é enviado
          stream.getTracks().forEach((t) => (t.enabled = false));
          cameraRef.current = stream;
          setCamera(stream);
          setMicOn(false);
          setCamOn(false);
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
      aliveRef.current = false;
      // cameraRef (e não o stream da captura inicial): o selectMic pode ter trocado o stream da câmera
      stopStream(cameraRef.current);
      cameraRef.current = null;
      stopStream(screenRef.current);
      screenRef.current = null;
    };
  }, []);

  /** Solta câmera, microfone e tela (luz da câmera apagada) quando não há chamada, ex.: sala cheia. */
  const stopAll = useCallback(() => {
    releasedRef.current = true;
    stopStream(cameraRef.current);
    cameraRef.current = null;
    stopStream(screenRef.current);
    screenRef.current = null;
    setCamera(null);
    setScreen(null);
    setMicOn(false);
    setCamOn(false);
  }, []);

  /**
   * Troca o microfone em uso sem derrubar a chamada: captura o novo dispositivo e entrega um stream novo
   * (mesmo vídeo + novo áudio), o que faz o use-room dar `replaceTrack` nas conexões. O estado ligado/mutado é herdado.
   */
  const selectMic = useCallback(
    async (deviceId: string) => {
      const current = cameraRef.current ?? camera;
      if (!deviceId || !current || releasedRef.current) return;
      const old = current.getAudioTracks()[0];
      if (old && old.readyState === 'live' && old.getSettings().deviceId === deviceId) return;

      const seq = ++micSeqRef.current;
      let fresh: MediaStream;
      try {
        fresh = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
      } catch {
        // continua com o microfone anterior: a chamada não cai por causa de um dispositivo que não abriu
        if (aliveRef.current && seq === micSeqRef.current) setError('Não foi possível usar esse microfone.');
        return;
      }
      const track = fresh.getAudioTracks()[0];
      const base = cameraRef.current;
      // saiu da sala, desmontou ou outra troca mais nova chegou enquanto a permissão/captura estava pendente
      if (!track || !base || !aliveRef.current || releasedRef.current || seq !== micSeqRef.current) {
        stopStream(fresh);
        return;
      }
      const previous = base.getAudioTracks()[0];
      track.enabled = previous ? previous.enabled : false;
      const next = new MediaStream([track, ...base.getVideoTracks()]);
      cameraRef.current = next;
      setCamera(next);
      setMicOn(track.enabled);
      previous?.stop();
    },
    [camera],
  );

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
      const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
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
      screenAudio: screen?.getAudioTracks()[0] ?? null,
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
    sharingAudio: tracks.screenAudio !== null,
    hasMic: tracks.audio !== null,
    hasCam: tracks.camera !== null,
    error,
    stopAll,
    selectMic,
    toggleMic,
    toggleCam,
    toggleScreen,
  };
}
