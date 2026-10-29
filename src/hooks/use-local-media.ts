'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_QUALITY, contentHintFor, describeActual, toVideoConstraints, type QualitySettings } from '@/lib/quality';
import { captureScreen } from '@/lib/screen-capture';
import { MAX_SCREENS, maskFromSlots } from '@/lib/screens';
import { describeMediaError } from './media-errors';

const MIC_ERROR = 'Não foi possível usar esse microfone.';
/** limpa só o erro do microfone (uma troca bem-sucedida), sem apagar outros avisos */
const clearMicError = (e: string | null) => (e === MIC_ERROR ? null : e);

/** Uma posição por slot de tela (sempre MAX_SCREENS); slot livre = faixas nulas. */
export type ScreenTracks = { video: MediaStreamTrack | null; audio: MediaStreamTrack | null };
export type LocalTracks = {
  audio: MediaStreamTrack | null;
  camera: MediaStreamTrack | null;
  /** telas compartilhadas por slot; o som da aba de cada uma só existe se o navegador o entregou e o usuário marcou "compartilhar áudio" */
  screens: ScreenTracks[];
};

const emptySlots = (): Array<MediaStream | null> => Array.from({ length: MAX_SCREENS }, () => null);

const ATTEMPTS: MediaStreamConstraints[] = [{ audio: true, video: true }, { audio: true }, { video: true }];

const stopStream = (s: MediaStream | null) => s?.getTracks().forEach((t) => t.stop());

/**
 * Captura câmera+microfone uma vez (já mutados) e tela sob demanda. Mutar/desligar usa `track.enabled`,
 * então o envio continua negociado (sem renegociar) e o estado vai para os outros via servidor.
 */
