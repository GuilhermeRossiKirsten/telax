import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as bansList, POST as bansCreate } from '@/app/api/admin/bans/route';
import { DELETE as bansDelete } from '@/app/api/admin/bans/[id]/route';
import { POST as broadcast } from '@/app/api/admin/broadcast/route';
import { GET as me } from '@/app/api/admin/me/route';
import { POST as close } from '@/app/api/admin/rooms/[room]/close/route';
import { POST as command } from '@/app/api/admin/rooms/[room]/command/route';
import { POST as kick } from '@/app/api/admin/rooms/[room]/kick/route';
import { POST as message } from '@/app/api/admin/rooms/[room]/message/route';
import { POST as reopen } from '@/app/api/admin/rooms/[room]/reopen/route';
import { GET as roomDetail } from '@/app/api/admin/rooms/[room]/route';
import { GET as roomsList } from '@/app/api/admin/rooms/route';
import { SESSION_COOKIE, signAdminSession } from './admin-auth';

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres!!';
const ENV = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'cs', ADMIN_GITHUB_USER: 'dono', ADMIN_SESSION_SECRET: SECRET };
const PEER = '3f197123-2bf8-4730-aadf-6c61db50d59e';
const cookie = `${SESSION_COOKIE}=${signAdminSession({ login: 'dono', id: 9, exp: Date.now() + 3_600_000 }, SECRET)}`;

const store = {
  listRooms: vi.fn(),
  getRoom: vi.fn(),
  kick: vi.fn(),
  closeRoom: vi.fn(),
  reopenRoom: vi.fn(),
  broadcast: vi.fn(),
  command: vi.fn(),
  ban: vi.fn(),
  banPeer: vi.fn(),
  listBans: vi.fn(),
  unban: vi.fn(),
};
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of Object.keys(ENV)) saved[k] = process.env[k];
  Object.assign(process.env, ENV);
  for (const fn of Object.values(store)) fn.mockReset();
  (globalThis as unknown as { __telaxStore?: unknown }).__telaxStore = store;
});
afterEach(() => {
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  (globalThis as unknown as { __telaxStore?: unknown }).__telaxStore = undefined;
});

type Handler = (req: Request, ctx: { params: Promise<Record<string, string>> }) => Promise<Response>;
async function call(h: unknown, method: string, params: Record<string, string> = {}, body?: unknown) {
  const res = await (h as Handler)(
    new Request('http://app.test/api/admin/x', {
      method,
      headers: { host: 'app.test', origin: 'http://app.test', cookie },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    }),
    { params: Promise.resolve(params) },
  );
  return { status: res.status, body: await res.json() };
}

describe('GET /api/admin/me', () => {
  it('devolve o login e o id da sessão', async () => {
    expect(await call(me, 'GET')).toEqual({ status: 200, body: { login: 'dono', id: 9 } });
  });
});

