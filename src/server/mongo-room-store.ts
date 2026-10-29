import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { MongoServerError, type Collection, type Document, type Filter } from 'mongodb';
import type { PeerInfo, PeerMediaState, RoomEvent, RoomEventType, SignalData } from '@/lib/types';
import { resolveMediaState } from '@/lib/validation';
import {
  MAX_EVENTS,
  PEER_TTL_MS,
  RoomFullError,
  UnknownPeerError,
  type RoomStore,
  type RoomStoreOptions,
} from './room-store';

type PeerDoc = {
  name: string;
  joinedAt: number;
  lastSeen: number;
  audio: boolean;
  video: boolean;
  sharing: boolean;
  /** ausente em salas gravadas antes das várias telas: vale `sharing ? 1 : 0` */
  screenSlots?: number;
  tokenHash: string;
};

type EventDoc = RoomEvent & { at: number };

/** Uma sala = um documento. Toda operação é um único update atômico dele. */
export type RoomDoc = {
  _id: string;
  seq: number;
  gen: number;
  peers: Record<string, PeerDoc>;
  events: EventDoc[];
  updatedAt: Date;
};

/** Eventos mais velhos que isto saem do log mesmo antes de chegar a MAX_EVENTS (limita o tamanho do documento). */
const EVENT_MAX_AGE_MS = 5 * 60_000;
/** Sala sem nenhuma escrita por esse tempo é apagada pelo índice TTL. */
const ROOM_IDLE_SECONDS = 3600;

/**
 * Todo id vindo do cliente entra em caminhos como `peers.<id>.lastSeen`. Só UUID passa: um ponto ou um
 * `$` deixaria o cliente apontar para outros campos do documento (por exemplo, `<id>.tokenHash`).
 */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const hashToken = (token: string) => createHash('sha256').update(token).digest('hex');

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const isDuplicateKey = (e: unknown) => e instanceof MongoServerError && e.code === 11000;

const peerInfo = (id: string, p: PeerDoc): PeerInfo => ({
  id,
  name: p.name,
  joinedAt: p.joinedAt,
  audio: p.audio,
  video: p.video,
  sharing: p.sharing,
  screenSlots: p.screenSlots ?? (p.sharing ? 1 : 0),
});

/** Nº de peers vivos (lastSeen ≥ limit) dentro de um update/filtro. */
const aliveCountExpr = (limit: number) => ({
  $size: {
    $filter: {
      input: { $objectToArray: { $ifNull: ['$peers', {}] } },
      cond: { $gte: ['$$this.v.lastSeen', limit] },
    },
  },
});

/**
 * Estágios que acrescentam um evento ao log: incrementam `seq` e anexam o evento com o novo `seq`, tudo no
 * mesmo update. `payload` é uma EXPRESSÃO de agregação: dado do usuário tem que vir dentro de `$literal`,
 * senão um texto começando com `$` seria lido como caminho de campo do documento.
 */
