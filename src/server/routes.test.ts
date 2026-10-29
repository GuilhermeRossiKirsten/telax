import { afterEach, describe, expect, it } from 'vitest';
import { POST as chat } from '@/app/api/rooms/[room]/chat/route';
import { GET as events } from '@/app/api/rooms/[room]/events/route';
import { POST as join } from '@/app/api/rooms/[room]/join/route';
import { POST as leave } from '@/app/api/rooms/[room]/leave/route';
import { POST as restart } from '@/app/api/rooms/[room]/restart/route';
import { POST as signal } from '@/app/api/rooms/[room]/signal/route';
import { POST as state } from '@/app/api/rooms/[room]/state/route';
import { parseWait } from '@/server/http';

const resetStore = () => {
  (globalThis as unknown as { __telaxStore?: unknown }).__telaxStore = undefined;
};
/** Roda `fn` com MAX_PEERS definido (ou removido) e devolve o ambiente ao que era, com o store recriado. */
async function withMaxPeers<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
  const before = process.env.MAX_PEERS;
  if (value === undefined) delete process.env.MAX_PEERS;
  else process.env.MAX_PEERS = value;
  resetStore();
  try {
    return await fn();
  } finally {
    if (before === undefined) delete process.env.MAX_PEERS;
    else process.env.MAX_PEERS = before;
    resetStore();
  }
}
afterEach(resetStore);

let n = 0;
const newRoom = () => `rota-${++n}`;
const ctx = (room: string) => ({ params: Promise.resolve({ room }) });
const post = (url: string, body: unknown) =>
  new Request(`http://t/api/rooms/x/${url}`, { method: 'POST', body: typeof body === 'string' ? body : JSON.stringify(body) });

async function doJoin(room: string, name = 'Ana') {
  const res = await join(post('join', { name }), ctx(room));
  return { res, body: await res.json() };
}

async function poll(room: string, peerId: string, since: number, token: string | null) {
  const q = token === null ? '' : `&token=${encodeURIComponent(token)}`;
  const res = await events(new Request(`http://t/api/rooms/x/events?peerId=${peerId}&since=${since}${q}`), ctx(room));
  return { res, body: await res.json() };
}

type Ev = { type: string; from: string; payload: unknown };
const signalsFor = async (room: string, p: { peerId: string; cursor: number; token: string }) =>
  (await poll(room, p.peerId, p.cursor, p.token)).body.events.filter((e: Ev) => e.type === 'signal') as Ev[];

describe('join', () => {
  it('rejeita nome vazio com 400', async () => {
    const res = await join(post('join', { name: '  ' }), ctx(newRoom()));
    expect(res.status).toBe(400);
  });

  it('aceita nome válido e devolve peerId, participantes, gen e iceServers', async () => {
    const { res, body } = await doJoin(newRoom());
    expect(res.status).toBe(200);
    expect(body.peerId).toEqual(expect.any(String));
    expect(body.participants).toHaveLength(1);
    expect(body.gen).toBe(0);
    expect(body.iceServers[0]).toEqual({ urls: 'stun:stun.l.google.com:19302' });
  });

  it('devolve um token que não aparece na lista de participantes', async () => {
    const { body } = await doJoin(newRoom());
    expect(body.token).toEqual(expect.any(String));
    expect(JSON.stringify(body.participants)).not.toContain(body.token);
  });

  it('SEM MAX_PEERS não há limite: o 9º e o 30º participantes entram (200)', async () => {
    await withMaxPeers(undefined, async () => {
      const room = newRoom();
      for (let i = 0; i < 30; i++) expect((await doJoin(room, `p${i}`)).res.status).toBe(200);
    });
  });

  it('com MAX_PEERS=8 (limite opcional) responde 409 room_full no 9º participante', async () => {
    await withMaxPeers('8', async () => {
      const room = newRoom();
      for (let i = 0; i < 8; i++) expect((await doJoin(room, `p${i}`)).res.status).toBe(200);
      const { res, body } = await doJoin(room, 'extra');
      expect(res.status).toBe(409);
      expect(body.error).toBe('room_full');
    });
  });

  it('trata o nome da sala sem diferenciar maiúsculas', async () => {
    const room = newRoom();
    await doJoin(room.toUpperCase());
    const { body } = await doJoin(room);
    expect(body.participants).toHaveLength(2);
  });

  it('responde 400 (nunca 500) a JSON malformado', async () => {
    const res = await join(post('join', '{nao é json'), ctx(newRoom()));
    expect(res.status).toBe(400);
  });

  it('corpo acima de 128 KiB → 400', async () => {
    const res = await join(post('join', { name: 'Ana', pad: 'x'.repeat(128 * 1024) }), ctx(newRoom()));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid');
  });
});