describe('salas', () => {
  it('GET /rooms lista as salas do store', async () => {
    const rooms = [{ name: 'a', peerCount: 2, observerCount: 0, createdAt: 1, lastActivity: 2, closed: false }];
    store.listRooms.mockResolvedValue(rooms);
    expect(await call(roomsList, 'GET')).toEqual({ status: 200, body: { rooms } });
  });

  it('GET /rooms/:room devolve o detalhe; sala que não existe → 404; nome inválido → 400', async () => {
    const detail = { name: 'sala', peers: [] };
    store.getRoom.mockResolvedValue(detail);
    expect(await call(roomDetail, 'GET', { room: 'Sala' })).toEqual({ status: 200, body: detail });
    expect(store.getRoom).toHaveBeenCalledWith('sala'); // normalizada
    store.getRoom.mockResolvedValue(null);
    expect((await call(roomDetail, 'GET', { room: 'nao-existe' })).status).toBe(404);
    expect((await call(roomDetail, 'GET', { room: '   ' })).status).toBe(400);
    expect((await call(roomDetail, 'GET', { room: 'x'.repeat(41) })).status).toBe(400);
  });

  it('POST /message entrega o texto à sala', async () => {
    store.broadcast.mockResolvedValue(3);
    expect(await call(message, 'POST', { room: 'sala' }, { text: '  Atenção, a sala fecha em 5 min  ' })).toEqual({ status: 200, body: { delivered: 3 } });
    expect(store.broadcast).toHaveBeenCalledWith('sala', 'Atenção, a sala fecha em 5 min');
  });

  it('POST /message valida: texto vazio, longo demais, ausente, corpo que não é objeto → 400 e o store não é chamado', async () => {
    for (const body of [{ text: '   ' }, { text: 'a'.repeat(501) }, {}, { text: 5 }, 'não json', [1]]) {
      expect((await call(message, 'POST', { room: 'sala' }, body)).status).toBe(400);
    }
    expect(store.broadcast).not.toHaveBeenCalled();
  });

  it('POST /close remove todos e devolve quantos saíram; motivo é opcional e limitado a 200', async () => {
    store.closeRoom.mockResolvedValue(4);
    expect(await call(close, 'POST', { room: 'sala' }, { reason: 'manutenção' })).toEqual({ status: 200, body: { removed: 4 } });
    expect(store.closeRoom).toHaveBeenCalledWith('sala', 'manutenção');
    await call(close, 'POST', { room: 'sala' }, {});
    expect(store.closeRoom).toHaveBeenLastCalledWith('sala', undefined);
    expect((await call(close, 'POST', { room: 'sala' }, { reason: 'a'.repeat(201) })).status).toBe(400);
  });

  it('POST /reopen reabre a sala', async () => {
    store.reopenRoom.mockResolvedValue(true);
    expect(await call(reopen, 'POST', { room: 'sala' }, {})).toEqual({ status: 200, body: { ok: true } });
    expect(store.reopenRoom).toHaveBeenCalledWith('sala');
  });

  it('POST /kick expulsa um peer; peerId precisa ser UUID', async () => {
    store.kick.mockResolvedValue(true);
    expect(await call(kick, 'POST', { room: 'sala' }, { peerId: PEER, reason: 'spam' })).toEqual({ status: 200, body: { ok: true } });
    expect(store.kick).toHaveBeenCalledWith('sala', PEER, 'spam');
    store.kick.mockClear();
    for (const body of [{ peerId: 'x' }, { peerId: '$where' }, {}, { peerId: PEER, reason: 7 }]) {
      expect((await call(kick, 'POST', { room: 'sala' }, body)).status).toBe(400);
    }
    expect(store.kick).not.toHaveBeenCalled();
    store.kick.mockResolvedValue(false);
    expect(await call(kick, 'POST', { room: 'sala' }, { peerId: PEER })).toEqual({ status: 200, body: { ok: false } });
  });

  it('POST /command valida o comando: o slot só vale com "screen" e vai de 0 a 2', async () => {
    store.command.mockResolvedValue(true);
    expect((await call(command, 'POST', { room: 'sala' }, { peerId: PEER, what: 'camera' })).body).toEqual({ ok: true });
    expect(store.command).toHaveBeenLastCalledWith('sala', PEER, { what: 'camera' });
    await call(command, 'POST', { room: 'sala' }, { peerId: PEER, what: 'screen', slot: 2 });
    expect(store.command).toHaveBeenLastCalledWith('sala', PEER, { what: 'screen', slot: 2 });
    for (const what of ['screens', 'mic', 'all']) expect((await call(command, 'POST', { room: 'sala' }, { peerId: PEER, what })).status).toBe(200);

    store.command.mockClear();
    const bad = [
      { peerId: PEER, what: 'screen' }, // falta o slot
      { peerId: PEER, what: 'screen', slot: 3 },
      { peerId: PEER, what: 'screen', slot: -1 },
      { peerId: PEER, what: 'screen', slot: 1.5 },
      { peerId: PEER, what: 'camera', slot: 0 }, // slot só com "screen"
      { peerId: PEER, what: 'explodir' },
      { peerId: PEER },
      { what: 'camera' },
      { peerId: 'nao-uuid', what: 'camera' },
    ];
    for (const body of bad) expect((await call(command, 'POST', { room: 'sala' }, body)).status).toBe(400);
    expect(store.command).not.toHaveBeenCalled();
  });
});

