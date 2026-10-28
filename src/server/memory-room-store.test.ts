import { beforeEach, describe, expect, it } from 'vitest';
import type { SignalData } from '@/lib/types';
import { MemoryRoomStore } from './memory-room-store';
import { MAX_EVENTS, MAX_PEERS, PEER_TTL_MS, RoomFullError, UnknownPeerError } from './room-store';

const offer: SignalData = { gen: 0, kind: 'offer', sdp: 'v=0' };

let now = 1_000_000;
let store: MemoryRoomStore;

beforeEach(() => {
  now = 1_000_000;
  store = new MemoryRoomStore(() => now);
});

describe('join', () => {
  it('dá ids distintos a participantes com o mesmo nome e lista os dois', () => {
    const a = store.join('sala', 'Ana');
    const b = store.join('sala', 'Ana');
    expect(a.peerId).not.toBe(b.peerId);
    expect(b.participants.map((p) => p.id).sort()).toEqual([a.peerId, b.peerId].sort());
    expect(b.participants.every((p) => p.name === 'Ana')).toBe(true);
  });

  it('lança RoomFullError no 9º participante', () => {
    for (let i = 0; i < MAX_PEERS; i++) store.join('sala', `p${i}`);
    expect(() => store.join('sala', 'extra')).toThrow(RoomFullError);
  });

  it('avisa quem já está na sala com um evento join', () => {
    const a = store.join('sala', 'Ana');
    const b = store.join('sala', 'Beto');
    const { events } = store.events('sala', a.peerId, a.cursor);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'join', from: b.peerId });
  });
});

describe('events', () => {
  it('entrega eventos com destinatário só a ele', () => {
    const a = store.join('sala', 'Ana');
    const b = store.join('sala', 'Beto');
    const c = store.join('sala', 'Cris');
    store.signal('sala', a.peerId, b.peerId, offer);
    const forB = store.events('sala', b.peerId, b.cursor).events.filter((e) => e.type === 'signal');
    const forC = store.events('sala', c.peerId, c.cursor).events.filter((e) => e.type === 'signal');
    expect(forB).toHaveLength(1);
    expect(forB[0]).toMatchObject({ from: a.peerId, to: b.peerId, payload: offer });
    expect(forC).toHaveLength(0);
  });

  it('não devolve ao remetente os próprios broadcasts', () => {
    const a = store.join('sala', 'Ana');
    store.join('sala', 'Beto');
    store.chat('sala', a.peerId, 'oi');
    const { events } = store.events('sala', a.peerId, a.cursor);
    expect(events.some((e) => e.type === 'chat')).toBe(false);
  });

  it('devolve só o que é novo desde o cursor e avança o cursor', () => {
    const a = store.join('sala', 'Ana');
    const b = store.join('sala', 'Beto');
    store.chat('sala', b.peerId, 'um');
    const first = store.events('sala', a.peerId, a.cursor);
    expect(first.events.filter((e) => e.type === 'chat')).toHaveLength(1);
    store.chat('sala', b.peerId, 'dois');
    const second = store.events('sala', a.peerId, first.cursor);
    expect(second.events).toHaveLength(1);
    expect(second.events[0].payload).toMatchObject({ text: 'dois' });
    expect(second.cursor).toBeGreaterThan(first.cursor);
  });

  it('lança UnknownPeerError para peer inexistente', () => {
    expect(() => store.events('sala', 'fantasma', 0)).toThrow(UnknownPeerError);
  });
});

describe('expiração', () => {
  it('remove peer sem poll por mais de 15 s e avisa os outros', () => {
    const a = store.join('sala', 'Ana');
    const b = store.join('sala', 'Beto');
    now += PEER_TTL_MS;
    store.events('sala', a.peerId, a.cursor); // Ana segue viva; 15 000 ms exatos ainda não expira Beto
    now += 1;
    const { events } = store.events('sala', a.peerId, a.cursor);
    expect(events.some((e) => e.type === 'leave' && e.from === b.peerId)).toBe(true);
    expect(() => store.events('sala', b.peerId, 0)).toThrow(UnknownPeerError);
  });

  it('apaga sala vazia e uma nova join recomeça com gen 0', () => {
    const a = store.join('sala', 'Ana');
    store.restart('sala', a.peerId);
    store.leave('sala', a.peerId);
    expect(store.join('sala', 'Beto').gen).toBe(0);
  });
});

describe('restart e estado', () => {
  it('incrementa gen a cada restart e emite o novo gen', () => {
    const a = store.join('sala', 'Ana');
    const b = store.join('sala', 'Beto');
    expect(store.restart('sala', a.peerId)).toBe(1);
    expect(store.restart('sala', b.peerId)).toBe(2);
    const gens = store
      .events('sala', a.peerId, a.cursor)
      .events.filter((e) => e.type === 'restart')
      .map((e) => (e.payload as { gen: number }).gen);
    expect(gens).toEqual([2]); // o de Ana (gen 1) é dela e não volta para ela
    expect(store.join('sala', 'Cris').gen).toBe(2);
  });

  it('setState altera PeerInfo e emite state', () => {
    const a = store.join('sala', 'Ana');
    const b = store.join('sala', 'Beto');
    store.setState('sala', a.peerId, { audio: false, video: false, sharing: true });
    const { events } = store.events('sala', b.peerId, b.cursor);
    expect(events.find((e) => e.type === 'state')?.payload).toMatchObject({ audio: false, video: false, sharing: true });
    const me = store.join('sala', 'Cris').participants.find((p) => p.id === a.peerId);
    expect(me).toMatchObject({ audio: false, video: false, sharing: true });
  });
});

describe('log de eventos', () => {
  it('guarda no máximo 500 eventos e since antigo não dá erro', () => {
    const a = store.join('sala', 'Ana');
    const b = store.join('sala', 'Beto');
    for (let i = 0; i < MAX_EVENTS + 100; i++) store.chat('sala', b.peerId, `m${i}`);
    const { events } = store.events('sala', a.peerId, 0);
    expect(events.length).toBeLessThanOrEqual(MAX_EVENTS);
    expect(events.length).toBeGreaterThan(0);
  });
});
