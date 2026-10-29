import { isSlotMask } from './screens';
import type { PeerInfo, PeerMediaState } from './types';

const MAX_LABEL = 40;
const MAX_CHAT = 2000;

function trimmed(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value.length >= 1 && value.length <= max ? value : null;
}

/** O Next entrega params de página ainda codificados; devolve a entrada se não der para decodificar. */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeRoom(raw: unknown): string | null {
  return trimmed(raw, MAX_LABEL)?.toLowerCase() ?? null;
}

export function normalizeName(raw: unknown): string | null {
  return trimmed(raw, MAX_LABEL);
}

export function normalizeChat(raw: unknown): string | null {
  return trimmed(raw, MAX_CHAT);
}

export type MediaState = Pick<PeerInfo, 'audio' | 'video' | 'sharing' | 'screenSlots'>;

/**
 * Deriva `screenSlots` e `sharing` de um estado já tipado. `screenSlots` válido manda; sem ele (ou inválido),
 * `sharing` vira um slot (0) ou nenhum.
 */
export function resolveMediaState(state: PeerMediaState): MediaState {
  const screenSlots = isSlotMask(state.screenSlots) ? state.screenSlots : state.sharing ? 1 : 0;
  return { audio: state.audio, video: state.video, sharing: screenSlots > 0, screenSlots };
}

/**
 * Corpo de POST /state. `audio` e `video` são booleanos; precisa vir `sharing` (boolean) e/ou `screenSlots`
 * (máscara válida). Qualquer campo presente e inválido, ou nenhum dos dois, → null (400).
 */
export function parseMediaState(body: Record<string, unknown>): MediaState | null {
  const { audio, video, sharing, screenSlots } = body;
  if (typeof audio !== 'boolean' || typeof video !== 'boolean') return null;
  if (sharing !== undefined && typeof sharing !== 'boolean') return null;
  if (screenSlots !== undefined && !isSlotMask(screenSlots)) return null;
  if (sharing === undefined && screenSlots === undefined) return null;
  return resolveMediaState({ audio, video, sharing: sharing ?? false, screenSlots });
}
