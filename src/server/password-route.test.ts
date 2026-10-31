import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET as events } from '@/app/api/rooms/[room]/events/route';
import { POST as join } from '@/app/api/rooms/[room]/join/route';
import { POST as setPassword } from '@/app/api/rooms/[room]/password/route';
import { GET as preview } from '@/app/api/rooms/[room]/preview/route';
import { SESSION_COOKIE, signAdminSession } from './admin-auth';
import { MemoryRoomStore } from './memory-room-store';
import { verifyPassword } from './room-password';

/** Senha da sala pelas rotas, com um MemoryRoomStore de verdade e relógio controlado (o hash scrypt é real). */

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres!!';
const ENV = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'cs', ADMIN_GITHUB_USER: 'dono', ADMIN_SESSION_SECRET: SECRET };
const adminCookie = () => `${SESSION_COOKIE}=${signAdminSession({ login: 'dono', id: 1, exp: Date.now() + 3_600_000 }, SECRET)}`;
const SENHA = 'ovo-de-pascoa-42';

let now = 1_000_000;
let store: MemoryRoomStore;
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of Object.keys(ENV)) saved[k] = process.env[k];
  Object.assign(process.env, ENV);
  now = 1_000_000;
  store = new MemoryRoomStore(() => now);
  (globalThis as unknown as { __telaxStore?: unknown }).__telaxStore = store;
});
afterEach(() => {
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  (globalThis as unknown as { __telaxStore?: unknown }).__telaxStore = undefined;
});

const ctx = (room = 'sala') => ({ params: Promise.resolve({ room }) });
const post = (path: string, body: unknown, headers: Record<string, string> = {}, room = 'sala') =>
  new Request(`http://app.test/api/rooms/${room}/${path}`, { method: 'POST', headers: { host: 'app.test', ...headers }, body: JSON.stringify(body) });
const doJoin = (body: Record<string, unknown>, headers: Record<string, string> = {}, room = 'sala') => join(post('join', body, headers, room), ctx(room));
const doSet = (body: unknown, room = 'sala') => setPassword(post('password', body, {}, room), ctx(room));
const doPreview = async (room = 'sala') =>
  (await preview(new Request(`http://app.test/api/rooms/${room}/preview`), ctx(room))).json();

/** Ana entra e liga a senha; devolve as credenciais dela. */
async function protectedRoom(password = SENHA) {
  const ana = await (await doJoin({ name: 'Ana' })).json();
  const res = await doSet({ peerId: ana.peerId, token: ana.token, action: 'set', password });
  expect(res.status).toBe(200);
  return ana as { peerId: string; token: string };
}

