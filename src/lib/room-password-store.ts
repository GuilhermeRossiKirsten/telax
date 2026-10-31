/**
 * Senha da sala digitada nesta aba. Fica em `sessionStorage` (some ao fechar a aba), nunca na URL: assim recarregar a
 * página ou reentrar depois de um 410 não pede a senha de novo, e ela não vai para histórico nem para logs.
 */

type Store = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const key = (room: string) => `telax:room-pw:${room.trim()}`;
const session = (): Store | undefined => (typeof sessionStorage === 'undefined' ? undefined : sessionStorage);

export function saveRoomPassword(room: string, password: string, storage: Store | undefined = session()): void {
  if (!password) return;
  try {
    storage?.setItem(key(room), password);
  } catch {
    /* janela privada ou armazenamento cheio: vale só para esta carga da página */
  }
}

export function loadRoomPassword(room: string, storage: Store | undefined = session()): string | undefined {
  try {
    const v = storage?.getItem(key(room));
    return typeof v === 'string' && v ? v : undefined;
  } catch {
    return undefined;
  }
}

export function clearRoomPassword(room: string, storage: Store | undefined = session()): void {
  try {
    storage?.removeItem(key(room));
  } catch {
    /* nada a fazer */
  }
}
