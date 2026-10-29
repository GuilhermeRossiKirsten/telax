import { describe, expect, it, vi } from 'vitest';
import { AdminApiError, createAdminClient } from './admin-client';

type Call = { url: string; init?: RequestInit };

function fakeFetch(responses: Array<{ status?: number; body?: unknown } | Error>) {
  const calls: Call[] = [];
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const next = responses.shift();
    if (!next) throw new Error('sem resposta programada');
    if (next instanceof Error) throw next;
    const status = next.status ?? 200;
    return new Response(next.body === undefined ? null : JSON.stringify(next.body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

const bodyOf = (c: Call) => JSON.parse(String(c.init?.body));

describe('createAdminClient', () => {
  it('me, salas e detalhe vão por GET nas rotas certas, com a sala codificada', async () => {
    const { fn, calls } = fakeFetch([{ body: { login: 'dono', id: 7 } }, { body: { rooms: [] } }, { body: { name: 'sala x/y', peers: [] } }]);
    const api = createAdminClient(fn);
    expect(await api.me()).toEqual({ login: 'dono', id: 7 });
    expect(await api.rooms()).toEqual([]);
    await api.room('sala x/y');
    expect(calls.map((c) => c.url)).toEqual(['/api/admin/me', '/api/admin/rooms', '/api/admin/rooms/sala%20x%2Fy']);
    expect(calls.every((c) => (c.init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('ações mutantes: POST JSON nas rotas certas', async () => {
    const { fn, calls } = fakeFetch([
      { body: { delivered: 3 } },
      { body: { removed: 2 } },
      { body: { ok: true } },
      { body: { ok: true } },
      { body: { ok: true } },
      { body: { delivered: 9 } },
    ]);
    const api = createAdminClient(fn);
    expect(await api.message('sala', 'oi')).toEqual({ delivered: 3 });
    expect(await api.close('sala', 'manutenção')).toEqual({ removed: 2 });
    await api.reopen('sala');
    await api.kick('sala', 'p1', 'spam');
    await api.command('sala', 'p1', { what: 'screen', slot: 1 });
    expect(await api.broadcast('aviso geral')).toEqual({ delivered: 9 });

    expect(calls.map((c) => `${c.init?.method} ${c.url}`)).toEqual([
      'POST /api/admin/rooms/sala/message',
      'POST /api/admin/rooms/sala/close',
      'POST /api/admin/rooms/sala/reopen',
      'POST /api/admin/rooms/sala/kick',
      'POST /api/admin/rooms/sala/command',
      'POST /api/admin/broadcast',
    ]);
    expect(bodyOf(calls[0])).toEqual({ text: 'oi' });
    expect(bodyOf(calls[1])).toEqual({ reason: 'manutenção' });
    expect(bodyOf(calls[3])).toEqual({ peerId: 'p1', reason: 'spam' });
    expect(bodyOf(calls[4])).toEqual({ peerId: 'p1', what: 'screen', slot: 1 });
    expect(bodyOf(calls[5])).toEqual({ text: 'aviso geral' });
    expect(new Headers(calls[0].init?.headers).get('content-type')).toBe('application/json');
  });

  it('bloqueios: lista, bane um peer conectado e remove', async () => {
    const { fn, calls } = fakeFetch([{ body: { bans: [{ id: 'b1' }] } }, { body: { bans: [{ id: 'b2' }], removed: 1 } }, { body: { ok: true } }]);
    const api = createAdminClient(fn);
    expect(await api.bans()).toEqual([{ id: 'b1' }]);
    expect(await api.banPeer('sala', 'p1', 'abuso')).toEqual({ bans: [{ id: 'b2' }], removed: 1 });
    await api.unban('b/2');
    expect(calls.map((c) => `${c.init?.method ?? 'GET'} ${c.url}`)).toEqual(['GET /api/admin/bans', 'POST /api/admin/bans', 'DELETE /api/admin/bans/b%2F2']);
    expect(bodyOf(calls[1])).toEqual({ room: 'sala', peerId: 'p1', reason: 'abuso' });
  });

  it('logout é POST', async () => {
    const { fn, calls } = fakeFetch([{ body: {} }]);
    await createAdminClient(fn).logout();
    expect(`${calls[0].init?.method} ${calls[0].url}`).toBe('POST /api/admin/auth/logout');
  });

  it('erros HTTP viram AdminApiError com status e código, sem expor o corpo cru', async () => {
    const { fn } = fakeFetch([{ status: 401, body: { error: 'unauthorized' } }, { status: 503, body: { error: 'admin_disabled' } }, { status: 500 }]);
    const api = createAdminClient(fn);
    const e401 = await api.me().catch((e) => e);
    expect(e401).toBeInstanceOf(AdminApiError);
    expect(e401).toMatchObject({ status: 401, code: 'unauthorized' });
    const e503 = await api.rooms().catch((e) => e);
    expect(e503).toMatchObject({ status: 503, code: 'admin_disabled' });
    const e500 = await api.bans().catch((e) => e);
    expect(e500).toMatchObject({ status: 500 });
    expect(e500.message).toMatch(/tente de novo/i);
  });

  it('falha de rede vira AdminApiError de status 0', async () => {
    const { fn } = fakeFetch([new TypeError('Failed to fetch')]);
    const err = await createAdminClient(fn).rooms().catch((e) => e);
    expect(err).toBeInstanceOf(AdminApiError);
    expect(err.status).toBe(0);
    expect(err.message).toMatch(/conexão/i);
  });

  it('resposta de sucesso que não é JSON válido também é erro tratado', async () => {
    const fn = vi.fn(async () => new Response('<html>oops</html>', { status: 200 })) as unknown as typeof fetch;
    const err = await createAdminClient(fn).rooms().catch((e) => e);
    expect(err).toBeInstanceOf(AdminApiError);
  });
});
