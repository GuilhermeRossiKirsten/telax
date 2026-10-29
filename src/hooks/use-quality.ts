'use client';

import { useCallback, useEffect, useState } from 'react';
import { DEFAULT_QUALITY, loadQuality, saveQuality, type CameraQuality, type QualitySettings, type ScreenQuality } from '@/lib/quality';

/** Qualidade de transmissão escolhida pelo usuário, lembrada no navegador. Só é lida num effect (SSR-safe). */
export function useQuality() {
  const [quality, setQuality] = useState<QualitySettings>(DEFAULT_QUALITY);

  useEffect(() => {
    setQuality(loadQuality());
  }, []);

  const update = useCallback((next: QualitySettings) => {
    setQuality(next);
    saveQuality(next);
  }, []);

  const setCamera = useCallback((patch: Partial<CameraQuality>) => update({ ...quality, camera: { ...quality.camera, ...patch } }), [quality, update]);
  const setScreen = useCallback((patch: Partial<ScreenQuality>) => update({ ...quality, screen: { ...quality.screen, ...patch } }), [quality, update]);
  const reset = useCallback(() => update(DEFAULT_QUALITY), [update]);

  return { quality, setCamera, setScreen, reset };
}

export type QualityApi = ReturnType<typeof useQuality>;
