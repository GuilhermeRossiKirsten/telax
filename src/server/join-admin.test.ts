import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST as chat } from '@/app/api/rooms/[room]/chat/route';
import { GET as events } from '@/app/api/rooms/[room]/events/route';
import { POST as join } from '@/app/api/rooms/[room]/join/route';
import { POST as leave } from '@/app/api/rooms/[room]/leave/route';
import { POST as restart } from '@/app/api/rooms/[room]/restart/route';
import { POST as signal } from '@/app/api/rooms/[room]/signal/route';
import { POST as state } from '@/app/api/rooms/[room]/state/route';
import { SESSION_COOKIE, signAdminSession } from './admin-auth';
import { BannedError, RoomClosedError, RoomFullError, UnknownPeerError } from './room-store';

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres!!';
const ENV = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'cs', ADMIN_GITHUB_USER: 'dono', ADMIN_SESSION_SECRET: SECRET };
const DEVICE = '3f197123-2bf8-4730-aadf-6c61db50d59e';
const JOINED = { peerId: 'p', token: 't', participants: [], cursor: 0, gen: 0 };
const session = (login = 'dono') => `${SESSION_COOKIE}=${signAdminSession({ login, id: 1, exp: Date.now() + 3_600_000 }, SECRET)}`;

const adminMethods = ['listRooms', 'getRoom', 'kick', 'closeRoom', 'reopenRoom', 'broadcast', 'command', 'ban', 'banPeer', 'listBans', 'unban'];
const store = Object.fromEntries(
  ['join', 'authenticate', 'events', 'peekEvents', 'signal', 'chat', 'setState', 'restart', 'leave', ...adminMethods].map((m) => [m, vi.fn()]),
) as Record<string, ReturnType<typeof vi.fn>>;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of Object.keys(ENV)) saved[k] = process.env[k];
  Object.assign(process.env, ENV);
  for (const fn of Object.values(store)) fn.mockReset();
  store.join.mockResolvedValue(JOINED);
  store.restart.mockResolvedValue(1);
  store.events.mockResolvedValue({ events: [], cursor: 0 });
  (globalThis as unknown as { __telaxStore?: unknown }).__telaxStore = store;
});
afterEach(() => {
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  (globalThis as unknown as { __telaxStore?: unknown }).__telaxStore = undefined;
});

const ctx = { params: Promise.resolve({ room: 'sala' }) };
const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://app.test/api/rooms/sala/${url}`, { method: 'POST', headers: { host: 'app.test', ...headers }, body: JSON.stringify(body) });
const doJoin = (body: unknown, headers: Record<string, string> = {}) => join(post('join', body, headers), ctx);

describe('POST /join: contexto vindo do servidor', () => {
  it('o IP sai dos cabeçalhos do proxy; o deviceId do corpo só vale se for UUID', async () => {
    const res = await doJoin({ name: 'Ana', deviceId: DEVICE }, { 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });
    expect(res.status).toBe(200);
    expect(store.join).toHaveBeenCalledWith('sala', 'Ana', { ip: '203.0.113.7', deviceId: DEVICE, observer: false });
  });

  it('o corpo do cliente NUNCA define o ip nem outros campos do contexto', async () => {
    await doJoin({ name: 'Ana', ip: '1.2.3.4', observer: undefined, deviceId: 'não-é-uuid', extra: 'x' }, { 'x-forwarded-for': '203.0.113.7' });
    expect(store.join).toHaveBeenCalledWith('sala', 'Ana', { ip: '203.0.113.7', deviceId: undefined, observer: false });
  });

  it('sem cabeçalhos de IP o ip é "unknown"', async () => {
    await doJoin({ name: 'Ana' });
    expect(store.join).toHaveBeenCalledWith('sala', 'Ana', { ip: 'unknown', deviceId: undefined, observer: false });
  });

  it('a resposta continua trazendo iceServers e NÃO devolve ip nem deviceId', async () => {
    const res = await doJoin({ name: 'Ana', deviceId: DEVICE }, { 'x-forwarded-for': '203.0.113.7' });
    const body = await res.json();
    expect(body.iceServers).toBeDefined();
    expect(JSON.stringify(body)).not.toContain('203.0.113.7');
    expect(JSON.stringify(body)).not.toContain(DEVICE);
  });
});