describe('events', () => {
  it('peer inexistente → 410 gone', async () => {
    const { res, body } = await poll(newRoom(), 'fantasma', 0, 'x');
    expect(res.status).toBe(410);
    expect(body.error).toBe('gone');
  });

  it('peer válido recebe eventos e cursor', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    const { res, body } = await poll(room, a.peerId, a.cursor, a.token);
    expect(res.status).toBe(200);
    expect(body.events.map((e: { type: string; from: string }) => [e.type, e.from])).toEqual([['join', b.peerId]]);
    expect(body.cursor).toBeGreaterThan(a.cursor);
  });

  it('token errado → 410 gone; token ausente → 400', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    const wrong = await poll(room, a.peerId, 0, b.token);
    expect(wrong.res.status).toBe(410);
    expect(wrong.body.error).toBe('gone');
    expect((await poll(room, a.peerId, 0, null)).res.status).toBe(400);
  });
});

describe('events com espera longa (wait)', () => {
  const pollWait = (room: string, p: { peerId: string; token: string }, since: number, wait: string | number, signal?: AbortSignal) =>
    events(new Request(`http://t/api/rooms/x/events?peerId=${p.peerId}&since=${since}&token=${encodeURIComponent(p.token)}&wait=${wait}`, { signal }), ctx(room));
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

  it('parseWait: só inteiro de 0 a 8000; o resto vira 0 (imediato) e o excesso é cortado em 8000', () => {
    expect([undefined, null, '', 'abc', '-5', '1.5', '0', '1e3'].map((v) => parseWait(v as string | null | undefined))).toEqual([0, 0, 0, 0, 0, 0, 0, 0]);
    expect(parseWait('2500')).toBe(2500);
    expect(parseWait('8000')).toBe(8000);
    expect(parseWait('999999')).toBe(8000);
  });

  it('devolve ANTES do prazo quando chega um evento durante a espera', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    const t0 = Date.now();
    const pending = pollWait(room, a, (await poll(room, a.peerId, a.cursor, a.token)).body.cursor, 1500);
    await sleep(300);
    await chat(post('chat', { from: b.peerId, token: b.token, text: 'acorda' }), ctx(room));
    const res = await pending;
    const elapsed = Date.now() - t0;
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.events.map((e: Ev) => e.type)).toEqual(['chat']);
    expect(elapsed).toBeLessThan(1300); // bem antes dos 1500 ms (a espera checa a cada ~700 ms)
  });

  it('sem eventos devolve { events: [] } perto do prazo, com o cursor', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const t0 = Date.now();
    const res = await pollWait(room, a, a.cursor, 900);
    const elapsed = Date.now() - t0;
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.events).toEqual([]);
    expect(body.cursor).toBe(a.cursor);
    expect(elapsed).toBeGreaterThanOrEqual(800);
    expect(elapsed).toBeLessThan(2200);
  });

  it('já havendo eventos novos, responde na hora (sem esperar)', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    await doJoin(room, 'Beto');
    const t0 = Date.now();
    const res = await pollWait(room, a, a.cursor, 5000);
    expect(Date.now() - t0).toBeLessThan(400);
    expect((await res.json()).events.map((e: Ev) => e.type)).toEqual(['join']);
  });

  it('sem wait (ou wait inválido) continua imediato', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    for (const w of ['abc', '-5', '1.5', '0']) {
      const t0 = Date.now();
      const res = await pollWait(room, a, a.cursor, w);
      expect(res.status).toBe(200);
      expect(Date.now() - t0).toBeLessThan(400);
    }
    const t0 = Date.now();
    expect((await poll(room, a.peerId, a.cursor, a.token)).res.status).toBe(200);
    expect(Date.now() - t0).toBeLessThan(400);
  });

  it('wait gigante é cortado (não quebra): acorda com o evento', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    const cursor = (await poll(room, a.peerId, a.cursor, a.token)).body.cursor;
    const pending = pollWait(room, a, cursor, 999_999);
    await sleep(200);
    await chat(post('chat', { from: b.peerId, token: b.token, text: 'oi' }), ctx(room));
    const res = await pending;
    expect(res.status).toBe(200);
    expect((await res.json()).events.map((e: Ev) => e.type)).toEqual(['chat']);
  });

  it('peer inexistente ou token errado → 410 na hora, mesmo com wait', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    const t0 = Date.now();
    expect((await pollWait(room, { peerId: 'fantasma', token: 'x' }, 0, 5000)).status).toBe(410);
    expect((await pollWait(room, { peerId: a.peerId, token: b.token }, 0, 5000)).status).toBe(410);
    expect(Date.now() - t0).toBeLessThan(500);
  });

  it('se o peer some durante a espera (leave), responde 410', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const cursor = (await poll(room, a.peerId, a.cursor, a.token)).body.cursor;
    const pending = pollWait(room, a, cursor, 3000);
    await sleep(200);
    await leave(post('leave', { peerId: a.peerId, token: a.token }), ctx(room));
    const res = await pending;
    expect(res.status).toBe(410);
  });

  it('o cliente que aborta a requisição encerra a espera sem erro', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const ac = new AbortController();
    const t0 = Date.now();
    const pending = pollWait(room, a, a.cursor, 5000, ac.signal);
    await sleep(200);
    ac.abort();
    await pending; // não lança
    expect(Date.now() - t0).toBeLessThan(2000);
  });
});

