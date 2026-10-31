'use client';

import { useEffect, useRef, useState } from 'react';
import { fetchRoomPreview, type RoomPreview } from '@/lib/room-preview';
import { normalizeRoom } from '@/lib/validation';

/** Espera depois da última tecla antes de consultar: digitar "reunião" não pode virar 7 requisições (a cota da Vercel é curta). */
export const PREVIEW_DEBOUNCE_MS = 400;

/**
 * Preview público da sala que está sendo digitada: existe? quantas pessoas? tem senha? Uma consulta por pausa na
 * digitação (sem polling), a anterior é cancelada, e qualquer falha só esconde o preview. A primeira consulta, com o
 * nome já vindo preenchido do link (`?room=`), sai sem espera.
 */
export function useRoomPreview(room: string): RoomPreview | null {
  const [preview, setPreview] = useState<RoomPreview | null>(null);
  const first = useRef(true);

  useEffect(() => {
    const name = room.trim();
    if (!normalizeRoom(name)) {
      setPreview(null);
      return;
    }
    const wait = first.current ? 0 : PREVIEW_DEBOUNCE_MS;
    first.current = false;
    const ctl = new AbortController();
    const timer = setTimeout(async () => {
      const result = await fetchRoomPreview(name, fetch, ctl.signal);
      if (!ctl.signal.aborted) setPreview(result);
    }, wait);
    return () => {
      clearTimeout(timer);
      ctl.abort();
    };
  }, [room]);

  return preview;
}
