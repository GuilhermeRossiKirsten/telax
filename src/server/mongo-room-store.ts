import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { MongoServerError, type Collection, type Db, type Document, type Filter } from 'mongodb';
import type {
  AdminCommand,
  AdminPeer,
  AdminRoomDetail,
  AdminRoomSummary,
  Ban,
  JoinContext,
  RemovalReason,
} from '@/lib/admin-types';
import type { PeerInfo, PeerMediaState, RoomEvent, RoomEventType, SignalData } from '@/lib/types';
import { resolveMediaState } from '@/lib/validation';
import type { PasswordParams, PasswordRecord } from './room-password';
import {
  BannedError,
  MAX_EVENTS,
  PASSWORD_ATTEMPT_WINDOW_MS,
  PASSWORD_KEY_LIMIT,
  PASSWORD_KEY_LOCK_MS,
  PASSWORD_ROOM_LIMIT,
  PASSWORD_ROOM_LOCK_MS,
  PASSWORD_TTL_MS,
  PEER_TTL_MS,
  RoomClosedError,
  RoomFullError,
  type PasswordThrottle,
  type RoomPreview,
  type SetPasswordResult,
  TOMBSTONE_MS,
  UnknownPeerError,
  banId,
  cleanCommand,
  cleanIp,
  cleanMessage,
  cleanReason,
  cleanThrottleKey,
  isUuid,
  pickHost,
  type BanEntry,
  type BanResult,
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
  /** só o admin lê: nunca vão em PeerInfo nem em eventos */
  ip?: string;
  deviceId?: string;
  /** o admin observando a sala: não conta como participante nem para o limite */
  observer?: boolean;
};

/** `audience: 'peers'`: o evento só vai a quem NÃO é observador. */
type EventDoc = RoomEvent & { at: number; audience?: 'peers' };

/** Uma sala = um documento. Toda operação é um único update atômico dele. */
export type RoomDoc = {
  _id: string;
  seq: number;
  gen: number;
  peers: Record<string, PeerDoc>;
  events: EventDoc[];
  updatedAt: Date;
  /** ausente em salas anteriores ao painel de admin */
  createdAt?: number;
};

/** Sala fechada pelo admin: coleção própria, SEM o TTL de 1 h das salas (fica fechada até reabrir). */
export type ClosedDoc = { _id: string; reason?: string; at: number };
export type BanDoc = { _id: string; kind: Ban['kind']; value: string; reason: string; createdAt: number; bannedName?: string; room?: string };
/** Tombstone de quem o admin removeu: `at` (Date) alimenta o índice TTL; `atMs` é o relógio do store (e dos testes). */
export type RemovedDoc = {
  _id: string;
  room: string;
  peerId: string;
  reason: RemovalReason;
  detail?: string;
  tokenHash: string;
  atMs: number;
  at: Date;
};

/**
 * Senha da sala (`_id` = nome da sala): só sal + derivação scrypt, nunca o texto. SEM o TTL de 1 h das salas, porque
 * precisa sobreviver à sala ficar vazia. `expiresAtMs` (relógio do store) é o que vale na leitura; `expireAt` (Date) só
 * alimenta o índice TTL que limpa os registros esquecidos.
 */
export type PasswordDoc = { _id: string; salt: string; hash: string; params: PasswordParams; expiresAtMs: number; expireAt: Date };
/** Erros de senha de uma chave (`_id` = sala + IP, ou a sala toda). `lockedUntil` 0 = livre. */
export type AttemptDoc = { _id: string; count: number; windowStart: number; lockedUntil: number; expireAt: Date };

