'use client';

import { useCallback, useEffect, useRef } from 'react';
import { planAdminCommand, runAdminActions, type AdminCommandControls } from '@/lib/admin-commands';
import type { AdminCommand } from '@/lib/admin-types';

/**
 * Devolve um `onAdminCommand` ESTÁVEL que executa o comando do administrador (parar telas, desligar câmera,
 * mutar o microfone) com o estado mais recente da captura local, sem recriar a callback a cada render.
 */
export function useAdminCommands(controls: AdminCommandControls) {
  const latest = useRef(controls);
  useEffect(() => {
    latest.current = controls;
  });
  return useCallback((cmd: AdminCommand) => runAdminActions(planAdminCommand(cmd), latest.current), []);
}