describe('mensagem global', () => {
  it('POST /broadcast manda a todas as salas (room = null)', async () => {
    store.broadcast.mockResolvedValue(11);
    expect(await call(broadcast, 'POST', {}, { text: 'Manutenção às 22h' })).toEqual({ status: 200, body: { delivered: 11 } });
    expect(store.broadcast).toHaveBeenCalledWith(null, 'Manutenção às 22h');
    expect((await call(broadcast, 'POST', {}, { text: '' })).status).toBe(400);
  });
});

describe('bloqueios', () => {
  it('GET /bans lista', async () => {
    const bans = [{ id: 'ip-1', kind: 'ip', value: '203.0.113.7', reason: 'x', createdAt: 1 }];
    store.listBans.mockResolvedValue(bans);
    expect(await call(bansList, 'GET')).toEqual({ status: 200, body: { bans } });
  });

  it('POST /bans com room + peerId bane o peer conectado (IP e dispositivo)', async () => {
    const result = { bans: [{ id: 'ip-a' }, { id: 'device-b' }], removed: 1 };
    store.banPeer.mockResolvedValue(result);
    expect(await call(bansCreate, 'POST', {}, { room: 'Sala', peerId: PEER, reason: 'abuso' })).toEqual({ status: 200, body: result });
    expect(store.banPeer).toHaveBeenCalledWith('sala', PEER, 'abuso');
    store.banPeer.mockResolvedValue(null);
    expect((await call(bansCreate, 'POST', {}, { room: 'sala', peerId: PEER })).status).toBe(404);
  });

  it('POST /bans com ip e/ou deviceId; valores inválidos, vazios ou misturados → 400', async () => {
    store.ban.mockResolvedValue({ bans: [], removed: 0 });
    expect((await call(bansCreate, 'POST', {}, { ip: '203.0.113.7' })).status).toBe(200);
    expect(store.ban).toHaveBeenLastCalledWith({ ip: '203.0.113.7', deviceId: undefined, reason: undefined });
    expect((await call(bansCreate, 'POST', {}, { ip: '2001:db8::1', deviceId: PEER, reason: 'r' })).status).toBe(200);
    expect(store.ban).toHaveBeenLastCalledWith({ ip: '2001:db8::1', deviceId: PEER, reason: 'r' });
    store.ban.mockClear();
    store.banPeer.mockClear();
    const bad = [{}, { ip: 'não é ip' }, { ip: '$where' }, { deviceId: 'x' }, { ip: '1.2.3.4', room: 'sala', peerId: PEER }, { room: 'sala' }, { peerId: PEER }, { ip: 5 }];
    for (const body of bad) expect((await call(bansCreate, 'POST', {}, body)).status).toBe(400);
    expect(store.ban).not.toHaveBeenCalled();
    expect(store.banPeer).not.toHaveBeenCalled();
  });

  it('DELETE /bans/:id remove; id fora do formato → 400', async () => {
    store.unban.mockResolvedValue(true);
    const id = `ip-${'a'.repeat(20)}`;
    expect(await call(bansDelete, 'DELETE', { id })).toEqual({ status: 200, body: { ok: true } });
    expect(store.unban).toHaveBeenCalledWith(id);
    store.unban.mockClear();
    for (const bad of ['x', 'ip-123', '../..', `device-${'z'.repeat(20)}`, `${id}x`]) {
      expect((await call(bansDelete, 'DELETE', { id: bad })).status).toBe(400);
    }
    expect(store.unban).not.toHaveBeenCalled();
  });
});
