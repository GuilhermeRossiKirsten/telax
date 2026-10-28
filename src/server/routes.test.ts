import { describe, expect, it } from 'vitest';
import { POST as chat } from '@/app/api/rooms/[room]/chat/route';
import { GET as events } from '@/app/api/rooms/[room]/events/route';
import { POST as join } from '@/app/api/rooms/[room]/join/route';
import { POST as leave } from '@/app/api/rooms/[room]/leave/route';
import { POST as restart } from '@/app/api/rooms/[room]/restart/route';
import { POST as signal } from '@/app/api/rooms/[room]/signal/route';
import { POST as state } from '@/app/api/rooms/[room]/state/route';

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

  it('responde 409 room_full no 9º participante', async () => {
    const room = newRoom();
    for (let i = 0; i < 8; i++) expect((await doJoin(room, `p${i}`)).res.status).toBe(200);
    const { res, body } = await doJoin(room, 'extra');
    expect(res.status).toBe(409);
    expect(body.error).toBe('room_full');
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
