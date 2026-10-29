import { ADMIN_MESSAGE_MAX, type AdminCommand, type AdminEventPayload } from './admin-types';
import { MAX_SCREENS } from './screens';

/**
 * Valida o payload de um evento `admin` vindo da rede. Nada que o cliente não entenda vira ação: texto vazio,
 * comando desconhecido ou slot inválido são descartados (e expulsão/banimento/encerramento não são eventos).
 */
export function parseAdminEvent(payload: unknown): AdminEventPayload | null {
  if (!payload || typeof payload !== 'object') return null;
  const p = payload as Record<string, unknown>;
  const at = typeof p.at === 'number' && Number.isFinite(p.at) ? p.at : Date.now();

  if (p.kind === 'message') {
    if (typeof p.text !== 'string') return null;
    const text = p.text.trim().slice(0, ADMIN_MESSAGE_MAX);
    return text ? { kind: 'message', text, at } : null;
  }

  if (p.kind === 'command') {
    switch (p.what) {
      case 'screens':
      case 'camera':
      case 'mic':
      case 'all':
        return { kind: 'command', what: p.what, at };
      case 'screen':
        return isSlot(p.slot) ? { kind: 'command', what: 'screen', slot: p.slot, at } : null;
    }
  }
  return null;
}

const isSlot = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v < MAX_SCREENS;

export type AdminAction = { do: 'stopScreens' } | { do: 'stopScreen'; slot: number } | { do: 'camOff' } | { do: 'micOff' };

/** Traduz o comando do admin nas ações locais (sem tocar em nada). Comando incompleto não faz nada. */
export function planAdminCommand(cmd: AdminCommand): AdminAction[] {
  switch (cmd.what) {
    case 'screens':
      return [{ do: 'stopScreens' }];
    case 'screen':
      return isSlot(cmd.slot) ? [{ do: 'stopScreen', slot: cmd.slot }] : [];
    case 'camera':
      return [{ do: 'camOff' }];
    case 'mic':
      return [{ do: 'micOff' }];
    case 'all':
      return [{ do: 'stopScreens' }, { do: 'camOff' }, { do: 'micOff' }];
  }
}

export type AdminCommandControls = {
  micOn: boolean;
  camOn: boolean;
  toggleMic(): void;
  toggleCam(): void;
  stopAllScreens(): void;
  stopScreen(slot: number): void;
};

/** Executa as ações. Câmera e microfone só alternam se estiverem ligados (alternar de novo os ligaria). */
export function runAdminActions(actions: AdminAction[], c: AdminCommandControls): void {
  for (const a of actions) {
    switch (a.do) {
      case 'stopScreens':
        c.stopAllScreens();
        break;
      case 'stopScreen':
        c.stopScreen(a.slot);
        break;
      case 'camOff':
        if (c.camOn) c.toggleCam();
        break;
      case 'micOff':
        if (c.micOn) c.toggleMic();
        break;
    }
  }
}