describe('POST /join em sala protegida', () => {
  it('sala sem senha: entra sem nada e a resposta diz protected:false', async () => {
    const res = await doJoin({ name: 'Ana' });
    expect(res.status).toBe(200);
    expect((await res.json()).protected).toBe(false);
  });

  it('sem senha: 403 password_required e NINGUÉM entra', async () => {
    await protectedRoom();
    const res = await doJoin({ name: 'Beto' });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'password_required' });
    expect((await doPreview()).count).toBe(1);
  });

  it('senha vazia conta como ausente e não gasta tentativa', async () => {
    await protectedRoom();
    for (let i = 0; i < 8; i++) {
      const res = await doJoin({ name: 'Beto', password: '' });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'password_required' });
    }
  });

  it('senha errada: 403 wrong_password; certa: 200 com protected:true e a lista de participantes', async () => {
    await protectedRoom();
    const errada = await doJoin({ name: 'Beto', password: 'outra-senha' });
    expect(errada.status).toBe(403);
    expect(await errada.json()).toEqual({ error: 'wrong_password' });
    expect((await doPreview()).count).toBe(1);

    const certa = await doJoin({ name: 'Beto', password: SENHA });
    expect(certa.status).toBe(200);
    const body = await certa.json();
    expect(body.protected).toBe(true);
    expect(body.participants.map((p: { name: string }) => p.name).sort()).toEqual(['Ana', 'Beto']);
    expect((await doPreview()).count).toBe(2);
  });

  it('diferença de caixa ou espaço é senha errada', async () => {
    await protectedRoom();
    for (const senha of [SENHA.toUpperCase(), `${SENHA} `, ` ${SENHA}`]) {
      expect(await (await doJoin({ name: 'Beto', password: senha })).json()).toEqual({ error: 'wrong_password' });
    }
  });

  it('password que não é texto = 400 invalid; texto enorme = senha errada sem hashear', async () => {
    await protectedRoom();
    for (const password of [123, true, null, ['a'], { $ne: '' }]) {
      const res = await doJoin({ name: 'Beto', password });
      expect(res.status).toBe(400);
    }
    const enorme = await doJoin({ name: 'Beto', password: 'x'.repeat(100_000) });
    expect(enorme.status).toBe(403);
    expect(await enorme.json()).toEqual({ error: 'wrong_password' });
  });

  it('a senha só vale para novas entradas: quem já estava continua recebendo eventos', async () => {
    const ana = await (await doJoin({ name: 'Ana' })).json();
    const beto = await (await doJoin({ name: 'Beto' })).json();
    const host = ana.peerId < beto.peerId ? ana : beto;
    const outro = host === ana ? beto : ana;
    expect((await doSet({ peerId: host.peerId, token: host.token, action: 'set', password: SENHA })).status).toBe(200);
    const res = await events(new Request(`http://app.test/api/rooms/sala/events?peerId=${outro.peerId}&token=${outro.token}&since=0`), ctx());
    expect(res.status).toBe(200);
    expect((await res.json()).events.some((e: { type: string }) => e.type === 'room')).toBe(true);
  });

  it('sala fechada pelo admin: room_closed (não pede senha)', async () => {
    await protectedRoom();
    store.closeRoom('sala', 'manutenção');
    const res = await doJoin({ name: 'Beto' });
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ error: 'room_closed' });
  });

  it('o observador do admin entra sem senha e não conta como participante', async () => {
    await protectedRoom();
    const res = await doJoin({ name: 'admin', observer: true }, { cookie: adminCookie() });
    expect(res.status).toBe(200);
    expect((await doPreview()).count).toBe(1);
  });

  it('observer:true sem sessão de admin continua 403 forbidden (a senha não abre essa porta)', async () => {
    await protectedRoom();
    const res = await doJoin({ name: 'espião', observer: true, password: SENHA });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
  });

  it('nenhuma resposta traz a senha, o hash nem o sal', async () => {
    const ana = await protectedRoom();
    const record = store.getRoomPassword('sala')!;
    const respostas = [
      await (await doJoin({ name: 'Beto', password: SENHA })).text(),
      await (await doJoin({ name: 'Cris', password: 'errada-errada' })).text(),
      await (await doJoin({ name: 'Dani' })).text(),
      JSON.stringify(await doPreview()),
      await (await events(new Request(`http://app.test/api/rooms/sala/events?peerId=${ana.peerId}&token=${ana.token}&since=0`), ctx())).text(),
    ];
    for (const texto of respostas) for (const segredo of [SENHA, record.hash, record.salt]) expect(texto).not.toContain(segredo);
  });
});