describe('POST /join com observer:true (só o admin)', () => {
  it('SEM sessão: 403 forbidden e NENHUMA entrada na sala', async () => {
    const res = await doJoin({ name: 'espião', observer: true });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(store.join).not.toHaveBeenCalled();
  });

  it('com sessão forjada, expirada, de outro usuário ou com o admin desligado: 403 e nenhuma entrada', async () => {
    const forged = `${SESSION_COOKIE}=${signAdminSession({ login: 'dono', id: 1, exp: Date.now() + 1000 }, 'outro-segredo-bem-longo-e-totalmente-diferente')}`;
    const expired = `${SESSION_COOKIE}=${signAdminSession({ login: 'dono', id: 1, exp: Date.now() - 1 }, SECRET)}`;
    for (const cookie of [forged, expired, session('invasor'), `${SESSION_COOKIE}=lixo`]) {
      expect((await doJoin({ name: 'x', observer: true }, { cookie })).status).toBe(403);
    }
    delete process.env.ADMIN_SESSION_SECRET;
    expect((await doJoin({ name: 'x', observer: true }, { cookie: session() })).status).toBe(403);
    expect(store.join).not.toHaveBeenCalled();
  });

  it('com sessão de admin válida entra como observador, com ip e deviceId', async () => {
    const res = await doJoin({ name: 'admin', observer: true, deviceId: DEVICE }, { cookie: session(), 'x-forwarded-for': '198.51.100.2' });
    expect(res.status).toBe(200);
    expect(store.join).toHaveBeenCalledWith('sala', 'admin', { ip: '198.51.100.2', deviceId: DEVICE, observer: true });
  });

  it('observer que não é booleano → 400', async () => {
    for (const observer of ['true', 1, null, {}]) {
      expect((await doJoin({ name: 'x', observer }, { cookie: session() })).status).toBe(400);
    }
    expect(store.join).not.toHaveBeenCalled();
  });

  it('observer:false explícito é uma entrada comum (não precisa de sessão)', async () => {
    expect((await doJoin({ name: 'Ana', observer: false })).status).toBe(200);
    expect(store.join).toHaveBeenCalledWith('sala', 'Ana', expect.objectContaining({ observer: false }));
  });
});

describe('erros do store viram respostas HTTP', () => {
  it('banido: 403 {error:"banned"}, sem revelar o detalhe', async () => {
    store.join.mockRejectedValue(new BannedError('ip 203.0.113.7'));
    const res = await doJoin({ name: 'Ana' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'banned' });
  });

  it('sala fechada: 403 {error:"room_closed", reason}; sem motivo, sem o campo', async () => {
    store.join.mockRejectedValue(new RoomClosedError('manutenção'));
    const a = await doJoin({ name: 'Ana' });
    expect(a.status).toBe(403);
    expect(await a.json()).toEqual({ error: 'room_closed', reason: 'manutenção' });
    store.join.mockRejectedValue(new RoomClosedError());
    expect(await (await doJoin({ name: 'Ana' })).json()).toEqual({ error: 'room_closed' });
  });

  it('sala cheia continua 409', async () => {
    store.join.mockRejectedValue(new RoomFullError());
    const res = await doJoin({ name: 'Ana' });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'room_full' });
  });

  it('410 gone leva o motivo quando o peer foi removido pelo admin; sem motivo, é o 410 de sempre', async () => {
    const body = { from: 'p', token: 't' };
    const routes: Array<[string, () => Promise<Response>]> = [
      ['chat', () => chat(post('chat', { ...body, text: 'oi' }), ctx)],
      ['state', () => state(post('state', { ...body, audio: true, video: true, sharing: false }), ctx)],
      ['signal', () => signal(post('signal', { ...body, to: 'q', data: { gen: 0, kind: 'offer', sid: 1, sdp: 'v=0' } }), ctx)],
      ['restart', () => restart(post('restart', body), ctx)],
      ['leave', () => leave(post('leave', { peerId: 'p', token: 't' }), ctx)],
      ['events', () => events(new Request('http://app.test/api/rooms/sala/events?peerId=p&token=t&since=0'), ctx)],
    ];
    for (const reason of ['kicked', 'banned', 'closed'] as const) {
      store.authenticate.mockRejectedValue(new UnknownPeerError(reason));
      for (const [name, run] of routes) {
        const res = await run();
        expect(res.status, name).toBe(410);
        expect(await res.json(), name).toEqual({ error: 'gone', reason });
      }
    }
    store.authenticate.mockRejectedValue(new UnknownPeerError());
    for (const [name, run] of routes) {
      const res = await run();
      expect(res.status, name).toBe(410);
      expect(await res.json(), name).toEqual({ error: 'gone' });
    }
  });

  it('410 gone leva também o TEXTO do admin (detail), limitado ao tamanho permitido; sem motivo nunca inventa detail', async () => {
    const chatRoute = () => chat(post('chat', { from: 'p', token: 't', text: 'oi' }), ctx);
    store.authenticate.mockRejectedValue(new UnknownPeerError('kicked', 'conversa fora do assunto'));
    const res = await chatRoute();
    expect(res.status).toBe(410);
    expect(await res.json()).toEqual({ error: 'gone', reason: 'kicked', detail: 'conversa fora do assunto' });

    store.authenticate.mockRejectedValue(new UnknownPeerError('banned', 'x'.repeat(5000)));
    const longo = await (await chatRoute()).json();
    expect(longo.detail.length).toBeLessThanOrEqual(200);

    store.authenticate.mockRejectedValue(new UnknownPeerError('closed'));
    expect(await (await chatRoute()).json()).toEqual({ error: 'gone', reason: 'closed' });
    // sem reason, o detail é ignorado: só quem foi removido pelo admin recebe qualquer texto
    store.authenticate.mockRejectedValue(new UnknownPeerError(undefined, 'vazou?'));
    expect(await (await chatRoute()).json()).toEqual({ error: 'gone' });
  });
});

