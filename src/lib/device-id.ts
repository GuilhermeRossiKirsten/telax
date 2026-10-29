/**
 * Identificador do dispositivo (navegador): um UUID aleatório guardado em localStorage e enviado em todo `join`.
 * Serve ao banimento por dispositivo no painel de admin. NÃO é o endereço MAC: o MAC é inacessível a páginas web.
 * Quem limpa o armazenamento ganha um id novo (limite conhecido; por isso o bloqueio também usa o IP).
 */

export const DEVICE_ID_KEY = 'telax:device-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Store = Pick<Storage, 'getItem' | 'setItem'>;

/** Se o armazenamento não funciona (janela privada, bloqueado), o id vale só enquanto a página existir. */
let sessionId: string | null = null;

export function getDeviceId(storage?: Store): string {
  try {
    const store = storage ?? localStorage;
    const saved = store.getItem(DEVICE_ID_KEY);
    if (saved && UUID.test(saved)) return saved;
    const fresh = crypto.randomUUID();
    store.setItem(DEVICE_ID_KEY, fresh);
    return fresh;
  } catch {
    return (sessionId ??= crypto.randomUUID());
  }
}