export type AdminCollections = {
  closed: Collection<ClosedDoc>;
  bans: Collection<BanDoc>;
  removed: Collection<RemovedDoc>;
  passwords: Collection<PasswordDoc>;
  attempts: Collection<AttemptDoc>;
};
export const adminCollections = (db: Db): AdminCollections => ({
  closed: db.collection<ClosedDoc>('admin_closed'),
  bans: db.collection<BanDoc>('admin_bans'),
  removed: db.collection<RemovedDoc>('admin_removed'),
  passwords: db.collection<PasswordDoc>('room_passwords'),
  attempts: db.collection<AttemptDoc>('room_password_attempts'),
});

export type MongoStoreOptions = RoomStoreOptions & { admin?: AdminCollections };
/** Os tombstones somem do banco depois disto (a janela em que ainda valem é TOMBSTONE_MS). */
const TOMBSTONE_TTL_SECONDS = 300;

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
  ...(p.observer ? { observer: true } : {}),
});

/** Eventos que esta pessoa pode ler: depois do cursor, não dela, endereçados a ela ou a todos (e sem os só-para-participantes se ela é observadora). */
function visibleEvents(events: EventDoc[], peerId: string, since: number, observer: boolean): RoomEvent[] {
  const out: RoomEvent[] = [];
  for (const { at: _at, audience, ...event } of events) {
    if (event.seq <= since || event.from === peerId || (event.to !== undefined && event.to !== peerId)) continue;
    if (audience === 'peers' && observer) continue;
    out.push(event);
  }
  return out;
}

/** Nº de PARTICIPANTES vivos (lastSeen ≥ limit, sem observadores) dentro de um update/filtro. */
const aliveCountExpr = (limit: number) => ({
  $size: {
    $filter: {
      input: { $objectToArray: { $ifNull: ['$peers', {}] } },
      cond: { $and: [{ $gte: ['$$this.v.lastSeen', limit] }, { $ne: ['$$this.v.observer', true] }] },
    },
  },
});

/**
 * Estágios que acrescentam um evento ao log: incrementam `seq` e anexam o evento com o novo `seq`, tudo no
 * mesmo update. `payload` é uma EXPRESSÃO de agregação: dado do usuário tem que vir dentro de `$literal`,
 * senão um texto começando com `$` seria lido como caminho de campo do documento.
 */