describe('ninguém comum cria evento de admin nem aciona métodos de admin', () => {
  const touchedAdmin = () => adminMethods.filter((m) => store[m].mock.calls.length > 0);
  const auth = { from: 'p', token: 't' };

  it('chat com campos "admin" é só texto comum: o store recebe apenas o texto', async () => {
    store.authenticate.mockResolvedValue(undefined);
    const res = await chat(post('chat', { ...auth, text: 'Mensagem do administrador: pague aqui', type: 'admin', kind: 'message', admin: true }), ctx);
    expect(res.status).toBe(200);
    expect(store.chat).toHaveBeenCalledTimes(1);
    expect(store.chat).toHaveBeenCalledWith('sala', 'p', 'Mensagem do administrador: pague aqui');
    expect(touchedAdmin()).toEqual([]);
  });

  it('state com campos "admin"/"observer"/"command" é ignorado: o store recebe só mídia', async () => {
    store.authenticate.mockResolvedValue(undefined);
    const res = await state(post('state', { ...auth, audio: true, video: false, sharing: false, admin: true, observer: true, kind: 'command', what: 'all' }), ctx);
    expect(res.status).toBe(200);
    expect(store.setState).toHaveBeenCalledWith('sala', 'p', { audio: true, video: false, sharing: false, screenSlots: 0 });
    expect(touchedAdmin()).toEqual([]);
  });

  it('signal com campos "admin" no payload não vira evento admin: só os campos de sinalização passam', async () => {
    store.authenticate.mockResolvedValue(undefined);
    const data = { gen: 0, kind: 'offer', sid: 1, sdp: 'v=0', type: 'admin', admin: true, text: 'invasão', what: 'all' };
    const res = await signal(post('signal', { ...auth, to: 'q', data }), ctx);
    expect(res.status).toBe(200);
    expect(store.signal).toHaveBeenCalledTimes(1);
    const sent = store.signal.mock.calls[0][3] as Record<string, unknown>;
    expect(Object.keys(sent).sort()).toEqual(['gen', 'kind', 'sdp', 'sid']);
    expect(touchedAdmin()).toEqual([]);
  });

  it('um `kind` de sinal que não existe (ex.: "command") é recusado', async () => {
    store.authenticate.mockResolvedValue(undefined);
    expect((await signal(post('signal', { ...auth, to: 'q', data: { gen: 0, kind: 'command', what: 'all' } }), ctx)).status).toBe(400);
    expect(store.signal).not.toHaveBeenCalled();
  });
});
