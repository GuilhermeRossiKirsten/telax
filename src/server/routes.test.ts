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

async function poll(room: string, peerId: string, since: number) {
  const res = await events(
    new Request(`http://t/api/rooms/x/events?peerId=${peerId}&since=${since}`),
    ctx(room),
  );
  return { res, body: await res.json() };
}

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
});

describe('events', () => {
  it('peer inexistente → 410 gone', async () => {
    const { res, body } = await poll(newRoom(), 'fantasma', 0);
    expect(res.status).toBe(410);
    expect(body.error).toBe('gone');
  });

  it('peer válido recebe eventos e cursor', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    const { res, body } = await poll(room, a.peerId, a.cursor);
    expect(res.status).toBe(200);
    expect(body.events.map((e: { type: string; from: string }) => [e.type, e.from])).toEqual([['join', b.peerId]]);
    expect(body.cursor).toBeGreaterThan(a.cursor);
  });
});

describe('signal, chat, state, restart, leave', () => {
  it('signal chega só ao destinatário', async () => {
    const room = newRoom();
    const a = (await doJoin(room, 'Ana')).body;
    const b = (await doJoin(room, 'Beto')).body;
    const c = (await doJoin(room, 'Cris')).body;
    const data = { gen: 0, kind: 'offer', sdp: 'v=0' };
    expect((await signal(post('signal', { from: a.peerId, to: b.peerId, data }), ctx(room))).status).toBe(200);
    const forB = (await poll(room, b.peerId, b.cursor)).body.events.filter((e: { type: string }) => e.type === 'signal');
    const forC = (await poll(room, c.peerId, c.cursor)).body.events.filter((e: { type: string }) => e.type === 'signal');
    expect(forB).toHaveLength(1);
    expect(forC).toHaveLength(0);
  });

  it('chat vazio ou com 2001 caracteres → 400; válido → 200', async () => {
    const room = newRoom();
    const a = (await doJoin(room)).body;
    expect((await chat(post('chat', { from: a.peerId, text: '  ' }), ctx(room))).status).toBe(400);
    expect((await chat(post('chat', { from: a.peerId, text: 'x'.repeat(2001) }), ctx(room))).status).toBe(400);
    expect((await chat(post('chat', { from: a.peerId, text: 'oi' }), ctx(room))).status).toBe(200);
  });

  it('state exige booleanos', async () => {
    const room = newRoom();
    const a = (await doJoin(room)).body;
    const bad = await state(post('state', { from: a.peerId, audio: 'sim', video: true, sharing: false }), ctx(room));
    expect(bad.status).toBe(400);
    const ok = await state(post('state', { from: a.peerId, audio: false, video: true, sharing: false }), ctx(room));
    expect(ok.status).toBe(200);
  });

  it('restart devolve gen crescente', async () => {
    const room = newRoom();
    const a = (await doJoin(room)).body;
    const r1 = await (await restart(post('restart', { from: a.peerId }), ctx(room))).json();
    const r2 = await (await restart(post('restart', { from: a.peerId }), ctx(room))).json();
    expect([r1.gen, r2.gen]).toEqual([1, 2]);
  });

  it('peer desconhecido em signal/chat/restart → 410', async () => {
    const room = newRoom();
    await doJoin(room);
    expect((await chat(post('chat', { from: 'x', text: 'oi' }), ctx(room))).status).toBe(410);
    expect((await restart(post('restart', { from: 'x' }), ctx(room))).status).toBe(410);
  });

  it('leave remove o peer: events depois dá 410', async () => {
    const room = newRoom();
    const a = (await doJoin(room)).body;
    expect((await leave(post('leave', { peerId: a.peerId }), ctx(room))).status).toBe(200);
    expect((await poll(room, a.peerId, 0)).res.status).toBe(410);
  });
});
