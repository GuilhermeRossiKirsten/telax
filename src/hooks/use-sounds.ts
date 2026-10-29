'use client';

import { useCallback, useEffect, useState } from 'react';
import { loadSoundPrefs, saveSoundPrefs } from '@/lib/chime';

/** Liga/desliga os sons de entrar e sair (lembrado no navegador). O valor só é lido num effect (SSR-safe). */
export function useSounds() {
  const [enabled, setEnabledState] = useState(true);

  useEffect(() => {
    setEnabledState(loadSoundPrefs().enabled);
  }, []);

  const setEnabled = useCallback((value: boolean) => {
    setEnabledState(value);
    saveSoundPrefs({ enabled: value });
  }, []);

  return { enabled, setEnabled };
}

export type SoundsApi = ReturnType<typeof useSounds>;