function emitStages(
  type: RoomEventType,
  from: string,
  payload: Document,
  to: string | undefined,
  now: number,
  audience?: 'peers',
): Document[] {
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
            [{ seq: '$seq', type, from, ...(to ? { to } : {}), ...(audience ? { audience } : {}), payload, at: now }],
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
    private opts: MongoStoreOptions = {},
  ) {}

  /** As coleções de administração; sem elas (só em testes antigos) os recursos de admin não existem. */
  private get adm(): AdminCollections {
    if (!this.opts.admin) throw new Error('admin_collections_missing');
    return this.opts.admin;
  }

  /** Índices TTL: salas abandonadas (1 h) e tombstones do admin (5 min). Idempotente; chame uma vez ao criar o store. */
  async ensureIndexes() {
    await this.rooms.createIndex({ updatedAt: 1 }, { expireAfterSeconds: ROOM_IDLE_SECONDS });
    if (this.opts.admin) {
      await this.opts.admin.removed.createIndex({ at: 1 }, { expireAfterSeconds: TOMBSTONE_TTL_SECONDS });
      // senhas esquecidas (24 h depois do último uso) e contadores de tentativas velhos: `expireAt` já é a hora de sumir
      await this.opts.admin.passwords.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
      await this.opts.admin.attempts.createIndex({ expireAt: 1 }, { expireAfterSeconds: 0 });
    }
  }

  async join(room: string, name: string, ctx?: JoinContext) {
    const observer = ctx?.observer === true;
    const ip = cleanIp(ctx?.ip);
    const deviceId = isUuid(ctx?.deviceId) ? ctx.deviceId : undefined;
    // banimento e sala fechada valem para participantes; o observador (o admin) pula as duas checagens
    if (!observer && this.opts.admin) {
      const ids = [ip && banId('ip', ip), deviceId && banId('device', deviceId)].filter((v): v is string => !!v);
      if (ids.length > 0 && (await this.opts.admin.bans.findOne({ _id: { $in: ids } }))) throw new BannedError();
      const closed = await this.opts.admin.closed.findOne({ _id: room });
      if (closed) throw new RoomClosedError(closed.reason);
    }
    await this.sweep(room);
    const peerId = randomUUID();
    const token = randomUUID();
    const t = this.now();
    const limit = t - PEER_TTL_MS;
    const info: PeerInfo = {
      id: peerId,
      name,
      joinedAt: t,
      audio: true,
      video: true,
      sharing: false,
      screenSlots: 0,
      ...(observer ? { observer: true } : {}),
    };

    // O MongoDB não aceita `$expr` no filtro de um upsert, então são dois passos: garante a sala e depois
    // entra num update comum. Com limite (opcional), esse update também checa a lotação (atômico, vale entre
    // instâncias); sem limite, não há checagem nenhuma.
    const maxPeers = observer ? undefined : this.opts.maxPeers; // observador nunca conta para o limite
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
                ...(observer ? { observer: true } : {}),
                ...(ip ? { ip: literal(ip) } : {}),
                ...(deviceId ? { deviceId: literal(deviceId) } : {}),
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
      const alive = Object.values(current?.peers ?? {}).filter((p) => p.lastSeen >= limit && !p.observer).length;
      if (current && alive >= maxPeers) throw new RoomFullError();
    }
    throw new Error('join_contention');
  }

  async authenticate(room: string, peerId: string, token: string) {
    if (!UUID.test(peerId)) throw new UnknownPeerError();
    const doc = await this.rooms.findOne({ _id: room }, { projection: { [`peers.${peerId}`]: 1 } });
    const peer = doc?.peers?.[peerId];
    if (!peer || peer.lastSeen < this.now() - PEER_TTL_MS || !sameHash(peer.tokenHash, hashToken(token))) {
      throw await this.gone(room, peerId, token);
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
    if (!doc) throw await this.gone(room, peerId);
    const observer = doc.peers[peerId]?.observer === true;

    const expired = Object.entries(doc.peers).filter(([, p]) => p.lastSeen < limit);
    if (expired.length > 0) {
      for (const [id] of expired) await this.removePeer(room, id, limit);
      // os eventos de saída acabaram de ser gravados: lê de novo para entregá-los já nesta resposta
      doc = (await this.rooms.findOne({ _id: room }, { projection: { seq: 1, events: 1 } })) ?? doc;
    }

    return { events: visibleEvents(doc.events, peerId, since, observer), cursor: doc.seq };
  }

  /** Só leitura (um `findOne` com projeção mínima): não renova `lastSeen`, não escreve, não varre. */
  async peekEvents(room: string, peerId: string, since: number) {
    if (!UUID.test(peerId)) throw new UnknownPeerError();
    const doc = await this.rooms.findOne(
      { _id: room },
      { projection: { seq: 1, events: 1, [`peers.${peerId}.lastSeen`]: 1, [`peers.${peerId}.observer`]: 1 } },
    );
    const peer = doc?.peers?.[peerId];
    if (!doc || !peer || peer.lastSeen < this.now() - PEER_TTL_MS) throw await this.gone(room, peerId);
    return { events: visibleEvents(doc.events, peerId, since, peer.observer === true), cursor: doc.seq };
  }

  /**
   * Só leitura, um `findOne` com projeção: a CONTAGEM é calculada no banco (`$filter` sobre os peers vivos e não
   * observadores), então nada de nomes, tokens, ips nem eventos sai do banco. A sala é só um valor de igualdade em `_id`.
   */
  async roomPreview(room: string): Promise<RoomPreview> {
    const limit = this.now() - PEER_TTL_MS;
    const doc = (await this.rooms.findOne(
      { _id: room },
      {
        projection: {
          _id: 0,
          count: {
            $size: {
              $filter: {
                input: { $objectToArray: { $ifNull: ['$peers', {}] } },
                as: 'p',
                cond: { $and: [{ $gte: ['$$p.v.lastSeen', { $literal: limit }] }, { $ne: ['$$p.v.observer', true] }] },
              },
            },
          },
        },
      },
    )) as unknown as { count?: number } | null;
    const closed = this.opts.admin ? (await this.opts.admin.closed.findOne({ _id: room }, { projection: { _id: 1 } })) !== null : false;
    // só a existência do registro vivo (projeção de `_id`): o hash nunca sai do banco por aqui
    const isProtected = this.opts.admin
      ? (await this.opts.admin.passwords.findOne({ _id: room, expiresAtMs: { $gt: this.now() } }, { projection: { _id: 1 } })) !== null
      : false;
    return { count: typeof doc?.count === 'number' ? doc.count : 0, closed, protected: isProtected };
  }

  // ---- senha da sala ----

  /** Só o registro vivo: o TTL de 24 h é aplicado na leitura (o índice TTL do Mongo só limpa depois, sem hora certa). */
  async getRoomPassword(room: string): Promise<PasswordRecord | null> {
    if (!this.opts.admin) return null;
    const doc = await this.opts.admin.passwords.findOne({ _id: room, expiresAtMs: { $gt: this.now() } });
    return doc ? { salt: doc.salt, hash: doc.hash, params: doc.params } : null;
  }

  async setRoomPassword(room: string, peerId: string, record: PasswordRecord | null): Promise<SetPasswordResult> {
    if (!UUID.test(peerId)) return 'unknown_peer';
    const t = this.now();
    const limit = t - PEER_TTL_MS;
    const alive = await this.aliveForHost(room, limit);
    if (!alive.some((p) => p.id === peerId)) return 'unknown_peer';
    if (pickHost(alive) !== peerId) return 'not_host';
    if (record) {
      await this.adm.passwords.replaceOne(
        { _id: room },
        { salt: record.salt, hash: record.hash, params: record.params, expiresAtMs: t + PASSWORD_TTL_MS, expireAt: new Date(Date.now() + PASSWORD_TTL_MS) },
        { upsert: true },
      );
    } else {
      await this.adm.passwords.deleteOne({ _id: room });
    }
    // avisa quem está na sala (não o admin observador); o filtro garante que o peer ainda está vivo
    await this.rooms.findOneAndUpdate(
      { _id: room, [`peers.${peerId}.lastSeen`]: { $gte: limit } } as Filter<RoomDoc>,
      [
        { $set: { [`peers.${peerId}.lastSeen`]: t } },
        ...emitStages('room', peerId, literal({ protected: record !== null }), undefined, t, 'peers'),
      ],
      { projection: { _id: 1 } },
    );
    return 'ok';
  }

  async isRoomHost(room: string, peerId: string): Promise<boolean> {
    if (!UUID.test(peerId)) return false;
    return pickHost(await this.aliveForHost(room, this.now() - PEER_TTL_MS)) === peerId;
  }

  /** Quem está vivo na sala, no formato que `pickHost` usa (uma leitura só, com projeção mínima). */
  private async aliveForHost(room: string, limit: number) {
    const doc = await this.rooms.findOne({ _id: room }, { projection: { peers: 1 } });
    return Object.entries(doc?.peers ?? {})
      .filter(([, p]) => p.lastSeen >= limit)
      .map(([id, p]) => ({ id, joinedAt: p.joinedAt, observer: p.observer }));
  }

  async passwordThrottle(room: string, key: string): Promise<PasswordThrottle> {
    if (!this.opts.admin) return { locked: false, retryAfterMs: 0 };
    const t = this.now();
    const docs = await this.opts.admin.attempts.find({ _id: { $in: [this.keyAttemptId(room, key), this.roomAttemptId(room)] } }).toArray();
    const retry = Math.max(0, ...docs.map((d) => d.lockedUntil - t));
    return { locked: retry > 0, retryAfterMs: retry };
  }

  async passwordFailed(room: string, key: string): Promise<PasswordThrottle> {
    const t = this.now();
    const results = await Promise.all([
      this.bumpAttempts(this.keyAttemptId(room, key), PASSWORD_KEY_LIMIT, PASSWORD_KEY_LOCK_MS, t),
      this.bumpAttempts(this.roomAttemptId(room), PASSWORD_ROOM_LIMIT, PASSWORD_ROOM_LOCK_MS, t),
    ]);
    const retry = Math.max(...results);
    return { locked: retry > 0, retryAfterMs: retry };
  }

  async passwordSucceeded(room: string, key: string): Promise<void> {
    const t = this.now();
    await this.adm.attempts.deleteOne({ _id: this.keyAttemptId(room, key) });
    await this.adm.passwords.updateOne(
      { _id: room, expiresAtMs: { $gt: t } },
      { $set: { expiresAtMs: t + PASSWORD_TTL_MS, expireAt: new Date(Date.now() + PASSWORD_TTL_MS) } },
    );
  }

  // O tamanho do nome da sala vai na frente: nenhuma sala/chave consegue forjar o id de outra.
  private keyAttemptId = (room: string, key: string) => `${room.length}:${room}|k:${cleanThrottleKey(key)}`;
  private roomAttemptId = (room: string) => `${room.length}:${room}|r`;

  /**
   * Conta um erro num único update atômico (vale entre instâncias). Janela vencida ou trava já cumprida recomeçam do
   * zero; ao chegar em `limit` erros, tranca por `lockMs`. Devolve quanto falta para destrancar (0 = livre).
   */
  private async bumpAttempts(id: string, limit: number, lockMs: number, t: number): Promise<number> {
    const lockedUntil = { $ifNull: ['$lockedUntil', 0] };
    const pipeline: Document[] = [
      {
        $set: {
          stale: {
            $or: [
              { $eq: [{ $type: '$windowStart' }, 'missing'] },
              { $lte: [{ $add: ['$windowStart', PASSWORD_ATTEMPT_WINDOW_MS] }, t] },
              { $and: [{ $gt: [lockedUntil, 0] }, { $lte: [lockedUntil, t] }] },
            ],
          },
        },
      },
      {
        $set: {
          count: { $add: [{ $cond: ['$stale', 0, { $ifNull: ['$count', 0] }] }, 1] },
          windowStart: { $cond: ['$stale', t, '$windowStart'] },
          lockedUntil: { $cond: ['$stale', 0, lockedUntil] },
        },
      },
      {
        $set: {
          lockedUntil: { $cond: [{ $and: [{ $gte: ['$count', limit] }, { $lte: ['$lockedUntil', t] }] }, t + lockMs, '$lockedUntil'] },
          expireAt: new Date(Date.now() + PASSWORD_ATTEMPT_WINDOW_MS + lockMs),
        },
      },
      { $unset: 'stale' },
    ];
    for (let attempt = 0; ; attempt++) {
      try {
        const doc = await this.adm.attempts.findOneAndUpdate({ _id: id }, pipeline, { upsert: true, returnDocument: 'after' });
        return doc && doc.lockedUntil > t ? doc.lockedUntil - t : 0;
      } catch (e) {
        // dois primeiros erros do mesmo id ao mesmo tempo: um perde a corrida do upsert e só tenta de novo
        if (!isDuplicateKey(e) || attempt >= 3) throw e;
      }
    }
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
    if (!doc) throw await this.gone(room, from);
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
    if (!doc) throw await this.gone(room, from);
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
    if (!doc) throw await this.gone(room, from);
    return doc.gen;
  }

  async leave(room: string, peerId: string) {
    if (!UUID.test(peerId)) return;
    await this.removePeer(room, peerId);
  }

  // ---- administração ----

  async listRooms(): Promise<AdminRoomSummary[]> {
    const limit = this.now() - PEER_TTL_MS;
    const docs = await this.rooms.find({}, { projection: { peers: 1, createdAt: 1, updatedAt: 1 } }).toArray();
    const closedDocs = new Map((await this.adm.closed.find({}).toArray()).map((c) => [c._id, c]));
    const protectedRooms = new Set(
      (await this.adm.passwords.find({ expiresAtMs: { $gt: this.now() } }, { projection: { _id: 1 } }).toArray()).map((p) => p._id),
    );
    const out: AdminRoomSummary[] = [];
    for (const doc of docs) {
      const summary = this.summarize(doc._id, doc, closedDocs.get(doc._id), limit, protectedRooms.has(doc._id));
      // sala com todo mundo expirado e ainda não varrida: fantasma, não aparece
      if (summary.peerCount + summary.observerCount > 0 || summary.closed) out.push(summary);
      closedDocs.delete(doc._id);
    }
    for (const closed of closedDocs.values()) out.push(this.summarize(closed._id, undefined, closed, limit, protectedRooms.has(closed._id)));
    return out.sort((a, b) => b.lastActivity - a.lastActivity || a.name.localeCompare(b.name));
  }

  async getRoom(room: string): Promise<AdminRoomDetail | null> {
    const limit = this.now() - PEER_TTL_MS;
    const [doc, closed, password] = await Promise.all([
      this.rooms.findOne({ _id: room }),
      this.adm.closed.findOne({ _id: room }),
      this.getRoomPassword(room),
    ]);
    if (!doc && !closed) return null;
    const peers: AdminPeer[] = Object.entries(doc?.peers ?? {})
      .filter(([, p]) => p.lastSeen >= limit)
      .map(([id, p]) => ({
        id,
        name: p.name,
        joinedAt: p.joinedAt,
        lastSeen: p.lastSeen,
        audio: p.audio,
        video: p.video,
        sharing: p.sharing,
        screenSlots: p.screenSlots ?? (p.sharing ? 1 : 0),
        observer: p.observer === true,
        ip: p.ip ?? null,
        deviceId: p.deviceId ?? null,
      }));
    return { ...this.summarize(room, doc ?? undefined, closed ?? undefined, limit, password !== null), peers };
  }

  async kick(room: string, peerId: string, reason?: string) {
    if (!UUID.test(peerId)) return false;
    const peer = await this.findAlivePeer(room, peerId);
    if (!peer) return false;
    await this.tombstone(room, peerId, peer.tokenHash, 'kicked', cleanReason(reason) || undefined);
    return this.removePeer(room, peerId);
  }

  async closeRoom(room: string, reason?: string) {
    const why = cleanReason(reason) || undefined;
    const t = this.now();
    // marca fechada ANTES de remover: um join que chegue agora já é recusado
    await this.adm.closed.replaceOne({ _id: room }, { ...(why ? { reason: why } : {}), at: t }, { upsert: true });
    const doc = await this.rooms.findOne({ _id: room }, { projection: { peers: 1 } });
    if (!doc) return 0;
    const limit = t - PEER_TTL_MS;
    let removed = 0;
    const ops = Object.entries(doc.peers).map(([id, p]) => {
      if (!p.observer && p.lastSeen >= limit) removed += 1;
      return this.tombstoneOp(room, id, p.tokenHash, 'closed', why);
    });
    if (ops.length > 0) await this.adm.removed.bulkWrite(ops);
    await this.rooms.deleteOne({ _id: room });
    return removed;
  }

  async reopenRoom(room: string) {
    return (await this.adm.closed.deleteOne({ _id: room })).deletedCount > 0;
  }

  async broadcast(room: string | null, text: string) {
    const message = cleanMessage(text);
    if (!message) return 0;
    const names =
      room === null ? (await this.rooms.find({}, { projection: { _id: 1 } }).toArray()).map((d) => d._id) : [room];
    let reached = 0;
    for (const name of names) {
      const t = this.now();
      const doc = await this.rooms.findOne({ _id: name }, { projection: { peers: 1 } });
      const count = Object.values(doc?.peers ?? {}).filter((p) => p.lastSeen >= t - PEER_TTL_MS && !p.observer).length;
      if (!doc || count === 0) continue;
      await this.rooms.findOneAndUpdate(
        { _id: name },
        emitStages('admin', 'admin', literal({ kind: 'message', text: message, at: t }), undefined, t, 'peers'),
        { projection: { _id: 1 } },
      );
      reached += count;
    }
    return reached;
  }

  async command(room: string, peerId: string, cmd: AdminCommand) {
    const clean = cleanCommand(cmd);
    if (!clean || !UUID.test(peerId)) return false;
    const t = this.now();
    const doc = await this.rooms.findOneAndUpdate(
      { _id: room, [`peers.${peerId}.lastSeen`]: { $gte: t - PEER_TTL_MS } } as Filter<RoomDoc>,
      emitStages('admin', 'admin', literal({ kind: 'command', at: t, ...clean }), peerId, t),
      { projection: { _id: 1 } },
    );
    return doc !== null;
  }

  async ban(entry: BanEntry): Promise<BanResult> {
    const ip = cleanIp(entry.ip);
    const deviceId = isUuid(entry.deviceId) ? entry.deviceId : undefined;
    const reason = cleanReason(entry.reason, 'Banido pelo administrador');
    const bannedName = typeof entry.bannedName === 'string' ? entry.bannedName.trim().slice(0, 60) || undefined : undefined;
    const room = typeof entry.room === 'string' && entry.room ? entry.room : undefined;
    const bans: Ban[] = [];
    for (const [kind, value] of [['ip', ip], ['device', deviceId]] as const) {
      if (!value) continue;
      const ban: Ban = {
        id: banId(kind, value),
        kind,
        value,
        reason,
        createdAt: this.now(),
        ...(bannedName ? { bannedName } : {}),
        ...(room ? { room } : {}),
      };
      const { id, ...rest } = ban;
      await this.adm.bans.replaceOne({ _id: id }, rest, { upsert: true });
      bans.push(ban);
    }
    if (bans.length === 0) return { bans: [], removed: 0 };
    return { bans, removed: await this.removeMatching(ip, deviceId, reason) };
  }

  async banPeer(room: string, peerId: string, reason?: string): Promise<BanResult | null> {
    if (!UUID.test(peerId)) return null;
    const peer = await this.findAlivePeer(room, peerId);
    if (!peer || peer.observer) return null;
    const result = await this.ban({ ip: peer.ip, deviceId: peer.deviceId, reason, bannedName: peer.name, room });
    // sem IP nem dispositivo para banir, a pessoa ainda assim sai (e, se o ban já a removeu, isto não conta de novo)
    await this.tombstone(room, peerId, peer.tokenHash, 'banned', cleanReason(reason) || undefined);
    if (await this.removePeer(room, peerId)) result.removed += 1;
    return result;
  }

  async listBans(): Promise<Ban[]> {
    const docs = await this.adm.bans.find({}).sort({ createdAt: -1, _id: 1 }).toArray();
    return docs.map(({ _id, ...rest }) => ({ id: _id, ...rest }));
  }

  async unban(id: string) {
    if (typeof id !== 'string' || !id) return false;
    return (await this.adm.bans.deleteOne({ _id: id })).deletedCount > 0;
  }

  private async findAlivePeer(room: string, peerId: string): Promise<PeerDoc | undefined> {
    const doc = await this.rooms.findOne({ _id: room }, { projection: { [`peers.${peerId}`]: 1 } });
    const peer = doc?.peers?.[peerId];
    return peer && peer.lastSeen >= this.now() - PEER_TTL_MS ? peer : undefined;
  }

  private summarize(name: string, doc: Pick<RoomDoc, 'peers' | 'createdAt' | 'updatedAt'> | undefined, closed: ClosedDoc | undefined, limit: number, passwordProtected: boolean): AdminRoomSummary {
    const alive = Object.values(doc?.peers ?? {}).filter((p) => p.lastSeen >= limit);
    const observerCount = alive.filter((p) => p.observer).length;
    const created = doc?.createdAt ?? doc?.updatedAt?.getTime() ?? closed?.at ?? 0;
    return {
      name,
      peerCount: alive.length - observerCount,
      observerCount,
      createdAt: created,
      lastActivity: Math.max(doc?.updatedAt?.getTime() ?? 0, closed?.at ?? 0, created),
      closed: !!closed,
      ...(closed?.reason ? { closedReason: closed.reason } : {}),
      passwordProtected,
    };
  }

  /** Remove (com tombstone 'banned') quem casar por IP ou dispositivo, em todas as salas. Observadores ficam. */
  private async removeMatching(ip: string | undefined, deviceId: string | undefined, reason: string) {
    const docs = await this.rooms.find({}, { projection: { peers: 1 } }).toArray();
    let removed = 0;
    for (const doc of docs) {
      for (const [id, p] of Object.entries(doc.peers)) {
        if (p.observer) continue;
        if (!((ip && p.ip === ip) || (deviceId && p.deviceId === deviceId))) continue;
        await this.tombstone(doc._id, id, p.tokenHash, 'banned', reason);
        if (await this.removePeer(doc._id, id)) removed += 1;
      }
    }
    return removed;
  }

  private tombstoneOp(room: string, peerId: string, tokenHash: string, reason: RemovalReason, detail?: string) {
    const _id = `${room}:${peerId}`;
    const doc: RemovedDoc = { _id, room, peerId, reason, ...(detail ? { detail } : {}), tokenHash, atMs: this.now(), at: new Date() };
    return { replaceOne: { filter: { _id }, replacement: doc, upsert: true } };
  }

  /** Guarda por ~2 min por que o peer saiu, para o 410 dele carregar o motivo (e só para quem prova ser ele). */
  private async tombstone(room: string, peerId: string, tokenHash: string, reason: RemovalReason, detail?: string) {
    await this.adm.removed.bulkWrite([this.tombstoneOp(room, peerId, tokenHash, reason, detail)]);
  }

  /** Erro de peer desconhecido; com o motivo se foi removido pelo admin há pouco (e, havendo token, só se ele bater). */
  private async gone(room: string, peerId: string, token?: string): Promise<UnknownPeerError> {
    if (!this.opts.admin || !UUID.test(peerId)) return new UnknownPeerError();
    const tomb = await this.opts.admin.removed.findOne({ _id: `${room}:${peerId}` });
    if (tomb && this.now() - tomb.atMs <= TOMBSTONE_MS && (token === undefined || sameHash(tomb.tokenHash, hashToken(token)))) {
      return new UnknownPeerError(tomb.reason, tomb.detail);
    }
    return new UnknownPeerError();
  }

  /** Cria a sala vazia se ainda não existir. Duas criações simultâneas: a que perde a corrida só ignora. */
  private async ensureRoom(room: string) {
    try {
      await this.rooms.updateOne(
        { _id: room },
        { $setOnInsert: { seq: 0, gen: 0, peers: {}, events: [], updatedAt: new Date(), createdAt: this.now() } },
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
    if (!doc) throw await this.gone(room, peerId);
  }

  /**
   * Remove o peer e avisa os outros. Com `expiredBefore`, só remove se ele ainda estiver expirado:
   * assim, duas instâncias varrendo ao mesmo tempo, ou um poll que chega no último instante, não se atropelam.
   */
  private async removePeer(room: string, peerId: string, expiredBefore?: number): Promise<boolean> {
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
    return doc !== null;
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
