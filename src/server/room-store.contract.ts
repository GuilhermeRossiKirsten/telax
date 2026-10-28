import { beforeEach, describe, expect, it } from 'vitest';
import type { SignalData } from '@/lib/types';
import { MAX_EVENTS, MAX_PEERS, PEER_TTL_MS, RoomFullError, UnknownPeerError, type RoomStore } from './room-store';

const offer: SignalData = { gen: 0, kind: 'offer', sdp: 'v=0' };

/** `fn` pode lançar de forma síncrona (memória) ou rejeitar (Mongo): o contrato é o mesmo. */
const rejects = (fn: () => unknown) => expect((async () => fn())()).rejects;

/**
 * Contrato que toda implementação de RoomStore cumpre. `make` recebe o relógio (ms) para que os
 * testes de expiração avancem o tempo sem esperar. Cada teste usa uma sala única.
 */
export function describeRoomStore(label: string, make: (now: () => number) => RoomStore | Promise<RoomStore>) {
  describe(`contrato do RoomStore: ${label}`, () => {
    let now = 1_000_000;
    let store: RoomStore;
    let room: string;
    let seq = 0;

    beforeEach(async () => {
      now = 1_000_000;
      store = await make(() => now);
      room = `sala-${Date.now()}-${++seq}`;
    });

    describe('join', () => {
      it('dá ids distintos a participantes com o mesmo nome e lista os dois', async () => {
        const a = await store.join(room, 'Ana');
        const b = await store.join(room, 'Ana');
        expect(a.peerId).not.toBe(b.peerId);
        expect(b.participants.map((p) => p.id).sort()).toEqual([a.peerId, b.peerId].sort());
        expect(b.participants.every((p) => p.name === 'Ana')).toBe(true);
      });

      it('lança RoomFullError no 9º participante', async () => {
        for (let i = 0; i < MAX_PEERS; i++) await store.join(room, `p${i}`);
        await rejects(() => store.join(room, 'extra')).toThrow(RoomFullError);
      });

      it('com joins simultâneos entram exatamente 8 e o resto recebe RoomFullError', async () => {
        const results = await Promise.allSettled(
          Array.from({ length: 12 }, async (_, i) => store.join(room, `p${i}`)),
        );
        const ok = results.filter((r) => r.status === 'fulfilled');
        const full = results.filter((r) => r.status === 'rejected' && r.reason instanceof RoomFullError);
        expect(ok).toHaveLength(MAX_PEERS);
        expect(full).toHaveLength(12 - MAX_PEERS);
      });

      it('avisa quem já está na sala com um evento join', async () => {
        const a = await store.join(room, 'Ana');
        const b = await store.join(room, 'Beto');
        const { events } = await store.events(room, a.peerId, a.cursor);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: 'join', from: b.peerId });
      });
    });

    describe('events', () => {
      it('entrega eventos com destinatário só a ele', async () => {
        const a = await store.join(room, 'Ana');
        const b = await store.join(room, 'Beto');
        const c = await store.join(room, 'Cris');
        await store.signal(room, a.peerId, b.peerId, offer);
        const forB = (await store.events(room, b.peerId, b.cursor)).events.filter((e) => e.type === 'signal');
        const forC = (await store.events(room, c.peerId, c.cursor)).events.filter((e) => e.type === 'signal');
        expect(forB).toHaveLength(1);
        expect(forB[0]).toMatchObject({ from: a.peerId, to: b.peerId, payload: offer });
        expect(forC).toHaveLength(0);
      });

      it('não devolve ao remetente os próprios broadcasts', async () => {
        const a = await store.join(room, 'Ana');
        await store.join(room, 'Beto');
        await store.chat(room, a.peerId, 'oi');
        const { events } = await store.events(room, a.peerId, a.cursor);
        expect(events.some((e) => e.type === 'chat')).toBe(false);
      });

      it('devolve só o que é novo desde o cursor e avança o cursor', async () => {
        const a = await store.join(room, 'Ana');
        const b = await store.join(room, 'Beto');
        await store.chat(room, b.peerId, 'um');
        const first = await store.events(room, a.peerId, a.cursor);
        expect(first.events.filter((e) => e.type === 'chat')).toHaveLength(1);
        await store.chat(room, b.peerId, 'dois');
        const second = await store.events(room, a.peerId, first.cursor);
        expect(second.events).toHaveLength(1);
        expect(second.events[0].payload).toMatchObject({ text: 'dois' });
        expect(second.cursor).toBeGreaterThan(first.cursor);
      });

      it('lança UnknownPeerError para peer inexistente', async () => {
        await rejects(() => store.events(room, 'fantasma', 0)).toThrow(UnknownPeerError);
      });

      it('mensagens simultâneas recebem seq únicos e todas chegam', async () => {
        const a = await store.join(room, 'Ana');
        const b = await store.join(room, 'Beto');
        await Promise.all(Array.from({ length: 30 }, (_, i) => store.chat(room, b.peerId, `m${i}`)));
        const { events } = await store.events(room, a.peerId, a.cursor);
        const chats = events.filter((e) => e.type === 'chat');
        expect(chats).toHaveLength(30);
        expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
      });
    });

    describe('expiração', () => {
      it('remove peer sem poll por mais de 15 s e avisa os outros', async () => {
        const a = await store.join(room, 'Ana');
        const b = await store.join(room, 'Beto');
        now += PEER_TTL_MS;
        await store.events(room, a.peerId, a.cursor); // Ana segue viva; 15 000 ms exatos ainda não expira Beto
        now += 1;
        const { events } = await store.events(room, a.peerId, a.cursor);
        expect(events.some((e) => e.type === 'leave' && e.from === b.peerId)).toBe(true);
        await rejects(() => store.events(room, b.peerId, 0)).toThrow(UnknownPeerError);
      });

      it('apaga sala vazia e uma nova join recomeça com gen 0', async () => {
        const a = await store.join(room, 'Ana');
        await store.restart(room, a.peerId);
        await store.leave(room, a.peerId);
        expect((await store.join(room, 'Beto')).gen).toBe(0);
      });
    });

    describe('restart e estado', () => {
      it('incrementa gen a cada restart e emite o novo gen', async () => {
        const a = await store.join(room, 'Ana');
        const b = await store.join(room, 'Beto');
        expect(await store.restart(room, a.peerId)).toBe(1);
        expect(await store.restart(room, b.peerId)).toBe(2);
        const gens = (await store.events(room, a.peerId, a.cursor)).events
          .filter((e) => e.type === 'restart')
          .map((e) => (e.payload as { gen: number }).gen);
        expect(gens).toEqual([2]); // o de Ana (gen 1) é dela e não volta para ela
        expect((await store.join(room, 'Cris')).gen).toBe(2);
      });

      it('setState altera PeerInfo e emite state', async () => {
        const a = await store.join(room, 'Ana');
        const b = await store.join(room, 'Beto');
        await store.setState(room, a.peerId, { audio: false, video: false, sharing: true });
        const { events } = await store.events(room, b.peerId, b.cursor);
        expect(events.find((e) => e.type === 'state')?.payload).toMatchObject({
          audio: false,
          video: false,
          sharing: true,
        });
        const me = (await store.join(room, 'Cris')).participants.find((p) => p.id === a.peerId);
        expect(me).toMatchObject({ audio: false, video: false, sharing: true });
      });
    });

    describe('token e authenticate', () => {
      it('join devolve um token distinto por peer', async () => {
        const a = await store.join(room, 'Ana');
        const b = await store.join(room, 'Beto');
        expect(a.token).toEqual(expect.any(String));
        expect(a.token.length).toBeGreaterThan(0);
        expect(a.token).not.toBe(b.token);
      });

      it('authenticate aceita o token certo', async () => {
        const a = await store.join(room, 'Ana');
        await expect((async () => store.authenticate(room, a.peerId, a.token))()).resolves.toBeUndefined();
      });

      it('authenticate lança UnknownPeerError com token errado, peer ou sala inexistente', async () => {
        const a = await store.join(room, 'Ana');
        const b = await store.join(room, 'Beto');
        await rejects(() => store.authenticate(room, a.peerId, b.token)).toThrow(UnknownPeerError);
        await rejects(() => store.authenticate(room, a.peerId, '')).toThrow(UnknownPeerError);
        await rejects(() => store.authenticate(room, 'fantasma', a.token)).toThrow(UnknownPeerError);
        await rejects(() => store.authenticate(`${room}-outra`, a.peerId, a.token)).toThrow(UnknownPeerError);
      });

      it('authenticate não aceita peer expirado', async () => {
        const a = await store.join(room, 'Ana');
        now += PEER_TTL_MS + 1;
        await rejects(() => store.authenticate(room, a.peerId, a.token)).toThrow(UnknownPeerError);
      });

      it('o token não aparece em participants nem em eventos', async () => {
        const a = await store.join(room, 'Ana');
        const b = await store.join(room, 'Beto');
        await store.chat(room, b.peerId, 'oi');
        const dump = JSON.stringify([b.participants, await store.events(room, a.peerId, 0)]);
        expect(dump).not.toContain(a.token);
        expect(dump).not.toContain(b.token);
        expect(b.participants.every((p) => !('token' in p))).toBe(true);
      });
    });

    describe('signal e gen', () => {
      it('descarta em silêncio sinal com gen maior que o da sala; gen ≤ é entregue', async () => {
        const a = await store.join(room, 'Ana');
        const b = await store.join(room, 'Beto');
        await store.restart(room, a.peerId); // gen da sala = 1
        await store.signal(room, a.peerId, b.peerId, { gen: 2, kind: 'offer', sdp: 'v=0' });
        await store.signal(room, a.peerId, b.peerId, { gen: 1, kind: 'offer', sdp: 'v=1' });
        await store.signal(room, a.peerId, b.peerId, { gen: 0, kind: 'offer', sdp: 'v=2' });
        const sigs = (await store.events(room, b.peerId, b.cursor)).events.filter((e) => e.type === 'signal');
        expect(sigs.map((e) => (e.payload as SignalData).sdp)).toEqual(['v=1', 'v=2']);
      });

      it('sinal para destinatário que não está na sala é ignorado sem erro', async () => {
        const a = await store.join(room, 'Ana');
        await expect((async () => store.signal(room, a.peerId, 'fantasma', offer))()).resolves.toBeUndefined();
      });

      it('sinal de remetente desconhecido lança UnknownPeerError', async () => {
        const a = await store.join(room, 'Ana');
        await rejects(() => store.signal(room, 'fantasma', a.peerId, offer)).toThrow(UnknownPeerError);
      });
    });

    describe('conteúdo do usuário é sempre dado, nunca expressão', () => {
      it('chat que começa com $ ou parece caminho de campo chega exatamente como foi digitado', async () => {
        const a = await store.join(room, 'Ana');
        const b = await store.join(room, 'Beto');
        for (const text of ['$peers', '$events', '$$ROOT', '$seq', '{"$set":1}']) await store.chat(room, b.peerId, text);
        const { events } = await store.events(room, a.peerId, a.cursor);
        const texts = events.filter((e) => e.type === 'chat').map((e) => (e.payload as { text: string }).text);
        expect(texts).toEqual(['$peers', '$events', '$$ROOT', '$seq', '{"$set":1}']);
      });

      it('nome e sdp que começam com $ também ficam literais', async () => {
        const a = await store.join(room, '$peers');
        const b = await store.join(room, 'Beto');
        expect(b.participants.find((p) => p.id === a.peerId)?.name).toBe('$peers');
        await store.signal(room, b.peerId, a.peerId, { gen: 0, kind: 'offer', sdp: '$events' });
        const sig = (await store.events(room, a.peerId, a.cursor)).events.find((e) => e.type === 'signal');
        expect((sig?.payload as SignalData).sdp).toBe('$events');
      });

      it('peerId com ponto ou $ não alcança campos internos: dá UnknownPeerError', async () => {
        const a = await store.join(room, 'Ana');
        for (const evil of [`${a.peerId}.token`, `${a.peerId}.tokenHash`, '$where', 'a.b', '']) {
          await rejects(() => store.authenticate(room, evil, a.token)).toThrow(UnknownPeerError);
          await rejects(() => store.events(room, evil, 0)).toThrow(UnknownPeerError);
          await rejects(() => store.chat(room, evil, 'x')).toThrow(UnknownPeerError);
        }
      });
    });

    describe('log de eventos', () => {
      it('guarda no máximo 500 eventos e since antigo não dá erro', async () => {
        const a = await store.join(room, 'Ana');
        const b = await store.join(room, 'Beto');
        for (let i = 0; i < MAX_EVENTS + 100; i++) await store.chat(room, b.peerId, `m${i}`);
        const { events } = await store.events(room, a.peerId, 0);
        expect(events.length).toBeLessThanOrEqual(MAX_EVENTS);
        expect(events.length).toBeGreaterThan(0);
      });
    });
  });
}
