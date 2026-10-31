import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SignalData } from '@/lib/types';
import type { PasswordRecord } from './room-password';
import {
  BannedError,
  MAX_EVENTS,
  PEER_TTL_MS,
  RoomClosedError,
  RoomFullError,
  UnknownPeerError,
  type RoomStore,
  type RoomStoreOptions,
} from './room-store';

const offer: SignalData = { gen: 0, kind: 'offer', sdp: 'v=0' };

/** `fn` pode lançar de forma síncrona (memória) ou rejeitar (Mongo): o contrato é o mesmo. */
const rejects = (fn: () => unknown) => expect((async () => fn())()).rejects;

/**
 * Contrato que toda implementação de RoomStore cumpre. `make` recebe o relógio (ms) para que os
 * testes de expiração avancem o tempo sem esperar. Cada teste usa uma sala única.
 */
export function describeRoomStore(
  label: string,
  make: (now: () => number, opts?: RoomStoreOptions) => RoomStore | Promise<RoomStore>,
) {
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

      it('SEM limite configurado entram 25 participantes, em sequência, sem erro', async () => {
        for (let i = 0; i < 25; i++) await store.join(room, `p${i}`);
        const last = await store.join(room, 'extra');
        expect(last.participants).toHaveLength(26);
      });

      it('SEM limite configurado 25 joins simultâneos entram todos', async () => {
        const results = await Promise.allSettled(Array.from({ length: 25 }, async (_, i) => store.join(room, `p${i}`)));
        expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(25);
      });

      describe('com limite opcional (maxPeers)', () => {
        let limited: RoomStore;
        beforeEach(async () => {
          limited = await make(() => now, { maxPeers: 8 });
        });

        it('lança RoomFullError no 9º participante', async () => {
          for (let i = 0; i < 8; i++) await limited.join(room, `p${i}`);
          await rejects(() => limited.join(room, 'extra')).toThrow(RoomFullError);
        });

        it('com joins simultâneos entram exatamente 8 e o resto recebe RoomFullError', async () => {
          const results = await Promise.allSettled(
            Array.from({ length: 12 }, async (_, i) => limited.join(room, `p${i}`)),
          );
          const ok = results.filter((r) => r.status === 'fulfilled');
          const full = results.filter((r) => r.status === 'rejected' && r.reason instanceof RoomFullError);
          expect(ok).toHaveLength(8);
          expect(full).toHaveLength(4);
        });

        it('quem expirou libera a vaga', async () => {
          const first = await limited.join(room, 'p0');
          for (let i = 1; i < 8; i++) await limited.join(room, `p${i}`);
          await rejects(() => limited.join(room, 'extra')).toThrow(RoomFullError);
          now += PEER_TTL_MS + 1;
          // ninguém consultou: todos expiraram, e a sala aceita de novo
          const again = await limited.join(room, 'extra');
          expect(again.participants.map((p) => p.id)).not.toContain(first.peerId);
        });
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

    describe('peekEvents (leitura sem batimento)', () => {
      it('devolve o mesmo que events(): filtra por cursor, destinatário e remetente', async () => {
        const a = await store.join(room, 'Ana');
        const b = await store.join(room, 'Beto');
        const c = await store.join(room, 'Cris');
        await store.chat(room, a.peerId, 'oi');
        await store.signal(room, a.peerId, b.peerId, offer);
        const viaPeek = await store.peekEvents(room, b.peerId, b.cursor);
        const viaEvents = await store.events(room, b.peerId, b.cursor);
        expect(viaPeek).toEqual(viaEvents);
        expect(viaPeek.events.map((e) => e.type)).toEqual(['join', 'chat', 'signal']);
        // o sinal de Ana para Beto não aparece para Cris
        expect((await store.peekEvents(room, c.peerId, c.cursor)).events.some((e) => e.type === 'signal')).toBe(false);
      });

      it('não devolve ao remetente os próprios broadcasts', async () => {
        const a = await store.join(room, 'Ana');
        await store.join(room, 'Beto');
        await store.chat(room, a.peerId, 'oi');
        const { events } = await store.peekEvents(room, a.peerId, a.cursor);
        expect(events.some((e) => e.type === 'chat')).toBe(false);
      });

      it('lança UnknownPeerError para peer inexistente, id malformado e peer expirado', async () => {
        const a = await store.join(room, 'Ana');
        await rejects(() => store.peekEvents(room, 'fantasma', 0)).toThrow(UnknownPeerError);
        await rejects(() => store.peekEvents(room, `${a.peerId}.tokenHash`, 0)).toThrow(UnknownPeerError);
        await rejects(() => store.peekEvents('sala-que-nao-existe', a.peerId, 0)).toThrow(UnknownPeerError);
        now += PEER_TTL_MS + 1;
        await rejects(() => store.peekEvents(room, a.peerId, 0)).toThrow(UnknownPeerError);
      });

      it('NÃO renova o lastSeen: quem só faz peek expira, quem faz events() continua vivo', async () => {
        const a = await store.join(room, 'Ana');
        const b = await store.join(room, 'Beto');
        // Ana renova com events(); Beto só espia, sem nunca renovar
        for (let i = 0; i < 4; i++) {
          now += 6_000;
          await store.events(room, a.peerId, a.cursor);
          await (async () => store.peekEvents(room, b.peerId, b.cursor))().catch(() => undefined);
        }
        // 24 s depois do join: Beto (só peek) passou de 15 s sem batimento e foi varrido
        const { events } = await store.events(room, a.peerId, a.cursor);
        expect(events.some((e) => e.type === 'leave' && e.from === b.peerId)).toBe(true);
        await rejects(() => store.events(room, b.peerId, 0)).toThrow(UnknownPeerError);
        await store.authenticate(room, a.peerId, a.token);
      });

      it('não escreve nada: o cursor e o log ficam como estavam', async () => {
        const a = await store.join(room, 'Ana');
        await store.join(room, 'Beto');
        const before = await store.peekEvents(room, a.peerId, 0);
        const again = await store.peekEvents(room, a.peerId, 0);
        expect(again).toEqual(before);
        expect(again.cursor).toBe(before.cursor);
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

    describe('screenSlots (várias telas)', () => {
      it('join zera: sharing false e screenSlots 0, para quem entra e para quem já estava', async () => {
        const a = await store.join(room, 'Ana');
        expect(a.participants.find((p) => p.id === a.peerId)).toMatchObject({ sharing: false, screenSlots: 0 });
        const b = await store.join(room, 'Beto');
        expect(b.participants.map((p) => [p.sharing, p.screenSlots])).toEqual([[false, 0], [false, 0]]);
      });

      it('setState com screenSlots guarda a máscara, deriva sharing e o evento state carrega os dois', async () => {
        const a = await store.join(room, 'Ana');
        const b = await store.join(room, 'Beto');
        await store.setState(room, a.peerId, { audio: true, video: true, sharing: false, screenSlots: 5 });
        const { events } = await store.events(room, b.peerId, b.cursor);
        expect(events.find((e) => e.type === 'state')?.payload).toEqual({ audio: true, video: true, sharing: true, screenSlots: 5 });
        const me = (await store.join(room, 'Cris')).participants.find((p) => p.id === a.peerId);
        expect(me).toMatchObject({ sharing: true, screenSlots: 5 });
      });

      it('só sharing: true vira screenSlots 1, e false volta a 0', async () => {
        const a = await store.join(room, 'Ana');
        await store.setState(room, a.peerId, { audio: true, video: true, sharing: true });
        let me = (await store.join(room, 'Beto')).participants.find((p) => p.id === a.peerId);
        expect(me).toMatchObject({ sharing: true, screenSlots: 1 });
        await store.setState(room, a.peerId, { audio: true, video: true, sharing: false });
        me = (await store.join(room, 'Cris')).participants.find((p) => p.id === a.peerId);
        expect(me).toMatchObject({ sharing: false, screenSlots: 0 });
      });

      it('screenSlots manda sobre sharing inconsistente; inválido cai em sharing', async () => {
        const a = await store.join(room, 'Ana');
        await store.setState(room, a.peerId, { audio: true, video: true, sharing: true, screenSlots: 0 });
        let me = (await store.join(room, 'Beto')).participants.find((p) => p.id === a.peerId);
        expect(me).toMatchObject({ sharing: false, screenSlots: 0 });
        await store.setState(room, a.peerId, { audio: true, video: true, sharing: true, screenSlots: 99 });
        me = (await store.join(room, 'Cris')).participants.find((p) => p.id === a.peerId);
        expect(me).toMatchObject({ sharing: true, screenSlots: 1 });
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

      it('uma enxurrada de sinais não apaga entradas, saídas e estados de quem demorou a consultar', async () => {
        // Ana entra primeiro e só consulta depois que os outros já negociaram: sinais (ICE) lotam o log
        const a = await store.join(room, 'Ana');
        const b = await store.join(room, 'Beto');
        const c = await store.join(room, 'Cris');
        await store.setState(room, b.peerId, { audio: false, video: true, sharing: false });
        for (let i = 0; i < MAX_EVENTS + 300; i++) {
          await store.signal(room, b.peerId, c.peerId, { gen: 0, kind: 'candidate', sid: 1, candidate: { candidate: `c${i}` } });
        }
        await store.leave(room, c.peerId);

        const { events } = await store.events(room, a.peerId, a.cursor);
        const controle = events.filter((e) => e.type !== 'signal').map((e) => `${e.type}:${e.from}`);
        expect(controle).toEqual([
          `join:${b.peerId}`,
          `join:${c.peerId}`,
          `state:${b.peerId}`,
          `leave:${c.peerId}`,
        ]);
        // e o log continua limitado
        expect((await store.events(room, b.peerId, 0)).events.length).toBeLessThanOrEqual(MAX_EVENTS);
      });

      it('ao estourar o limite os sinais MAIS VELHOS saem primeiro: o mais novo continua entregável', async () => {
        const b = await store.join(room, 'Beto');
        const c = await store.join(room, 'Cris');
        for (let i = 0; i < MAX_EVENTS + 100; i++) {
          await store.signal(room, b.peerId, c.peerId, { gen: 0, kind: 'candidate', sid: 1, candidate: { candidate: `c${i}` } });
        }
        const { events } = await store.events(room, c.peerId, 0);
        const sinais = events.filter((e) => e.type === 'signal');
        const ultimo = sinais[sinais.length - 1].payload as { candidate: { candidate: string } };
        expect(ultimo.candidate.candidate).toBe(`c${MAX_EVENTS + 99}`);
        expect(sinais.length).toBeGreaterThan(MAX_EVENTS - 5); // sobrou espaço para quase todos os sinais mais novos
        expect(events.length).toBeLessThanOrEqual(MAX_EVENTS);
        // seq continua crescente e sem repetição
        const seqs = events.map((e) => e.seq);
        expect(seqs).toEqual([...seqs].sort((x, y) => x - y));
        expect(new Set(seqs).size).toBe(seqs.length);
      });
    });

    describe('preview da sala (tela inicial)', () => {
      it('sala inexistente ou vazia = 0 pessoas e aberta', async () => {
        expect(await store.roomPreview(room)).toEqual({ count: 0, closed: false, protected: false });
      });

      it('conta 1, 2 e 3 pessoas', async () => {
        await store.join(room, 'Ana');
        expect((await store.roomPreview(room)).count).toBe(1);
        await store.join(room, 'Beto');
        expect((await store.roomPreview(room)).count).toBe(2);
        await store.join(room, 'Cris');
        expect((await store.roomPreview(room)).count).toBe(3);
      });

      it('quem sai deixa de contar', async () => {
        const a = await store.join(room, 'Ana');
        await store.join(room, 'Beto');
        await store.leave(room, a.peerId);
        expect((await store.roomPreview(room)).count).toBe(1);
      });

      it('NÃO conta o observador (o administrador)', async () => {
        await store.join(room, 'Ana');
        await store.join(room, 'Administração', { observer: true });
        expect((await store.roomPreview(room)).count).toBe(1);
      });

      it('só leitura: peer expirado pelo TTL deixa de contar SEM nenhuma escrita (sem varredura, sem leave, sem renovar lastSeen)', async () => {
        const a = await store.join(room, 'Ana');
        const b = await store.join(room, 'Beto');
        now += 10_000;
        await store.events(room, b.peerId, 0); // Beto renova; a Ana tem 10 s de silêncio (viva)
        now += 10_000; // Ana: 20 s sem consultar (expirada); Beto: 10 s (vivo)
        expect((await store.roomPreview(room)).count).toBe(1);

        // a Ana continua expirada no armazenamento: a preview NÃO a varreu nem emitiu o leave dela
        const visto = await store.peekEvents(room, b.peerId, 0);
        expect(visto.events.some((e) => e.type === 'leave' && e.from === a.peerId)).toBe(false);

        // e a preview não renova ninguém: Beto, que estava a 10 s, passa do TTL depois de mais 6 s mesmo com preview no meio
        await store.roomPreview(room);
        now += 6_000;
        expect((await store.roomPreview(room)).count).toBe(0);
        await rejects(() => store.peekEvents(room, b.peerId, 0)).toThrow(UnknownPeerError);
      });

      it('sala fechada pelo admin: closed true (e 0 pessoas); reaberta volta a false', async () => {
        await store.join(room, 'Ana');
        await store.closeRoom(room, 'manutenção');
        expect(await store.roomPreview(room)).toEqual({ count: 0, closed: true, protected: false });
        await store.reopenRoom(room);
        expect(await store.roomPreview(room)).toEqual({ count: 0, closed: false, protected: false });
      });

      it('o resultado tem EXATAMENTE count, closed e protected: nada de nomes, ids, ips ou tokens', async () => {
        const w = { ip: '203.0.113.77', deviceId: randomUUID() };
        const a = await store.join(room, 'Fulana Secreta', w);
        const preview = await store.roomPreview(room);
        expect(Object.keys(preview).sort()).toEqual(['closed', 'count', 'protected']);
        expect(preview.protected).toBe(false); // o sistema de senha ainda não existe
        const texto = JSON.stringify(preview);
        for (const segredo of ['Fulana Secreta', a.peerId, a.token, w.ip, w.deviceId]) expect(texto).not.toContain(segredo);
      });

      it('nome de sala com caracteres especiais é só um nome: não vira consulta nem erro', async () => {
        for (const nome of ['$where', 'a.b', '{"$ne":1}', 'peers.x', '../x']) {
          expect(await store.roomPreview(nome)).toEqual({ count: 0, closed: false, protected: false });
        }
      });
    });

    describe('administração', () => {
      const uid = () => randomUUID();
      /** IP e dispositivo únicos por teste: no Mongo o banco é compartilhado entre os testes. */
      const who = () => ({ ip: `10.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`, deviceId: uid() });
      const types = (events: { type: string }[]) => events.map((e) => e.type);

      describe('ip, dispositivo e observador no join', () => {
        it('ip e deviceId ficam só no que o admin vê: nunca em participants nem em eventos', async () => {
          const w = who();
          const a = await store.join(room, 'Ana', w);
          const b = await store.join(room, 'Beto');
          expect(JSON.stringify(b.participants)).not.toContain(w.ip);
          expect(JSON.stringify(b.participants)).not.toContain(w.deviceId);
          const { events } = await store.events(room, b.peerId, 0);
          expect(JSON.stringify(events)).not.toContain(w.ip);
          expect(JSON.stringify(events)).not.toContain(w.deviceId);
          const detail = await store.getRoom(room);
          const ana = detail!.peers.find((p) => p.id === a.peerId)!;
          expect(ana).toMatchObject({ name: 'Ana', ip: w.ip, deviceId: w.deviceId, observer: false });
          expect(detail!.peers.find((p) => p.id === b.peerId)).toMatchObject({ ip: null, deviceId: null });
        });

        it('um deviceId que não é UUID é ignorado (nunca vira dado do admin)', async () => {
          const a = await store.join(room, 'Ana', { ip: '10.9.9.9', deviceId: '$where; drop' });
          const detail = await store.getRoom(room);
          expect(detail!.peers.find((p) => p.id === a.peerId)!.deviceId).toBeNull();
        });

        it('o observador aparece como observer:true para os outros, mas não conta como participante', async () => {
          const a = await store.join(room, 'Ana');
          const obs = await store.join(room, 'admin', { observer: true });
          const { events } = await store.events(room, a.peerId, a.cursor);
          const join = events.find((e) => e.type === 'join')!;
          expect(join.payload).toMatchObject({ id: obs.peerId, observer: true });
          expect(obs.participants.find((p) => p.id === a.peerId)!.observer).toBeUndefined();
          expect(obs.participants.find((p) => p.id === obs.peerId)!.observer).toBe(true);
          const detail = await store.getRoom(room);
          expect(detail).toMatchObject({ peerCount: 1, observerCount: 1 });
          expect(detail!.peers.find((p) => p.id === obs.peerId)!.observer).toBe(true);
          const sala = (await store.listRooms()).find((r) => r.name === room)!;
          expect(sala).toMatchObject({ peerCount: 1, observerCount: 1, closed: false });
        });

        it('o observador não conta para o limite opcional de pessoas', async () => {
          const limited = await make(() => now, { maxPeers: 2 });
          await limited.join(room, 'admin', { observer: true });
          await limited.join(room, 'a');
          await limited.join(room, 'b');
          await rejects(() => limited.join(room, 'c')).toThrow(RoomFullError);
          await limited.join(room, 'admin2', { observer: true }); // observador entra mesmo com a sala cheia
        });
      });

      describe('banimento por IP e por dispositivo', () => {
        it('banPeer bane IP e dispositivo, expulsa a pessoa e bloqueia o próximo join de qualquer um dos dois', async () => {
          const w = who();
          const a = await store.join(room, 'Ana', w);
          const r = await store.banPeer(room, a.peerId, 'spam');
          expect(r!.removed).toBe(1);
          expect(r!.bans.map((b) => b.kind).sort()).toEqual(['device', 'ip']);
          expect(r!.bans.every((b) => b.reason === 'spam' && b.bannedName === 'Ana' && b.room === room)).toBe(true);
          expect(r!.bans.find((b) => b.kind === 'ip')!.value).toBe(w.ip);
          expect(r!.bans.find((b) => b.kind === 'device')!.value).toBe(w.deviceId);

          await rejects(() => store.join(room, 'Ana de novo', w)).toThrow(BannedError);
          await rejects(() => store.join(room, 'outra sala', { ip: w.ip })).toThrow(BannedError); // só o IP
          await rejects(() => store.join(room, 'outro ip', { ip: '10.250.250.250', deviceId: w.deviceId })).toThrow(BannedError); // só o dispositivo
          await store.join(room, 'Beto', who()); // outro IP e outro dispositivo entram
          const lista = await store.listBans();
          for (const b of r!.bans) expect(lista.map((x) => x.id)).toContain(b.id);
        });

        it('o peer banido é removido com tombstone "banned", em QUALQUER sala em que o IP ou o dispositivo apareça', async () => {
          const w = who();
          const outraSala = `${room}-b`;
          const a1 = await store.join(room, 'Ana', w);
          const a2 = await store.join(outraSala, 'Ana2', { ip: w.ip, deviceId: uid() }); // mesmo IP, outra sala e outro dispositivo
          const r = await store.ban({ ip: w.ip, reason: 'abuso' });
          expect(r.removed).toBe(2);
          expect(r.bans).toHaveLength(1);
          await rejects(() => store.authenticate(room, a1.peerId, a1.token)).toThrow(UnknownPeerError);
          const err = await Promise.resolve()
            .then(() => store.authenticate(outraSala, a2.peerId, a2.token))
            .catch((e: unknown) => e);
          expect(err).toBeInstanceOf(UnknownPeerError);
          expect((err as UnknownPeerError).reason).toBe('banned');
        });

        it('ban só por dispositivo e só por IP', async () => {
          const w = who();
          const so = await store.ban({ deviceId: w.deviceId });
          expect(so.bans.map((b) => b.kind)).toEqual(['device']);
          await rejects(() => store.join(room, 'x', { deviceId: w.deviceId })).toThrow(BannedError);
          await store.join(room, 'y', { ip: w.ip }); // o IP não foi banido
          const w2 = who();
          const ip = await store.ban({ ip: w2.ip, reason: 'r' });
          expect(ip.bans.map((b) => b.kind)).toEqual(['ip']);
          await rejects(() => store.join(room, 'z', w2)).toThrow(BannedError);
        });

        it('IP "unknown", vazio ou ausente e dispositivo inválido NUNCA viram ban (não pode banir todo mundo)', async () => {
          const before = (await store.listBans()).length;
          expect((await store.ban({ ip: 'unknown' })).bans).toEqual([]);
          expect((await store.ban({ ip: '' })).bans).toEqual([]);
          expect((await store.ban({ ip: '   ' })).bans).toEqual([]);
          expect((await store.ban({ deviceId: 'nao-e-uuid' })).bans).toEqual([]);
          expect((await store.ban({})).bans).toEqual([]);
          expect((await store.listBans()).length).toBe(before);
          // e um peer sem IP conhecido: banPeer só cria o ban de dispositivo
          const w = who();
          const a = await store.join(room, 'Ana', { ip: 'unknown', deviceId: w.deviceId });
          const r = await store.banPeer(room, a.peerId);
          expect(r!.bans.map((b) => b.kind)).toEqual(['device']);
          await store.join(room, 'Beto', { ip: 'unknown' }); // quem está sem IP continua entrando
        });

        it('banir duas vezes o mesmo valor é idempotente (mesmo id, uma entrada)', async () => {
          const w = who();
          const r1 = await store.ban({ ip: w.ip, reason: 'a' });
          const r2 = await store.ban({ ip: w.ip, reason: 'b' });
          expect(r2.bans[0].id).toBe(r1.bans[0].id);
          expect((await store.listBans()).filter((b) => b.value === w.ip)).toHaveLength(1);
        });

        it('o observador (o admin) ignora o banimento e não é removido por ele', async () => {
          const w = who();
          await store.ban({ ip: w.ip });
          const obs = await store.join(room, 'admin', { ...w, observer: true });
          const r = await store.ban({ ip: w.ip });
          expect(r.removed).toBe(0);
          await expect(Promise.resolve(store.authenticate(room, obs.peerId, obs.token))).resolves.toBeUndefined();
        });

        it('unban libera o próximo join; unban de id inexistente é false; banPeer de peer inexistente é null', async () => {
          const w = who();
          const r = await store.ban({ ip: w.ip });
          await rejects(() => store.join(room, 'x', { ip: w.ip })).toThrow(BannedError);
          expect(await store.unban(r.bans[0].id)).toBe(true);
          await store.join(room, 'x', { ip: w.ip });
          expect(await store.unban(r.bans[0].id)).toBe(false);
          expect(await store.unban('nao-existe')).toBe(false);
          expect(await store.banPeer(room, uid())).toBeNull();
          expect(await store.banPeer('sala-que-nao-existe', uid())).toBeNull();
        });
      });

      describe('expulsar (kick)', () => {
        it('remove a pessoa, avisa os outros com leave e a pessoa recebe 410 com reason "kicked"', async () => {
          const a = await store.join(room, 'Ana');
          const b = await store.join(room, 'Beto');
          expect(await store.kick(room, b.peerId, 'spam')).toBe(true);
          const { events } = await store.events(room, a.peerId, a.cursor);
          expect(events.filter((e) => e.type === 'leave').map((e) => e.from)).toEqual([b.peerId]);
          const err = await Promise.resolve()
            .then(() => store.authenticate(room, b.peerId, b.token))
            .catch((e: unknown) => e);
          expect(err).toBeInstanceOf(UnknownPeerError);
          expect((err as UnknownPeerError).reason).toBe('kicked');
          // events/peekEvents/chat do removido também carregam o motivo
          const viaEvents = await Promise.resolve().then(() => store.events(room, b.peerId, 0)).catch((e: unknown) => e);
          expect((viaEvents as UnknownPeerError).reason).toBe('kicked');
          const viaPeek = await Promise.resolve().then(() => store.peekEvents(room, b.peerId, 0)).catch((e: unknown) => e);
          expect((viaPeek as UnknownPeerError).reason).toBe('kicked');
          const viaChat = await Promise.resolve().then(() => store.chat(room, b.peerId, 'oi')).catch((e: unknown) => e);
          expect((viaChat as UnknownPeerError).reason).toBe('kicked');
          // quem foi expulso pode entrar de novo (kick não é ban)
          await store.join(room, 'Beto', who());
        });

        it('o motivo só aparece para quem prova ser o peer (token certo): terceiros não descobrem quem foi expulso', async () => {
          const a = await store.join(room, 'Ana');
          const b = await store.join(room, 'Beto');
          await store.kick(room, b.peerId);
          const errado = await Promise.resolve().then(() => store.authenticate(room, b.peerId, a.token)).catch((e: unknown) => e);
          expect(errado).toBeInstanceOf(UnknownPeerError);
          expect((errado as UnknownPeerError).reason).toBeUndefined();
        });

        it('o tombstone expira em ~2 min: depois é um 410 comum, sem reason', async () => {
          const b = await store.join(room, 'Beto');
          await store.kick(room, b.peerId);
          now += 60_000;
          expect(((await Promise.resolve().then(() => store.authenticate(room, b.peerId, b.token)).catch((e: unknown) => e)) as UnknownPeerError).reason).toBe('kicked');
          now += 70_000;
          const depois = await Promise.resolve().then(() => store.authenticate(room, b.peerId, b.token)).catch((e: unknown) => e);
          expect(depois).toBeInstanceOf(UnknownPeerError);
          expect((depois as UnknownPeerError).reason).toBeUndefined();
        });

        it('expulsar quem não existe (ou id inválido) é false; peer que só expirou por TTL não deixa reason', async () => {
          expect(await store.kick(room, uid())).toBe(false);
          expect(await store.kick(room, '$where')).toBe(false);
          const b = await store.join(room, 'Beto');
          now += PEER_TTL_MS + 1000;
          await store.join(room, 'Ana'); // varre o Beto
          const err = await Promise.resolve().then(() => store.authenticate(room, b.peerId, b.token)).catch((e: unknown) => e);
          expect(err).toBeInstanceOf(UnknownPeerError);
          expect((err as UnknownPeerError).reason).toBeUndefined();
        });
      });

      describe('fechar e reabrir a sala', () => {
        it('closeRoom remove todos (reason "closed"), persiste fechada, bloqueia join comum e deixa o observador entrar', async () => {
          const a = await store.join(room, 'Ana');
          await store.join(room, 'Beto');
          const obs = await store.join(room, 'admin', { observer: true });
          expect(await store.closeRoom(room, 'manutenção')).toBe(2); // só os participantes (o observador não conta)
          const err = await Promise.resolve().then(() => store.authenticate(room, a.peerId, a.token)).catch((e: unknown) => e);
          expect((err as UnknownPeerError).reason).toBe('closed');
          const bloqueado = await Promise.resolve().then(() => store.join(room, 'Cris')).catch((e: unknown) => e);
          expect(bloqueado).toBeInstanceOf(RoomClosedError);
          expect((bloqueado as RoomClosedError).reason).toBe('manutenção');
          // o observador também foi removido da sala fechada
          const errObs = await Promise.resolve().then(() => store.authenticate(room, obs.peerId, obs.token)).catch((e: unknown) => e);
          expect((errObs as UnknownPeerError).reason).toBe('closed');
          await store.join(room, 'admin', { observer: true }); // mas um observador novo pode entrar
          const sala = (await store.listRooms()).find((r) => r.name === room)!;
          expect(sala).toMatchObject({ closed: true, closedReason: 'manutenção', peerCount: 0 });
          expect((await store.getRoom(room))!.closed).toBe(true);
        });

        it('a sala fechada persiste (sem o TTL de 1 h das salas) até reopenRoom; reabrir devolve true uma vez só', async () => {
          await store.join(room, 'Ana');
          await store.closeRoom(room);
          now += 24 * 3_600_000;
          await rejects(() => store.join(room, 'Beto')).toThrow(RoomClosedError);
          expect(await store.reopenRoom(room)).toBe(true);
          expect(await store.reopenRoom(room)).toBe(false);
          const b = await store.join(room, 'Beto');
          expect(b.participants).toHaveLength(1);
          expect((await store.getRoom(room))!.closed).toBe(false);
        });

        it('fechar uma sala que não existe a deixa fechada (bloqueio preventivo)', async () => {
          expect(await store.closeRoom(room, 'preventivo')).toBe(0);
          await rejects(() => store.join(room, 'Ana')).toThrow(RoomClosedError);
          expect((await store.listRooms()).find((r) => r.name === room)).toMatchObject({ closed: true, peerCount: 0 });
        });

        it('getRoom de sala inexistente e aberta é null', async () => {
          expect(await store.getRoom(`${room}-nada`)).toBeNull();
        });
      });

      describe('mensagem do admin e comandos', () => {
        it('broadcast entrega um evento admin "message" (from "admin") só a quem não é observador e devolve quantos alcançou', async () => {
          const a = await store.join(room, 'Ana');
          const b = await store.join(room, 'Beto');
          const obs = await store.join(room, 'admin', { observer: true });
          expect(await store.broadcast(room, 'Atenção: manutenção em 5 min')).toBe(2);
          for (const p of [a, b]) {
            const { events } = await store.events(room, p.peerId, p.cursor);
            const adm = events.filter((e) => e.type === 'admin');
            expect(adm).toHaveLength(1);
            expect(adm[0]).toMatchObject({ from: 'admin', payload: { kind: 'message', text: 'Atenção: manutenção em 5 min' } });
            expect(adm[0].to).toBeUndefined();
            expect(typeof (adm[0].payload as { at: number }).at).toBe('number');
          }
          const { events } = await store.events(room, obs.peerId, obs.cursor);
          expect(events.filter((e) => e.type === 'admin')).toEqual([]);
        });

        it('broadcast com texto vazio ou para sala inexistente alcança 0; com room null alcança todas as salas', async () => {
          const a = await store.join(room, 'Ana');
          const outra = `${room}-c`;
          const c = await store.join(outra, 'Cris');
          expect(await store.broadcast(room, '   ')).toBe(0);
          expect(await store.broadcast(`${room}-nada`, 'oi')).toBe(0);
          expect(await store.broadcast(null, 'a todas')).toBeGreaterThanOrEqual(2);
          expect(types((await store.events(room, a.peerId, a.cursor)).events)).toContain('admin');
          expect(types((await store.events(outra, c.peerId, c.cursor)).events)).toContain('admin');
        });

        it('o texto do broadcast é dado, nunca expressão (começa com $, parece caminho de campo)', async () => {
          const a = await store.join(room, 'Ana');
          await store.broadcast(room, '$peers.x.tokenHash');
          const { events } = await store.events(room, a.peerId, a.cursor);
          expect((events.find((e) => e.type === 'admin')!.payload as { text: string }).text).toBe('$peers.x.tokenHash');
        });

        it('command vai só ao peer escolhido (campo `to`), com o comando e o slot', async () => {
          const a = await store.join(room, 'Ana');
          const b = await store.join(room, 'Beto');
          expect(await store.command(room, b.peerId, { what: 'screen', slot: 1 })).toBe(true);
          expect(await store.command(room, b.peerId, { what: 'camera' })).toBe(true);
          const doBeto = (await store.events(room, b.peerId, b.cursor)).events.filter((e) => e.type === 'admin');
          expect(doBeto.map((e) => e.payload)).toMatchObject([
            { kind: 'command', what: 'screen', slot: 1 },
            { kind: 'command', what: 'camera' },
          ]);
          expect(doBeto.every((e) => e.from === 'admin' && e.to === b.peerId)).toBe(true);
          expect((await store.events(room, a.peerId, a.cursor)).events.filter((e) => e.type === 'admin')).toEqual([]);
        });

        it('command para peer inexistente ou comando inválido é false e não gera evento', async () => {
          const b = await store.join(room, 'Beto');
          expect(await store.command(room, uid(), { what: 'all' })).toBe(false);
          expect(await store.command(room, '$where', { what: 'all' })).toBe(false);
          expect(await store.command(room, b.peerId, { what: 'rm -rf' as never })).toBe(false);
          expect(await store.command(room, b.peerId, { what: 'screen', slot: 7 })).toBe(false);
          expect(await store.command(room, b.peerId, { what: 'screen', slot: -1 })).toBe(false);
          expect(await store.command(room, b.peerId, { what: 'screen', slot: 1.5 })).toBe(false);
          expect((await store.events(room, b.peerId, b.cursor)).events.filter((e) => e.type === 'admin')).toEqual([]);
        });

        it('eventos admin são de controle: uma enxurrada de sinais não os apaga', async () => {
          const a = await store.join(room, 'Ana');
          const b = await store.join(room, 'Beto');
          await store.broadcast(room, 'importante');
          for (let i = 0; i < MAX_EVENTS + 200; i++) {
            await store.signal(room, b.peerId, a.peerId, { gen: 0, kind: 'candidate', sid: 1, candidate: { candidate: `c${i}` } });
          }
          const { events } = await store.events(room, a.peerId, a.cursor);
          expect(events.filter((e) => e.type === 'admin').map((e) => (e.payload as { text: string }).text)).toEqual(['importante']);
        });
      });

      describe('um participante comum nunca forja um evento de admin', () => {
        it('chat, setState e signal de clientes comuns não geram type "admin" nem from "admin"', async () => {
          const a = await store.join(room, 'admin'); // o nome "admin" é só um nome
          const b = await store.join(room, 'Beto');
          await store.chat(room, a.peerId, '{"kind":"command","what":"all"}');
          await store.chat(room, b.peerId, 'admin');
          await store.setState(room, a.peerId, { audio: false, video: false, sharing: false });
          await store.signal(room, a.peerId, b.peerId, offer);
          const todos = [...(await store.events(room, a.peerId, 0)).events, ...(await store.events(room, b.peerId, 0)).events];
          expect(todos.some((e) => e.type === 'admin')).toBe(false);
          expect(todos.some((e) => e.from === 'admin')).toBe(false);
        });

        it('"admin" não é um peerId válido: nem consulta nem sinaliza nem fala', async () => {
          await store.join(room, 'Ana');
          await rejects(() => store.events(room, 'admin', 0)).toThrow(UnknownPeerError);
          await rejects(() => store.chat(room, 'admin', 'oi')).toThrow(UnknownPeerError);
          await rejects(() => store.signal(room, 'admin', 'x', offer)).toThrow(UnknownPeerError);
          await rejects(() => store.setState(room, 'admin', { audio: true, video: true, sharing: false })).toThrow(UnknownPeerError);
        });
      });

      describe('listRooms e getRoom', () => {
        it('listam as salas com contagens e atividade, e o detalhe traz os peers com estado', async () => {
          const a = await store.join(room, 'Ana', who());
          await store.setState(room, a.peerId, { audio: false, video: true, sharing: true, screenSlots: 0b101 });
          const sala = (await store.listRooms()).find((r) => r.name === room)!;
          expect(sala).toMatchObject({ name: room, peerCount: 1, observerCount: 0, closed: false });
          expect(typeof sala.createdAt).toBe('number');
          expect(typeof sala.lastActivity).toBe('number');
          const detail = await store.getRoom(room);
          expect(detail!.peers).toHaveLength(1);
          expect(detail!.peers[0]).toMatchObject({ id: a.peerId, name: 'Ana', audio: false, video: true, sharing: true, screenSlots: 0b101 });
          expect(typeof detail!.peers[0].joinedAt).toBe('number');
          expect(typeof detail!.peers[0].lastSeen).toBe('number');
        });

        it('o token nunca aparece no que o admin lê', async () => {
          const a = await store.join(room, 'Ana', who());
          const detail = await store.getRoom(room);
          expect(JSON.stringify(detail)).not.toContain(a.token);
          expect(JSON.stringify(await store.listRooms())).not.toContain(a.token);
          expect(JSON.stringify(detail)).not.toContain('tokenHash');
        });

        it('peer expirado por TTL não conta no que o admin vê', async () => {
          const a = await store.join(room, 'Ana');
          now += PEER_TTL_MS + 1000;
          expect((await store.getRoom(room))?.peers.find((p) => p.id === a.peerId)).toBeUndefined();
          expect((await store.listRooms()).find((r) => r.name === room)?.peerCount ?? 0).toBe(0);
        });
      });
    });

    describe('senha da sala', () => {
      const DAY = 24 * 60 * 60_000;
      /** Registro de mentira: o store só guarda, quem hasheia e confere é a rota. */
      const record = (tag = 'A'): PasswordRecord => ({
        salt: Buffer.from(`SAL-${tag}-SECRETO`).toString('base64'),
        hash: Buffer.from(`HASH-${tag}-SECRETO`).toString('base64'),
        params: { N: 16384, r: 8, p: 1, keylen: 64 },
      });

      describe('anfitrião', () => {
        it('é o participante mais antigo; só ele define a senha, os outros recebem not_host e nada muda', async () => {
          const a = await store.join(room, 'Ana');
          now += 1000;
          const b = await store.join(room, 'Beto');
          expect(await store.isRoomHost(room, a.peerId)).toBe(true);
          expect(await store.isRoomHost(room, b.peerId)).toBe(false);
          expect(await store.setRoomPassword(room, b.peerId, record())).toBe('not_host');
          expect(await store.getRoomPassword(room)).toBeNull();
          expect(await store.setRoomPassword(room, a.peerId, record())).toBe('ok');
          expect(await store.getRoomPassword(room)).toEqual(record());
        });

        it('quando o anfitrião sai, o título passa à pessoa seguinte', async () => {
          const a = await store.join(room, 'Ana');
          now += 1000;
          const b = await store.join(room, 'Beto');
          now += 1000;
          const c = await store.join(room, 'Cris');
          await store.leave(room, a.peerId);
          expect(await store.isRoomHost(room, b.peerId)).toBe(true);
          expect(await store.isRoomHost(room, c.peerId)).toBe(false);
          expect(await store.isRoomHost(room, a.peerId)).toBe(false);
        });

        it('empate no instante de entrada: o menor peerId é o anfitrião (todo mundo concorda)', async () => {
          const a = await store.join(room, 'Ana');
          const b = await store.join(room, 'Beto'); // mesmo `now`
          const menor = a.peerId < b.peerId ? a.peerId : b.peerId;
          const outro = menor === a.peerId ? b.peerId : a.peerId;
          expect(await store.isRoomHost(room, menor)).toBe(true);
          expect(await store.isRoomHost(room, outro)).toBe(false);
        });

        it('observador (admin) nunca é anfitrião, mesmo tendo entrado primeiro, e não consegue definir senha', async () => {
          const obs = await store.join(room, 'admin', { observer: true });
          now += 1000;
          const a = await store.join(room, 'Ana');
          expect(await store.isRoomHost(room, obs.peerId)).toBe(false);
          expect(await store.isRoomHost(room, a.peerId)).toBe(true);
          expect(await store.setRoomPassword(room, obs.peerId, record())).toBe('not_host');
        });

        it('quem expirou por TTL deixa de ser anfitrião', async () => {
          const a = await store.join(room, 'Ana');
          now += 1000;
          const b = await store.join(room, 'Beto');
          now += PEER_TTL_MS - 500; // Ana está a 15,5 s sem consultar (passou do TTL); Beto, a 14,5 s
          await store.events(room, b.peerId, 0); // Beto renova
          now += 1000;
          expect(await store.isRoomHost(room, a.peerId)).toBe(false);
          expect(await store.isRoomHost(room, b.peerId)).toBe(true);
        });

        it('peer desconhecido: isRoomHost false e setRoomPassword unknown_peer', async () => {
          await store.join(room, 'Ana');
          expect(await store.isRoomHost(room, randomUUID())).toBe(false);
          expect(await store.setRoomPassword(room, randomUUID(), record())).toBe('unknown_peer');
          expect(await store.setRoomPassword(`${room}-vazia`, randomUUID(), record())).toBe('unknown_peer');
          expect(await store.getRoomPassword(room)).toBeNull();
        });
      });

      describe('registro de senha', () => {
        it('remover (null) apaga; sala sem senha devolve null', async () => {
          const a = await store.join(room, 'Ana');
          expect(await store.getRoomPassword(room)).toBeNull();
          await store.setRoomPassword(room, a.peerId, record());
          expect(await store.setRoomPassword(room, a.peerId, null)).toBe('ok');
          expect(await store.getRoomPassword(room)).toBeNull();
        });

        it('trocar a senha substitui o registro', async () => {
          const a = await store.join(room, 'Ana');
          await store.setRoomPassword(room, a.peerId, record('A'));
          await store.setRoomPassword(room, a.peerId, record('B'));
          expect(await store.getRoomPassword(room)).toEqual(record('B'));
        });

        it('sobrevive à sala ficar vazia (recarregar a página do único participante não abre a sala)', async () => {
          const a = await store.join(room, 'Ana');
          await store.setRoomPassword(room, a.peerId, record());
          await store.leave(room, a.peerId);
          expect(await store.getRoomPassword(room)).toEqual(record());
          expect(await store.roomPreview(room)).toEqual({ count: 0, closed: false, protected: true });
        });

        it('expira 24 h depois do último uso; entrar com sucesso renova', async () => {
          const a = await store.join(room, 'Ana');
          await store.setRoomPassword(room, a.peerId, record());
          await store.leave(room, a.peerId);
          now += DAY - 60_000;
          expect(await store.getRoomPassword(room)).toEqual(record());
          await store.passwordSucceeded(room, 'ip-1'); // renova: de novo 24 h
          now += DAY - 60_000;
          expect(await store.getRoomPassword(room)).toEqual(record());
          now += 120_000; // 24 h + 1 min sem uso
          expect(await store.getRoomPassword(room)).toBeNull();
          expect((await store.roomPreview(room)).protected).toBe(false);
        });

        it('passwordSucceeded numa sala sem senha não cria nada', async () => {
          await store.passwordSucceeded(room, 'ip-1');
          expect(await store.getRoomPassword(room)).toBeNull();
        });

        it('salas diferentes não se misturam', async () => {
          const a = await store.join(room, 'Ana');
          const outra = `${room}-outra`;
          const o = await store.join(outra, 'Otávio');
          await store.setRoomPassword(room, a.peerId, record('A'));
          expect(await store.getRoomPassword(outra)).toBeNull();
          await store.setRoomPassword(outra, o.peerId, record('O'));
          expect(await store.getRoomPassword(room)).toEqual(record('A'));
          expect(await store.getRoomPassword(outra)).toEqual(record('O'));
        });

        it('a preview diz protected true com senha e false depois de remover, sem trocar mais nada', async () => {
          const a = await store.join(room, 'Ana');
          expect(await store.roomPreview(room)).toEqual({ count: 1, closed: false, protected: false });
          await store.setRoomPassword(room, a.peerId, record());
          expect(await store.roomPreview(room)).toEqual({ count: 1, closed: false, protected: true });
          await store.setRoomPassword(room, a.peerId, null);
          expect(await store.roomPreview(room)).toEqual({ count: 1, closed: false, protected: false });
        });

        it('a senha só vale para novas entradas: quem já estava continua autenticado e recebendo eventos', async () => {
          const a = await store.join(room, 'Ana');
          const b = await store.join(room, 'Beto');
          const host = a.peerId < b.peerId ? a : b;
          const outro = host === a ? b : a;
          await store.setRoomPassword(room, host.peerId, record());
          await expect((async () => store.authenticate(room, outro.peerId, outro.token))()).resolves.toBeUndefined();
          await expect((async () => store.events(room, outro.peerId, 0))()).resolves.toBeDefined();
        });
      });

      describe('evento room', () => {
        it('vai a todos os não observadores (menos a quem definiu), com { protected }; ao remover, protected false', async () => {
          const a = await store.join(room, 'Ana');
          const b = await store.join(room, 'Beto');
          const obs = await store.join(room, 'admin', { observer: true });
          const host = a.peerId < b.peerId ? a : b;
          const outro = host === a ? b : a;
          await store.setRoomPassword(room, host.peerId, record());
          await store.setRoomPassword(room, host.peerId, null);

          const recebido = (await store.events(room, outro.peerId, 0)).events.filter((e) => e.type === 'room');
          expect(recebido.map((e) => [e.from, e.payload])).toEqual([
            [host.peerId, { protected: true }],
            [host.peerId, { protected: false }],
          ]);
          expect((await store.events(room, host.peerId, 0)).events.some((e) => e.type === 'room')).toBe(false);
          expect((await store.events(room, obs.peerId, 0)).events.some((e) => e.type === 'room')).toBe(false);
        });

        it('quem não é anfitrião não gera evento', async () => {
          const a = await store.join(room, 'Ana');
          now += 1000;
          const b = await store.join(room, 'Beto');
          await store.setRoomPassword(room, b.peerId, record());
          expect((await store.events(room, a.peerId, 0)).events.some((e) => e.type === 'room')).toBe(false);
        });
      });

      describe('segredos', () => {
        it('hash e salt nunca aparecem em participants, eventos, preview nem no que o admin lê', async () => {
          const a = await store.join(room, 'Ana');
          const b = await store.join(room, 'Beto');
          const host = a.peerId < b.peerId ? a : b;
          const outro = host === a ? b : a;
          const r = record('X');
          await store.setRoomPassword(room, host.peerId, r);
          const entrou = await store.join(room, 'Cris');
          const tudo = JSON.stringify([
            entrou.participants,
            (await store.events(room, outro.peerId, 0)).events,
            await store.roomPreview(room),
            await store.listRooms(),
            await store.getRoom(room),
          ]);
          for (const segredo of [r.hash, r.salt, 'SECRETO', 'HASH-X']) expect(tudo).not.toContain(segredo);
        });

        it('o admin vê só se a sala é protegida (passwordProtected), em listRooms e em getRoom', async () => {
          const a = await store.join(room, 'Ana');
          expect((await store.listRooms()).find((s) => s.name === room)!.passwordProtected).toBe(false);
          expect((await store.getRoom(room))!.passwordProtected).toBe(false);
          await store.setRoomPassword(room, a.peerId, record());
          expect((await store.listRooms()).find((s) => s.name === room)!.passwordProtected).toBe(true);
          expect((await store.getRoom(room))!.passwordProtected).toBe(true);
          await store.setRoomPassword(room, a.peerId, null);
          expect((await store.getRoom(room))!.passwordProtected).toBe(false);
        });

        it('sala fechada pelo admin continua mostrando se tem senha', async () => {
          const a = await store.join(room, 'Ana');
          await store.setRoomPassword(room, a.peerId, record());
          await store.closeRoom(room);
          expect((await store.getRoom(room))!.passwordProtected).toBe(true);
        });
      });

      describe('limite de tentativas', () => {
        it('consultar a trava não conta: sem erros nunca tranca', async () => {
          for (let i = 0; i < 20; i++) expect(await store.passwordThrottle(room, 'ip-1')).toEqual({ locked: false, retryAfterMs: 0 });
        });

        it('5 erros do mesmo IP trancam por 5 min; outro IP segue livre; destranca com o tempo', async () => {
          for (let i = 0; i < 4; i++) expect((await store.passwordFailed(room, 'ip-1')).locked).toBe(false);
          const quinto = await store.passwordFailed(room, 'ip-1');
          expect(quinto.locked).toBe(true);
          expect(quinto.retryAfterMs).toBeGreaterThan(0);
          expect(quinto.retryAfterMs).toBeLessThanOrEqual(5 * 60_000);
          expect((await store.passwordThrottle(room, 'ip-1')).locked).toBe(true);
          expect((await store.passwordThrottle(room, 'ip-2')).locked).toBe(false);
          now += 4 * 60_000;
          const ainda = await store.passwordThrottle(room, 'ip-1');
          expect(ainda.locked).toBe(true);
          expect(ainda.retryAfterMs).toBeLessThanOrEqual(60_000);
          now += 61_000;
          expect(await store.passwordThrottle(room, 'ip-1')).toEqual({ locked: false, retryAfterMs: 0 });
          // depois de destravar, o contador recomeça do zero (um erro só não tranca de novo)
          expect((await store.passwordFailed(room, 'ip-1')).locked).toBe(false);
        });

        it('acertar zera o contador do IP', async () => {
          for (let i = 0; i < 4; i++) await store.passwordFailed(room, 'ip-1');
          await store.passwordSucceeded(room, 'ip-1');
          for (let i = 0; i < 4; i++) expect((await store.passwordFailed(room, 'ip-1')).locked).toBe(false);
        });

        it('erros antigos (fora da janela de 10 min) deixam de contar', async () => {
          for (let i = 0; i < 4; i++) await store.passwordFailed(room, 'ip-1');
          now += 10 * 60_000 + 1000;
          for (let i = 0; i < 4; i++) expect((await store.passwordFailed(room, 'ip-1')).locked).toBe(false);
        });

        it('50 erros na sala (de IPs diferentes) trancam todo mundo por 1 min', async () => {
          for (let i = 0; i < 49; i++) expect((await store.passwordFailed(room, `ip-${i}`)).locked).toBe(false);
          expect((await store.passwordFailed(room, 'ip-49')).locked).toBe(true);
          const novo = await store.passwordThrottle(room, 'ip-novo');
          expect(novo.locked).toBe(true);
          expect(novo.retryAfterMs).toBeGreaterThan(0);
          expect(novo.retryAfterMs).toBeLessThanOrEqual(60_000);
          now += 61_000;
          expect((await store.passwordThrottle(room, 'ip-novo')).locked).toBe(false);
        });

        it('a trava é por sala: outra sala com o mesmo IP segue livre', async () => {
          for (let i = 0; i < 5; i++) await store.passwordFailed(room, 'ip-1');
          expect((await store.passwordThrottle(room, 'ip-1')).locked).toBe(true);
          expect((await store.passwordThrottle(`${room}-outra`, 'ip-1')).locked).toBe(false);
        });

        it('chave estranha (símbolos de operador, vazia, enorme) é só um texto', async () => {
          for (const k of ['$ne', 'a.b', '{"$gt":""}', '', 'x'.repeat(500)]) {
            expect((await store.passwordFailed(room, k)).locked).toBe(false);
            expect((await store.passwordThrottle(room, k)).locked).toBe(false);
          }
        });
      });
    });
  });
}