function emitStages(type: RoomEventType, from: string, payload: Document, to: string | undefined, now: number): Document[] {
  return [
    { $set: { seq: { $add: [{ $ifNull: ['$seq', 0] }, 1] } } },
    // 1) acrescenta o evento (já sem os mais velhos que EVENT_MAX_AGE_MS)
    {
      $set: {
        events: {
          $concatArrays: [
            {
              $filter: {
                input: { $ifNull: ['$events', []] },
                cond: { $gte: ['$$this.at', now - EVENT_MAX_AGE_MS] },
              },
            },
            [{ seq: '$seq', type, from, ...(to ? { to } : {}), payload, at: now }],
          ],
        },
      },
    },
    // 2) acima de MAX_EVENTS saem PRIMEIRO os sinais (SDP/ICE) mais velhos: são efêmeros e numerosos, e cortar uma
    //    entrada/saída/estado faria quem demorou a consultar nunca mais ver aquela pessoa. O $reduce percorre o log em
    //    ordem e descarta os primeiros `drop` sinais; o resto (controle e sinais mais novos) fica como está.
    {
      $set: {
        events: {
          $let: {
            vars: { excess: { $max: [0, { $subtract: [{ $size: '$events' }, MAX_EVENTS] }] } },
            in: {
              $getField: {
                field: 'out',
                input: {
                  $reduce: {
                    input: '$events',
                    initialValue: { out: [], drop: '$$excess' },
                    in: {
                      $cond: [
                        { $and: [{ $gt: ['$$value.drop', 0] }, { $eq: ['$$this.type', 'signal'] }] },
                        { out: '$$value.out', drop: { $subtract: ['$$value.drop', 1] } },
                        { out: { $concatArrays: ['$$value.out', ['$$this']] }, drop: '$$value.drop' },
                      ],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
    // 3) sem sinais suficientes para descartar, corta os mais antigos de qualquer tipo
    { $set: { events: { $slice: ['$events', -MAX_EVENTS] } } },
    { $set: { updatedAt: '$$NOW' } },
  ];
}

const literal = (value: unknown): Document => ({ $literal: value });

export class MongoRoomStore implements RoomStore {
  constructor(
    private rooms: Collection<RoomDoc>,
    private now: () => number = Date.now,
    private opts: RoomStoreOptions = {},
  ) {}

  /** Índice TTL que apaga salas abandonadas. Idempotente; chame uma vez ao criar o store. */
  async ensureIndexes() {
    await this.rooms.createIndex({ updatedAt: 1 }, { expireAfterSeconds: ROOM_IDLE_SECONDS });
  }

  async join(room: string, name: string) {
    await this.sweep(room);
    const peerId = randomUUID();
    const token = randomUUID();
    const t = this.now();
    const limit = t - PEER_TTL_MS;
    const info: PeerInfo = { id: peerId, name, joinedAt: t, audio: true, video: true, sharing: false, screenSlots: 0 };

    // O MongoDB não aceita `$expr` no filtro de um upsert, então são dois passos: garante a sala e depois
    // entra num update comum. Com limite (opcional), esse update também checa a lotação (atômico, vale entre
    // instâncias); sem limite, não há checagem nenhuma.
    const maxPeers = this.opts.maxPeers;
    for (let attempt = 0; attempt < 5; attempt++) {
      await this.ensureRoom(room);
      const doc = await this.rooms.findOneAndUpdate(
        (maxPeers === undefined ? { _id: room } : { _id: room, $expr: { $lt: [aliveCountExpr(limit), maxPeers] } }) as Filter<RoomDoc>,
        [
          {
            $set: {
              [`peers.${peerId}`]: {
                name: literal(name),
                joinedAt: t,
                lastSeen: t,
                audio: true,
                video: true,
                sharing: false,
                screenSlots: 0,
                tokenHash: hashToken(token),
              },
            },
          },
          ...emitStages('join', peerId, literal(info), undefined, t),
        ],
        { returnDocument: 'after' },
      );
      if (doc) {
        const participants = Object.entries(doc.peers)
          .filter(([, p]) => p.lastSeen >= limit)
          .map(([id, p]) => peerInfo(id, p));
        return { peerId, token, participants, cursor: doc.seq, gen: doc.gen };
      }
      // Não casou: ou a sala está cheia (só com limite), ou foi apagada entre os dois passos (aí tenta de novo).
      if (maxPeers === undefined) continue;
      const current = await this.rooms.findOne({ _id: room }, { projection: { peers: 1 } });
      const alive = Object.values(current?.peers ?? {}).filter((p) => p.lastSeen >= limit).length;
      if (current && alive >= maxPeers) throw new RoomFullError();
    }
    throw new Error('join_contention');
  }

  async authenticate(room: string, peerId: string, token: string) {
    if (!UUID.test(peerId)) throw new UnknownPeerError();
    const doc = await this.rooms.findOne({ _id: room }, { projection: { [`peers.${peerId}`]: 1 } });
    const peer = doc?.peers?.[peerId];
    if (!peer || peer.lastSeen < this.now() - PEER_TTL_MS || !sameHash(peer.tokenHash, hashToken(token))) {
      throw new UnknownPeerError();
    }
  }

  async events(room: string, peerId: string, since: number) {
    if (!UUID.test(peerId)) throw new UnknownPeerError();
    const t = this.now();
    const limit = t - PEER_TTL_MS;
    let doc = await this.rooms.findOneAndUpdate(
      { _id: room, [`peers.${peerId}.lastSeen`]: { $gte: limit } } as Filter<RoomDoc>,
      { $set: { [`peers.${peerId}.lastSeen`]: t } },
      { returnDocument: 'after', projection: { seq: 1, events: 1, peers: 1 } },
    );
    if (!doc) throw new UnknownPeerError();

    const expired = Object.entries(doc.peers).filter(([, p]) => p.lastSeen < limit);
    if (expired.length > 0) {
      for (const [id] of expired) await this.removePeer(room, id, limit);
      // os eventos de saída acabaram de ser gravados: lê de novo para entregá-los já nesta resposta
      doc = (await this.rooms.findOne({ _id: room }, { projection: { seq: 1, events: 1 } })) ?? doc;
    }

    const events: RoomEvent[] = doc.events
      .filter((e) => e.seq > since && e.from !== peerId && (e.to === undefined || e.to === peerId))
      .map(({ at: _at, ...event }) => event);
    return { events, cursor: doc.seq };
  }

  /** Só leitura (um `findOne` com projeção mínima): não renova `lastSeen`, não escreve, não varre. */
  async peekEvents(room: string, peerId: string, since: number) {
    if (!UUID.test(peerId)) throw new UnknownPeerError();
    const doc = await this.rooms.findOne(
      { _id: room },
      { projection: { seq: 1, events: 1, [`peers.${peerId}.lastSeen`]: 1 } },
    );
    const peer = doc?.peers?.[peerId];
    if (!doc || !peer || peer.lastSeen < this.now() - PEER_TTL_MS) throw new UnknownPeerError();
    const events: RoomEvent[] = doc.events
      .filter((e) => e.seq > since && e.from !== peerId && (e.to === undefined || e.to === peerId))
      .map(({ at: _at, ...event }) => event);
    return { events, cursor: doc.seq };
  }

  async signal(room: string, from: string, to: string, data: SignalData) {
    if (!UUID.test(from)) throw new UnknownPeerError();
    const t = this.now();
    const limit = t - PEER_TTL_MS;
    if (UUID.test(to)) {
      const doc = await this.rooms.findOneAndUpdate(
        {
          _id: room,
          [`peers.${from}.lastSeen`]: { $gte: limit },
          [`peers.${to}.lastSeen`]: { $gte: limit },
          // Cliente legítimo nunca está à frente da sala; aceitar deixaria alguém arrastar todos para um gen enorme.
          gen: { $gte: data.gen },
        } as Filter<RoomDoc>,
        [
          { $set: { [`peers.${from}.lastSeen`]: t } },
          ...emitStages('signal', from, literal(data), to, t),
        ],
        { projection: { _id: 1 } },
      );
      if (doc) return;
    }
    // Não entregou (destino ausente ou gen à frente): só confirma que o remetente é válido.
    await this.touch(room, from, t);
  }

  async chat(room: string, from: string, text: string) {
    if (!UUID.test(from)) throw new UnknownPeerError();
    const t = this.now();
    const doc = await this.rooms.findOneAndUpdate(
      { _id: room, [`peers.${from}.lastSeen`]: { $gte: t - PEER_TTL_MS } } as Filter<RoomDoc>,
      [
        { $set: { [`peers.${from}.lastSeen`]: t } },
        ...emitStages(
          'chat',
          from,
          { id: randomUUID(), name: `$peers.${from}.name`, text: literal(text), at: t },
          undefined,
          t,
        ),
      ],
      { projection: { _id: 1 } },
    );
    if (!doc) throw new UnknownPeerError();
  }

  async setState(room: string, from: string, state: PeerMediaState) {
    if (!UUID.test(from)) throw new UnknownPeerError();
    const t = this.now();
    const next = resolveMediaState(state);
    const doc = await this.rooms.findOneAndUpdate(
      { _id: room, [`peers.${from}.lastSeen`]: { $gte: t - PEER_TTL_MS } } as Filter<RoomDoc>,
      [
        {
          $set: {
            [`peers.${from}.lastSeen`]: t,
            [`peers.${from}.audio`]: next.audio,
            [`peers.${from}.video`]: next.video,
            [`peers.${from}.sharing`]: next.sharing,
            [`peers.${from}.screenSlots`]: next.screenSlots,
          },
        },
        ...emitStages('state', from, literal(next), undefined, t),
      ],
      { projection: { _id: 1 } },
    );
    if (!doc) throw new UnknownPeerError();
  }

  async restart(room: string, from: string) {
    if (!UUID.test(from)) throw new UnknownPeerError();
    const t = this.now();
    const doc = await this.rooms.findOneAndUpdate(
      { _id: room, [`peers.${from}.lastSeen`]: { $gte: t - PEER_TTL_MS } } as Filter<RoomDoc>,
      [
        { $set: { [`peers.${from}.lastSeen`]: t, gen: { $add: [{ $ifNull: ['$gen', 0] }, 1] } } },
        ...emitStages('restart', from, { gen: '$gen' }, undefined, t),
      ],
      { returnDocument: 'after', projection: { gen: 1 } },
    );
    if (!doc) throw new UnknownPeerError();
    return doc.gen;
  }

  async leave(room: string, peerId: string) {
    if (!UUID.test(peerId)) return;
    await this.removePeer(room, peerId);
  }

  /** Cria a sala vazia se ainda não existir. Duas criações simultâneas: a que perde a corrida só ignora. */
  private async ensureRoom(room: string) {
    try {
      await this.rooms.updateOne(
        { _id: room },
        { $setOnInsert: { seq: 0, gen: 0, peers: {}, events: [], updatedAt: new Date() } },
        { upsert: true },
      );
    } catch (e) {
      if (!isDuplicateKey(e)) throw e;
    }
  }

  /** Confirma que o peer está vivo e o conta como ativo. */
  private async touch(room: string, peerId: string, t: number) {
    const doc = await this.rooms.findOneAndUpdate(
      { _id: room, [`peers.${peerId}.lastSeen`]: { $gte: t - PEER_TTL_MS } } as Filter<RoomDoc>,
      { $set: { [`peers.${peerId}.lastSeen`]: t } },
      { projection: { _id: 1 } },
    );
    if (!doc) throw new UnknownPeerError();
  }

  /**
   * Remove o peer e avisa os outros. Com `expiredBefore`, só remove se ele ainda estiver expirado:
   * assim, duas instâncias varrendo ao mesmo tempo, ou um poll que chega no último instante, não se atropelam.
   */
  private async removePeer(room: string, peerId: string, expiredBefore?: number) {
    const t = this.now();
    const filter: Document = { _id: room, [`peers.${peerId}`]: { $exists: true } };
    if (expiredBefore !== undefined) filter[`peers.${peerId}.lastSeen`] = { $lt: expiredBefore };
    const doc = await this.rooms.findOneAndUpdate(
      filter as Filter<RoomDoc>,
      [{ $unset: `peers.${peerId}` }, ...emitStages('leave', peerId, literal({}), undefined, t)],
      { returnDocument: 'after', projection: { peers: 1 } },
    );
    // Sala vazia some (e uma nova começa com gen 0). Condicional: se alguém entrou entretanto, não apaga.
    if (doc && Object.keys(doc.peers).length === 0) await this.rooms.deleteOne({ _id: room, peers: {} } as Filter<RoomDoc>);
  }

  /** Remove da sala os peers expirados (quem para de consultar por mais de PEER_TTL_MS). */
  private async sweep(room: string) {
    const doc = await this.rooms.findOne({ _id: room }, { projection: { peers: 1 } });
    if (!doc) return;
    const limit = this.now() - PEER_TTL_MS;
    for (const [id, peer] of Object.entries(doc.peers)) {
      if (peer.lastSeen < limit) await this.removePeer(room, id, limit);
    }
  }
}