describe('força bruta', () => {
  const ip = (n: string) => ({ 'x-forwarded-for': n });

  it('5 erros do mesmo IP: o 6º já é 429 too_many_attempts com Retry-After, mesmo com a senha certa', async () => {
    await protectedRoom();
    for (let i = 0; i < 5; i++) {
      const res = await doJoin({ name: 'Beto', password: `errada-${i}` }, ip('203.0.113.9'));
      expect(res.status).toBe(403);
    }
    const trancado = await doJoin({ name: 'Beto', password: SENHA }, ip('203.0.113.9'));
    expect(trancado.status).toBe(429);
    const body = await trancado.json();
    expect(body.error).toBe('too_many_attempts');
    expect(body.retryAfter).toBeGreaterThan(0);
    expect(body.retryAfter).toBeLessThanOrEqual(300);
    expect(trancado.headers.get('retry-after')).toBe(String(body.retryAfter));
    expect((await doPreview()).count).toBe(1);
  });

  it('outro IP não é afetado; passado o tempo, o IP trancado volta a poder entrar', async () => {
    await protectedRoom();
    for (let i = 0; i < 5; i++) await doJoin({ name: 'Beto', password: `errada-${i}` }, ip('203.0.113.9'));
    expect((await doJoin({ name: 'Cris', password: SENHA }, ip('198.51.100.4'))).status).toBe(200);
    now += 5 * 60_000 + 1000;
    expect((await doJoin({ name: 'Beto', password: SENHA }, ip('203.0.113.9'))).status).toBe(200);
  });

  it('acertar zera o contador: 4 erros + acerto + 4 erros não tranca', async () => {
    await protectedRoom();
    for (let i = 0; i < 4; i++) await doJoin({ name: 'Beto', password: `errada-${i}` }, ip('203.0.113.9'));
    expect((await doJoin({ name: 'Beto', password: SENHA }, ip('203.0.113.9'))).status).toBe(200);
    for (let i = 0; i < 4; i++) expect((await doJoin({ name: 'Beto', password: `errada-${i}` }, ip('203.0.113.9'))).status).toBe(403);
  });

  it('50 erros de IPs diferentes trancam a sala toda por 1 min (inclusive com a senha certa)', async () => {
    await protectedRoom();
    for (let i = 0; i < 50; i++) await doJoin({ name: 'Beto', password: `errada-${i}` }, ip(`203.0.113.${i}`));
    const res = await doJoin({ name: 'Cris', password: SENHA }, ip('198.51.100.77'));
    expect(res.status).toBe(429);
    expect((await res.json()).retryAfter).toBeLessThanOrEqual(60);
    now += 61_000;
    expect((await doJoin({ name: 'Cris', password: SENHA }, ip('198.51.100.77'))).status).toBe(200);
  });
});

