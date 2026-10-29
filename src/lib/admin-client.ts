/** Cliente HTTP das rotas /api/admin/** (mesma origem). O `fetch` é injetável para teste. */

import type { AdminCommand, AdminRoomDetail, AdminRoomSummary, Ban } from './admin-types';
import { friendlyError } from './admin-ui';

/** Erro de uma chamada de admin. `message` já é amigável; `status` 0 = falha de rede. */
export class AdminApiError extends Error {
  constructor(
    public status: number,
    public code?: string,
  ) {
    super(friendlyError(status, code));
    this.name = 'AdminApiError';
  }
}

type Json = Record<string, unknown>;

export function createAdminClient(doFetch: typeof fetch = (...a) => fetch(...a)) {
  async function call<T>(method: string, path: string, body?: Json): Promise<T> {
    let res: Response;
    try {
      res = await doFetch(path, {
        method,
        headers: body === undefined ? undefined : { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new AdminApiError(0);
    }
    if (!res.ok) {
      let code: string | undefined;
      try {
        const j = (await res.json()) as { error?: unknown };
        if (typeof j.error === 'string') code = j.error;
      } catch {
        /* corpo vazio ou não JSON: só o status importa */
      }
      throw new AdminApiError(res.status, code);
    }
    try {
      return (await res.json()) as T;
    } catch {
      // 200 com corpo que não é JSON (página de erro de um proxy, por exemplo): não é uma resposta da API
      throw new AdminApiError(502);
    }
  }

  const room = (name: string) => `/api/admin/rooms/${encodeURIComponent(name)}`;

  return {
    me: () => call<{ login: string; id: number }>('GET', '/api/admin/me'),
    rooms: async () => (await call<{ rooms: AdminRoomSummary[] }>('GET', '/api/admin/rooms')).rooms,
    room: (name: string) => call<AdminRoomDetail>('GET', room(name)),
    message: (name: string, text: string) => call<{ delivered: number }>('POST', `${room(name)}/message`, { text }),
    close: (name: string, reason?: string) => call<{ removed: number }>('POST', `${room(name)}/close`, { reason }),
    reopen: (name: string) => call<{ ok: boolean }>('POST', `${room(name)}/reopen`, {}),
    kick: (name: string, peerId: string, reason?: string) => call<{ ok: boolean }>('POST', `${room(name)}/kick`, { peerId, reason }),
    command: (name: string, peerId: string, cmd: AdminCommand) => call<{ ok: boolean }>('POST', `${room(name)}/command`, { peerId, ...cmd }),
    broadcast: (text: string) => call<{ delivered: number }>('POST', '/api/admin/broadcast', { text }),
    bans: async () => (await call<{ bans: Ban[] }>('GET', '/api/admin/bans')).bans,
    banPeer: (name: string, peerId: string, reason?: string) =>
      call<{ bans: Ban[]; removed: number }>('POST', '/api/admin/bans', { room: name, peerId, reason }),
    unban: (id: string) => call<{ ok: boolean }>('DELETE', `/api/admin/bans/${encodeURIComponent(id)}`),
    logout: () => call<Json>('POST', '/api/admin/auth/logout', {}),
  };
}

export type AdminClient = ReturnType<typeof createAdminClient>;
