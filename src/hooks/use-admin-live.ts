'use client';

import { useRoom } from '@/hooks/use-room';

/** O que a visão ao vivo usa do `useRoom` em modo observador (ponto único de acoplamento com o hook da sala). */
export type LiveParticipant = {
  id: string;
  name: string;
  audio: boolean;
  video: boolean;
  screenSlots: number;
  conn: string;
};

export type LiveRoomState = {
  status: string;
  participants: LiveParticipant[];
  remoteStreams: Record<string, { camera: MediaStream; screens: MediaStream[] }>;
};

// Constantes de módulo: o `useRoom` depende da identidade de `tracks` e `media`, e o observador nunca envia nada.
const NO_SCREEN = { video: null, audio: null };
const NO_TRACKS = { audio: null, camera: null, screens: [NO_SCREEN, NO_SCREEN, NO_SCREEN] };
const NO_MEDIA = { audio: false, video: false, sharing: false, screenSlots: 0 };

/**
 * Entra na sala como OBSERVADOR (só recebe: o servidor só aceita isso com a sessão de admin) e devolve os
 * participantes e os fluxos de câmera e telas de cada um. Monte este hook só enquanto a visão ao vivo estiver
 * aberta: cada participante abre uma conexão a mais para o admin.
 */
export function useAdminLive(room: string): LiveRoomState {
  const r = useRoom({
    room,
    name: 'Administração',
    tracks: NO_TRACKS,
    media: NO_MEDIA,
    observer: true,
  } as Parameters<typeof useRoom>[0]);
  return r as unknown as LiveRoomState;
}