describe('signal em lote', () => {
  const cand = (i: number) => ({ gen: 0, kind: 'candidate', sid: 7, candidate: { candidate: `c${i}` } });
  const sendBatch = (room: string, a: { peerId: string; token: string }, items: unknown) =>
    signal(post('signal', { from: a.peerId, token: a.token, items }), ctx(room));

  it('aplica todos, EM ORDEM, e a resposta é igual à do formato único', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    const res = await sendBatch(room, a, [0, 1, 2].map((i) => ({ to: b.peerId, data: cand(i) })));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const got = await signalsFor(room, b);
    expect(got.map((e) => (e.payload as { candidate: { candidate: string } }).candidate.candidate)).toEqual(['c0', 'c1', 'c2']);
  });

  it('um item inválido derruba o pedido inteiro (400) e NADA é aplicado', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    const items = [
      { to: b.peerId, data: cand(0) },
      { to: b.peerId, data: { gen: 0, kind: 'offer', sdp: 'x'.repeat(32 * 1024 + 1) } },
      { to: b.peerId, data: cand(2) },
    ];
    const res = await sendBatch(room, a, items);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('invalid');
    expect(await signalsFor(room, b)).toHaveLength(0);
    // item sem destinatário, com destinatário não-string ou sem data também
    for (const bad of [{ data: cand(0) }, { to: 5, data: cand(0) }, { to: b.peerId }, { to: b.peerId, data: null }, 'texto', null]) {
      expect((await sendBatch(room, a, [{ to: b.peerId, data: cand(1) }, bad])).status).toBe(400);
    }
    expect(await signalsFor(room, b)).toHaveLength(0);
  });

  it('aceita 50 itens e rejeita 51; lista vazia e não-lista → 400', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    const many = (k: number) => Array.from({ length: k }, (_, i) => ({ to: b.peerId, data: cand(i) }));
    expect((await sendBatch(room, a, many(50))).status).toBe(200);
    expect(await signalsFor(room, b)).toHaveLength(50);
    expect((await sendBatch(room, a, many(51))).status).toBe(400);
    expect(await signalsFor(room, b)).toHaveLength(50); // os 51 não foram aplicados
    expect((await sendBatch(room, a, [])).status).toBe(400);
    expect((await sendBatch(room, a, 'x')).status).toBe(400);
    expect((await sendBatch(room, a, { to: b.peerId, data: cand(0) })).status).toBe(400);
  });

  it('não aceita os dois formatos misturados (items junto com to/data) → 400', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    const res = await signal(
      post('signal', { from: a.peerId, token: a.token, to: b.peerId, data: cand(0), items: [{ to: b.peerId, data: cand(1) }] }),
      ctx(room),
    );
    expect(res.status).toBe(400);
    expect(await signalsFor(room, b)).toHaveLength(0);
  });

  it('destinatário ausente num item é ignorado em silêncio; os demais chegam', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    const res = await sendBatch(room, a, [
      { to: b.peerId, data: cand(0) },
      { to: 'ninguem', data: cand(1) },
      { to: b.peerId, data: cand(2) },
    ]);
    expect(res.status).toBe(200);
    expect(await signalsFor(room, b)).toHaveLength(2);
  });

  it('remetente com token errado → 410 e nada é entregue', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    const res = await sendBatch(room, { peerId: a.peerId, token: b.token }, [{ to: b.peerId, data: cand(0) }]);
    expect(res.status).toBe(410);
    expect(await signalsFor(room, b)).toHaveLength(0);
  });

  it('o formato antigo { from, to, data } continua funcionando', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    const res = await signal(post('signal', { from: a.peerId, token: a.token, to: b.peerId, data: cand(9) }), ctx(room));
    expect(res.status).toBe(200);
    expect(await signalsFor(room, b)).toHaveLength(1);
  });
});