export function useLocalMedia() {
  const [camera, setCamera] = useState<MediaStream | null>(null);
  const [screens, setScreens] = useState<Array<MediaStream | null>>(emptySlots);
  const [micOn, setMicOn] = useState(false);
  const [camOn, setCamOn] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** espelho de `screens` para callbacks (um stream por slot; slot livre = null) */
  const screensRef = useRef<Array<MediaStream | null>>(emptySlots());
  const cameraRef = useRef<MediaStream | null>(null);
  const releasedRef = useRef(false);
  const aliveRef = useRef(true);
  const micSeqRef = useRef(0);
  /** último dispositivo de microfone em uso de fato (ou que já constatamos estar em uso) */
  const micAppliedRef = useRef<string | null>(null);
  /** dispositivo que falhou ao abrir: não repetimos em loop; outra escolha do usuário tenta de novo */
  const micFailedRef = useRef<string | null>(null);
  /** a captura inicial foi `audio: true`, ou seja, o microfone padrão do sistema */
  const micIsDefaultRef = useRef(false);
  /** dispositivo cuja captura está em andamento */
  const micPendingRef = useRef<string | null>(null);
  /** a escolha mais recente do usuário: uma captura de outro dispositivo que termine depois é descartada */
  const micWantedRef = useRef<string | null>(null);
  /** qualidade escolhida nas Configurações; vale para a câmera ao abrir e para a tela ao compartilhar */
  const qualityRef = useRef<QualitySettings>(DEFAULT_QUALITY);
  /** o que a captura realmente entrega (pode diferir do pedido: o dispositivo manda) */
  const [inUse, setInUse] = useState({ camera: '', screen: '' });

  const applyQuality = useCallback(async (kind: 'camera' | 'screen', track?: MediaStreamTrack) => {
    if (!track || track.readyState !== 'live') return;
    const q = qualityRef.current;
    try {
      await track.applyConstraints(toVideoConstraints(kind, q));
    } catch {
      /* o dispositivo não aceita essa combinação: segue com o que já entrega */
    }
    if (kind === 'screen') (track as MediaStreamTrack & { contentHint?: string }).contentHint = contentHintFor(q.screen.priority);
    if (aliveRef.current) setInUse((prev) => ({ ...prev, [kind]: describeActual(track.getSettings()) }));
  }, []);

  /** Aplica a qualidade escolhida à câmera e à tela que já estão abertas (e guarda para as próximas). */
  const setQuality = useCallback(
    (q: QualitySettings) => {
      qualityRef.current = q;
      void applyQuality('camera', cameraRef.current?.getVideoTracks()[0]);
      for (const stream of screensRef.current) void applyQuality('screen', stream?.getVideoTracks()[0]);
    },
    [applyQuality],
  );

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
          micIsDefaultRef.current = stream.getAudioTracks().length > 0;
          setCamera(stream);
          void applyQuality('camera', stream.getVideoTracks()[0]);
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
      screensRef.current.forEach(stopStream);
      screensRef.current = emptySlots();
    };
  }, [applyQuality]);

  /** Solta câmera, microfone e tela (luz da câmera apagada) quando não há chamada, ex.: sala cheia. */
  const stopAll = useCallback(() => {
    releasedRef.current = true;
    stopStream(cameraRef.current);
    cameraRef.current = null;
    screensRef.current.forEach(stopStream);
    screensRef.current = emptySlots();
    setCamera(null);
    setScreens(emptySlots());
    setMicOn(false);
    setCamOn(false);
  }, []);

  /**
   * Troca o microfone em uso sem derrubar a chamada: captura o novo dispositivo e entrega um stream novo
   * (mesmo vídeo + novo áudio), o que faz o use-room dar `replaceTrack` nas conexões. O estado ligado/mutado é herdado.
   */
  const selectMic = useCallback(async (deviceId: string) => {
    // ainda sem câmera (ou já solta): não registra nada, o chamador repete quando o stream existir
    const current = cameraRef.current;
    if (!deviceId || !current || releasedRef.current) return;
    micWantedRef.current = deviceId;

    if (deviceId === micAppliedRef.current) {
      micFailedRef.current = null; // o usuário voltou ao que funciona: um dispositivo que falhou pode ser tentado de novo depois
      return;
    }
    if (deviceId === micFailedRef.current || deviceId === micPendingRef.current) return;

    // o track atual já é esse dispositivo (ids iguais, ou "default" quando a captura inicial foi o padrão do sistema)
    const old = current.getAudioTracks()[0];
    if (old && old.readyState === 'live') {
      const same = old.getSettings().deviceId === deviceId || (deviceId === 'default' && micIsDefaultRef.current);
      if (same) {
        micAppliedRef.current = deviceId;
        micFailedRef.current = null;
        setError(clearMicError);
        return;
      }
    }

    const seq = ++micSeqRef.current;
    micPendingRef.current = deviceId;
    let fresh: MediaStream;
    try {
      fresh = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: deviceId } } });
    } catch {
      if (micPendingRef.current === deviceId) micPendingRef.current = null;
      // continua com o microfone anterior: a chamada não cai por causa de um dispositivo que não abriu
      if (aliveRef.current && seq === micSeqRef.current) {
        micFailedRef.current = deviceId;
        setError(MIC_ERROR);
      }
      return;
    }
    if (micPendingRef.current === deviceId) micPendingRef.current = null;
    const track = fresh.getAudioTracks()[0];
    const base = cameraRef.current;
    // saiu da sala, desmontou, ou chegou uma escolha mais nova enquanto a permissão/captura estava pendente
    if (!track || !base || !aliveRef.current || releasedRef.current || seq !== micSeqRef.current || micWantedRef.current !== deviceId) {
      stopStream(fresh);
      return;
    }
    const previous = base.getAudioTracks()[0];
    track.enabled = previous ? previous.enabled : false;
    const next = new MediaStream([track, ...base.getVideoTracks()]);
    cameraRef.current = next;
    micAppliedRef.current = deviceId;
    micFailedRef.current = null;
    micIsDefaultRef.current = false;
    setCamera(next);
    setMicOn(track.enabled);
    setError(clearMicError);
    previous?.stop();
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

  /** Para a tela de um slot (e só ela): as outras continuam. */
  const stopScreen = useCallback((slot: number) => {
    const stream = screensRef.current[slot];
    if (!stream) return;
    stopStream(stream);
    const next = [...screensRef.current];
    next[slot] = null;
    screensRef.current = next;
    setScreens(next);
    if (next.every((x) => x === null)) setInUse((prev) => ({ ...prev, screen: '' }));
  }, []);

  const stopAllScreens = useCallback(() => {
    screensRef.current.forEach(stopStream);
    screensRef.current = emptySlots();
    setScreens(emptySlots());
    setInUse((prev) => ({ ...prev, screen: '' }));
  }, []);

  /** Adiciona uma tela (o navegador abre o seletor) no primeiro slot livre; no limite não faz nada. */
  const addScreen = useCallback(async () => {
    const slot = screensRef.current.findIndex((x) => x === null);
    if (slot < 0) return;
    try {
      const stream = await captureScreen((o) => navigator.mediaDevices.getDisplayMedia(o), {
        systemAudio: qualityRef.current.screen.systemAudio,
      });
      // o botão "parar compartilhamento" do navegador encerra o track por fora do nosso botão
      stream.getVideoTracks()[0].addEventListener('ended', () => {
        if (screensRef.current[slot] === stream) stopScreen(slot);
      }, { once: true });
      // o slot pode ter sido ocupado (ou tudo solto) enquanto o seletor estava aberto
      if (!aliveRef.current || releasedRef.current || screensRef.current[slot]) return stopStream(stream);
      const next = [...screensRef.current];
      next[slot] = stream;
      screensRef.current = next;
      setScreens(next);
      void applyQuality('screen', stream.getVideoTracks()[0]);
    } catch (e) {
      if (e instanceof Error && e.name === 'NotAllowedError') return; // usuário cancelou o seletor
      setError('Não foi possível compartilhar a tela neste navegador.');
    }
  }, [stopScreen, applyQuality]);

  const tracks = useMemo<LocalTracks>(
    () => ({
      audio: camera?.getAudioTracks()[0] ?? null,
      camera: camera?.getVideoTracks()[0] ?? null,
      screens: screens.map((st) => ({ video: st?.getVideoTracks()[0] ?? null, audio: st?.getAudioTracks()[0] ?? null })),
    }),
    [camera, screens],
  );

  const activeSlots = screens.flatMap((st, i) => (st ? [i] : []));

  return {
    camera,
    screens,
    tracks,
    micOn,
    camOn,
    sharing: activeSlots.length > 0,
    /** máscara de bits dos slots de tela ativos (vai para os outros pelo estado da sala) */
    screenSlots: maskFromSlots(activeSlots),
    screenCount: activeSlots.length,
    canAddScreen: activeSlots.length < MAX_SCREENS,
    sharingAudio: tracks.screens.some((x) => x.audio !== null),
    hasMic: tracks.audio !== null,
    hasCam: tracks.camera !== null,
    error,
    stopAll,
    selectMic,
    setQuality,
    inUse,
    toggleMic,
    toggleCam,
    addScreen,
    stopScreen,
    stopAllScreens,
  };
}