describe('POST /password', () => {
  it('o anfitrião liga a senha: 200 {protected:true}, o preview passa a dizer protegida e o registro é um hash scrypt', async () => {
    const ana = await (await doJoin({ name: 'Ana' })).json();
    expect(await doPreview()).toEqual({ count: 1, closed: false, protected: false });
    const res = await doSet({ peerId: ana.peerId, token: ana.token, action: 'set', password: SENHA });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ protected: true });
    expect(await doPreview()).toEqual({ count: 1, closed: false, protected: true });

    const record = store.getRoomPassword('sala')!;
    expect(JSON.stringify(record)).not.toContain(SENHA);
    expect(await verifyPassword(SENHA, record)).toBe(true);
  });

  it('remover: 200 {protected:false}, o preview volta e a entrada fica livre; remover de novo é idempotente', async () => {
    const ana = await protectedRoom();
    const res = await doSet({ peerId: ana.peerId, token: ana.token, action: 'clear' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ protected: false });
    expect((await doPreview()).protected).toBe(false);
    now += 1000; // Beto entra depois: a Ana segue sendo a anfitriã
    expect((await doJoin({ name: 'Beto' })).status).toBe(200);
    expect((await doSet({ peerId: ana.peerId, token: ana.token, action: 'clear' })).status).toBe(200);
  });

  it('trocar a senha: a antiga deixa de valer e a nova passa a valer', async () => {
    const ana = await protectedRoom();
    expect((await doSet({ peerId: ana.peerId, token: ana.token, action: 'set', password: 'senha-nova-77' })).status).toBe(200);
    expect(await (await doJoin({ name: 'Beto', password: SENHA })).json()).toEqual({ error: 'wrong_password' });
    expect((await doJoin({ name: 'Beto', password: 'senha-nova-77' })).status).toBe(200);
  });

  it('quem não é o anfitrião recebe 403 not_host e nada muda', async () => {
    const ana = await (await doJoin({ name: 'Ana' })).json();
    now += 1000;
    const beto = await (await doJoin({ name: 'Beto' })).json();
    const res = await doSet({ peerId: beto.peerId, token: beto.token, action: 'set', password: SENHA });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_host' });
    expect(store.getRoomPassword('sala')).toBeNull();
    expect((await doSet({ peerId: ana.peerId, token: ana.token, action: 'set', password: SENHA })).status).toBe(200);
    expect((await doSet({ peerId: beto.peerId, token: beto.token, action: 'clear' })).status).toBe(403);
    expect(store.getRoomPassword('sala')).not.toBeNull();
  });

  it('quando o anfitrião sai, a pessoa seguinte passa a poder mexer na senha', async () => {
    const ana = await protectedRoom();
    now += 1000;
    const beto = await (await doJoin({ name: 'Beto', password: SENHA })).json();
    expect((await doSet({ peerId: beto.peerId, token: beto.token, action: 'clear' })).status).toBe(403);
    store.leave('sala', ana.peerId);
    expect((await doSet({ peerId: beto.peerId, token: beto.token, action: 'clear' })).status).toBe(200);
  });

  it('senha fora de 4..64 caracteres, ausente ou que não é texto = 400 invalid e nada muda', async () => {
    const ana = await (await doJoin({ name: 'Ana' })).json();
    for (const password of ['abc', 'x'.repeat(65), undefined, 1234, null, ['abcd']]) {
      const res = await doSet({ peerId: ana.peerId, token: ana.token, action: 'set', password });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid' });
    }
    expect(store.getRoomPassword('sala')).toBeNull();
  });

  it('action desconhecida ou ausente = 400', async () => {
    const ana = await (await doJoin({ name: 'Ana' })).json();
    for (const action of ['toggle', 'SET', undefined, 1]) {
      expect((await doSet({ peerId: ana.peerId, token: ana.token, action, password: SENHA })).status).toBe(400);
    }
  });

  it('sem token, token errado ou peer inexistente: nunca muda a senha (400 ou 410)', async () => {
    const ana = await (await doJoin({ name: 'Ana' })).json();
    expect((await doSet({ peerId: ana.peerId, action: 'set', password: SENHA })).status).toBe(400);
    expect((await doSet({ peerId: ana.peerId, token: 'errado', action: 'set', password: SENHA })).status).toBe(410);
    expect((await doSet({ peerId: 'nao-existe', token: ana.token, action: 'set', password: SENHA })).status).toBe(410);
    expect((await doSet({ action: 'set', password: SENHA })).status).toBe(400);
    expect(store.getRoomPassword('sala')).toBeNull();
  });

  it('o token de uma sala não vale em outra', async () => {
    const ana = await (await doJoin({ name: 'Ana' })).json();
    const res = await doSet({ peerId: ana.peerId, token: ana.token, action: 'set', password: SENHA }, 'outra');
    expect(res.status).toBe(410);
    expect(store.getRoomPassword('outra')).toBeNull();
  });

  it('o observador (admin) não define senha: 403 not_host', async () => {
    await (await doJoin({ name: 'Ana' })).json();
    const obs = await (await doJoin({ name: 'admin', observer: true }, { cookie: adminCookie() })).json();
    const res = await doSet({ peerId: obs.peerId, token: obs.token, action: 'set', password: SENHA });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'not_host' });
  });

  it('a resposta traz só { protected }: nada de hash, sal nem a senha', async () => {
    const ana = await (await doJoin({ name: 'Ana' })).json();
    const texto = await (await doSet({ peerId: ana.peerId, token: ana.token, action: 'set', password: SENHA })).text();
    expect(Object.keys(JSON.parse(texto))).toEqual(['protected']);
    expect(texto).not.toContain(SENHA);
  });

  it('corpo inválido ou nome de sala inválido = 400', async () => {
    expect((await setPassword(new Request('http://app.test/api/rooms/sala/password', { method: 'POST', body: 'não é json' }), ctx())).status).toBe(400);
    expect((await doSet({ peerId: 'x', token: 'y', action: 'clear' }, '   ')).status).toBe(400);
  });
});