describe('autenticação dos POST', () => {
  it('chat com token errado → 410 e a mensagem não chega aos outros', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    const res = await chat(post('chat', { from: a.peerId, token: b.token, text: 'falso' }), ctx(room));
    expect(res.status).toBe(410);
    expect((await res.json()).error).toBe('gone');
    const got = (await poll(room, b.peerId, b.cursor, b.token)).body.events.filter((e: Ev) => e.type === 'chat');
    expect(got).toHaveLength(0);
  });

  it('token ausente ou não-string → 400 em signal, chat, state, restart e leave', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const data = { gen: 0, kind: 'reset' };
    for (const token of [undefined, 1, '']) {
      expect((await signal(post('signal', { from: a.peerId, token, to: a.peerId, data }), ctx(room))).status).toBe(400);
      expect((await chat(post('chat', { from: a.peerId, token, text: 'oi' }), ctx(room))).status).toBe(400);
      const st = { from: a.peerId, token, audio: true, video: true, sharing: false };
      expect((await state(post('state', st), ctx(room))).status).toBe(400);
      expect((await restart(post('restart', { from: a.peerId, token }), ctx(room))).status).toBe(400);
      expect((await leave(post('leave', { peerId: a.peerId, token }), ctx(room))).status).toBe(400);
    }
  });

  it('campo de id ausente → 400', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    expect((await restart(post('restart', { token: a.token }), ctx(room))).status).toBe(400);
    expect((await leave(post('leave', { token: a.token }), ctx(room))).status).toBe(400);
  });

  it('leave com token errado não remove o peer', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    expect((await leave(post('leave', { peerId: a.peerId, token: b.token }), ctx(room))).status).toBe(410);
    expect((await poll(room, a.peerId, 0, a.token)).res.status).toBe(200);
  });

  it('restart e state com token errado → 410 e nada muda', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    expect((await restart(post('restart', { from: a.peerId, token: b.token }), ctx(room))).status).toBe(410);
    const st = { from: a.peerId, token: b.token, audio: false, video: false, sharing: true };
    expect((await state(post('state', st), ctx(room))).status).toBe(410);
    const evs = (await poll(room, b.peerId, b.cursor, b.token)).body.events as Ev[];
    expect(evs.filter((e) => e.type === 'restart' || e.type === 'state')).toHaveLength(0);
  });
});

