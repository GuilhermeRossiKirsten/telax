'use client';

import { useEffect, useRef } from 'react';
import { loadSoundPrefs, playPresenceChimes } from '@/lib/chime';
import { diffPresence } from '@/lib/presence';

/**
 * Toca um som baixo quando a sala muda de gente:
 * - a PRÓPRIA entrada (primeira vez online) toca "entrar";
 * - quem já estava na sala no primeiro retrato não toca nada;
 * - depois disso, outras pessoas entrando/saindo tocam "entrar"/"sair" (várias de uma vez = um toque);
 * - reentrada silenciosa do cliente (o servidor "esqueceu" o peer: novo selfId) só atualiza a referência.
 * A preferência é lida na hora de tocar, então vale imediatamente e entre abas.
 */
export function useRoomSounds(selfId: string | null, sortedIds: string[], sinkId?: string) {
  const prevSelf = useRef<string | null>(null);
  const baseline = useRef<string[]>([]);
  const sink = useRef(sinkId);
  useEffect(() => {
    sink.current = sinkId;
  });

  const key = sortedIds.join(',');
  useEffect(() => {
    if (!selfId) return;
    const ids = key ? key.split(',') : [];
    const play = (change: { joined: number; left: number }) => {
      if (loadSoundPrefs().enabled) void playPresenceChimes(change, sink.current);
    };
    if (prevSelf.current === null) play({ joined: 1, left: 0 });
    else if (prevSelf.current === selfId) play(diffPresence(baseline.current, ids, selfId));
    prevSelf.current = selfId;
    baseline.current = ids;
  }, [selfId, key]);
}
