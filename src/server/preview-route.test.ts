import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GET as preview } from '@/app/api/rooms/[room]/preview/route';
import { MemoryRoomStore } from './memory-room-store';

/** A rota de preview é PÚBLICA de propósito: devolve só count, closed e protected e nunca escreve nem aciona admin. */

const ALL_METHODS = [
  'join', 'authenticate', 'events', 'peekEvents', 'roomPreview', 'signal', 'chat', 'setState', 'restart', 'leave',
  'getRoomPassword', 'setRoomPassword', 'isRoomHost', 'passwordThrottle', 'passwordFailed', 'passwordSucceeded',
  'listRooms', 'getRoom', 'kick', 'closeRoom', 'reopenRoom', 'broadcast', 'command', 'ban', 'banPeer', 'listBans', 'unban',
] as const;
const store = Object.fromEntries(ALL_METHODS.map((m) => [m, vi.fn()])) as Record<(typeof ALL_METHODS)[number], ReturnType<typeof vi.fn>>;
const setStore = (s: unknown) => {
  (globalThis as unknown as { __telaxStore?: unknown }).__telaxStore = s;
};

const get = (room: string) => preview(new Request(`http://app.test/api/rooms/${encodeURIComponent(room)}/preview`), { params: Promise.resolve({ room }) });

beforeEach(() => {
  for (const fn of Object.values(store)) fn.mockReset();
  setStore(store);
});
afterEach(() => setStore(undefined));

describe('GET /api/rooms/:room/preview com um store falso', () => {
  it('200 com EXATAMENTE count, closed e protected', async () => {
    store.roomPreview.mockResolvedValue({ count: 3, closed: false, protected: false });
    const res = await get('sala');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ count: 3, closed: false, protected: false });
    expect(Object.keys(body).sort()).toEqual(['closed', 'count', 'protected']);
    expect(store.roomPreview).toHaveBeenCalledWith('sala');
  });

  it('cabeçalhos: JSON e sem cache (a contagem muda a toda hora)', async () => {
    store.roomPreview.mockResolvedValue({ count: 0, closed: false, protected: false });
    const res = await get('sala');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('content-type')).toMatch(/application\/json/);
  });

  it('o valor de closed e de protected acompanha o store', async () => {
    store.roomPreview.mockResolvedValue({ count: 0, closed: true, protected: true });
    expect(await (await get('sala')).json()).toEqual({ count: 0, closed: true, protected: true });
  });

  it('o nome é normalizado como no join (minúsculas, sem espaços nas pontas)', async () => {
    store.roomPreview.mockResolvedValue({ count: 1, closed: false, protected: false });
    await get('  Sala Do Time  ');
    expect(store.roomPreview).toHaveBeenCalledWith('sala do time');
  });

  it('o corpo só tem os três campos, mesmo que o store devolva coisa a mais (nome, id, ip, token)', async () => {
    store.roomPreview.mockResolvedValue({
      count: 2,
      closed: false,
      protected: false,
      names: ['Ana', 'Beto'],
      peerId: 'p-secreto',
      ip: '203.0.113.9',
      token: 't-secreto',
      tokenHash: 'h',
    });
    const texto = await (await get('sala')).text();
    expect(Object.keys(JSON.parse(texto)).sort()).toEqual(['closed', 'count', 'protected']);
    for (const segredo of ['Ana', 'Beto', 'p-secreto', '203.0.113.9', 't-secreto', 'tokenHash']) expect(texto).not.toContain(segredo);
  });

  it('nome de sala inválido (vazio, só espaços ou comprido demais) = 400 invalid, sem consultar o store', async () => {
    for (const nome of ['', '   ', 'x'.repeat(200)]) {
      const res = await get(nome);
      expect(res.status, JSON.stringify(nome)).toBe(400);
      expect(await res.json()).toEqual({ error: 'invalid' });
    }
    expect(store.roomPreview).not.toHaveBeenCalled();
  });

  it('é pública (sem cookie nem token) e NÃO aciona nenhum outro método do store: nem escrita nem admin', async () => {
    store.roomPreview.mockResolvedValue({ count: 1, closed: false, protected: false });
    const res = await get('sala'); // sem cookie, sem cabeçalho nenhum
    expect(res.status).toBe(200);
    const outros = ALL_METHODS.filter((m) => m !== 'roomPreview' && store[m].mock.calls.length > 0);
    expect(outros).toEqual([]);
  });
});

describe('GET /api/rooms/:room/preview com o store real em memória', () => {
  let real: MemoryRoomStore;
  beforeEach(() => {
    real = new MemoryRoomStore();
    setStore(real);
  });

  it('sala que não existe: 0 pessoas, aberta, sem senha', async () => {
    expect(await (await get('sala-nova')).json()).toEqual({ count: 0, closed: false, protected: false });
  });

  it('conta quem está na sala, ignora o administrador observador e não vaza nomes nem ids', async () => {
    const a = await real.join('sala-x', 'Ana Secreta', { ip: '198.51.100.4' });
    await real.join('sala-x', 'Beto Secreto');
    await real.join('sala-x', 'Administração', { observer: true });
    const texto = await (await get('SALA-X')).text();
    expect(JSON.parse(texto)).toEqual({ count: 2, closed: false, protected: false });
    for (const segredo of ['Secreta', 'Secreto', 'Administração', a.peerId, a.token, '198.51.100.4']) expect(texto).not.toContain(segredo);
  });

  it('fechar a sala aparece como closed true', async () => {
    await real.join('sala-y', 'Ana');
    await real.closeRoom('sala-y', 'manutenção');
    expect(await (await get('sala-y')).json()).toEqual({ count: 0, closed: true, protected: false });
  });

  it('não escreve: consultar não renova o batimento de ninguém', async () => {
    let t = 1_000_000;
    real = new MemoryRoomStore(() => t);
    setStore(real);
    const a = await real.join('sala-z', 'Ana');
    t += 10_000;
    await get('sala-z');
    t += 6_000; // 16 s desde o join: fora do TTL de 15 s mesmo com a consulta no meio
    expect((await (await get('sala-z')).json()).count).toBe(0);
    await expect(Promise.resolve().then(() => real.peekEvents('sala-z', a.peerId, 0))).rejects.toThrow();
  });
});