describe('signal, chat, state, restart, leave', () => {
  it('signal chega só ao destinatário', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    const c = (await doJoin(room, 'Cris')).body;
    const data = { gen: 0, kind: 'offer', sdp: 'v=0' };
    expect((await signal(post('signal', { from: a.peerId, token: a.token, to: b.peerId, data }), ctx(room))).status).toBe(200);
    expect(await signalsFor(room, b)).toHaveLength(1);
    expect(await signalsFor(room, c)).toHaveLength(0);
  });

  it('signal com campo extra é entregue sem o campo extra', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    const data = { gen: 0, kind: 'candidate', evil: 'x', candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0, junk: 1 } };
    expect((await signal(post('signal', { from: a.peerId, token: a.token, to: b.peerId, data }), ctx(room))).status).toBe(200);
    const [got] = await signalsFor(room, b);
    expect(got.payload).toEqual({ gen: 0, kind: 'candidate', candidate: { candidate: 'c', sdpMid: '0', sdpMLineIndex: 0 } });
  });

  it('signal com sdp > 32 KiB ou candidate.candidate > 2048 → 400 e nada é emitido', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    const send = (data: unknown) => signal(post('signal', { from: a.peerId, token: a.token, to: b.peerId, data }), ctx(room));
    const big = await send({ gen: 0, kind: 'offer', sdp: 'x'.repeat(32 * 1024 + 1) });
    expect(big.status).toBe(400);
    expect((await big.json()).error).toBe('invalid');
    expect((await send({ gen: 0, kind: 'candidate', candidate: { candidate: 'x'.repeat(2049) } })).status).toBe(400);
    expect((await send({ gen: -1, kind: 'offer' })).status).toBe(400);
    expect(await signalsFor(room, b)).toHaveLength(0);
  });

  it('chat vazio ou com 2001 caracteres → 400; válido → 200', async () => {
    const room = newRoom();
    const a = (await doJoin(room)).body;
    expect((await chat(post('chat', { from: a.peerId, token: a.token, text: '  ' }), ctx(room))).status).toBe(400);
    expect((await chat(post('chat', { from: a.peerId, token: a.token, text: 'x'.repeat(2001) }), ctx(room))).status).toBe(400);
    expect((await chat(post('chat', { from: a.peerId, token: a.token, text: 'oi' }), ctx(room))).status).toBe(200);
  });

  it('state exige booleanos', async () => {
    const room = newRoom();
    const a = (await doJoin(room)).body;
    const bad = await state(post('state', { from: a.peerId, token: a.token, audio: 'sim', video: true, sharing: false }), ctx(room));
    expect(bad.status).toBe(400);
    const ok = await state(post('state', { from: a.peerId, token: a.token, audio: false, video: true, sharing: false }), ctx(room));
    expect(ok.status).toBe(200);
  });

  it('state aceita screenSlots e deriva sharing; inválido → 400 e nada muda', async () => {
    const room = newRoom();
    const a = (await doJoin(room)).body;
    const b = (await doJoin(room)).body;
    const send = (extra: Record<string, unknown>) =>
      state(post('state', { from: a.peerId, token: a.token, audio: true, video: true, ...extra }), ctx(room));
    expect((await send({ screenSlots: 3 })).status).toBe(200);
    for (const bad of [8, -1, 1.5, '3', Number.NaN, null]) {
      expect((await send({ sharing: false, screenSlots: bad })).status).toBe(400);
      expect((await send({ screenSlots: bad })).status).toBe(400);
    }
    expect((await send({})).status).toBe(400); // nem sharing nem screenSlots
    expect((await send({ sharing: 'sim', screenSlots: 1 })).status).toBe(400);
    const evs = (await poll(room, b.peerId, b.cursor, b.token)).body.events as Ev[];
    const states = evs.filter((e) => e.type === 'state');
    expect(states).toHaveLength(1);
    expect(states[0].payload).toEqual({ audio: true, video: true, sharing: true, screenSlots: 3 });
  });

  it('state só com sharing continua valendo (compatibilidade): vira screenSlots 1', async () => {
    const room = newRoom();
    const a = (await doJoin(room)).body;
    const b = (await doJoin(room)).body;
    const ok = await state(post('state', { from: a.peerId, token: a.token, audio: true, video: true, sharing: true }), ctx(room));
    expect(ok.status).toBe(200);
    const evs = (await poll(room, b.peerId, b.cursor, b.token)).body.events as Ev[];
    expect(evs.find((e) => e.type === 'state')?.payload).toMatchObject({ sharing: true, screenSlots: 1 });
  });

  it('restart devolve gen crescente', async () => {
    const room = newRoom();
    const a = (await doJoin(room)).body;
    const r1 = await (await restart(post('restart', { from: a.peerId, token: a.token }), ctx(room))).json();
    const r2 = await (await restart(post('restart', { from: a.peerId, token: a.token }), ctx(room))).json();
    expect([r1.gen, r2.gen]).toEqual([1, 2]);
  });

  it('peer desconhecido em signal/chat/restart → 410', async () => {
    const room = newRoom();
    await doJoin(room);
    expect((await chat(post('chat', { from: 'x', token: 'x', text: 'oi' }), ctx(room))).status).toBe(410);
    expect((await restart(post('restart', { from: 'x', token: 'x' }), ctx(room))).status).toBe(410);
  });

  it('leave remove o peer: events depois dá 410', async () => {
    const room = newRoom();
    const a = (await doJoin(room)).body;
    expect((await leave(post('leave', { peerId: a.peerId, token: a.token }), ctx(room))).status).toBe(200);
    expect((await poll(room, a.peerId, 0, a.token)).res.status).toBe(410);
  });
});
