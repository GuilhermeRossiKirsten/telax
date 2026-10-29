import { createHash } from 'node:crypto';
import {
  ADMIN_MESSAGE_MAX,
  ADMIN_REASON_MAX,
  type AdminCommand,
  type AdminRoomDetail,
  type AdminRoomSummary,
  type Ban,
  type JoinContext,
  type RemovalReason,
} from '@/lib/admin-types';
import { MAX_SCREENS } from '@/lib/screens';
import type { PeerInfo, PeerMediaState, RoomEvent, SignalData } from '@/lib/types';

export const PEER_TTL_MS = 15_000;
export const MAX_EVENTS = 500;
/** Por quanto tempo um peer removido pelo admin ainda recebe o motivo (`410 gone` com `reason`). */
export const TOMBSTONE_MS = 120_000;

/**
 * Opções dos armazenamentos. `maxPeers` é um limite OPCIONAL de pessoas por sala (variável de ambiente `MAX_PEERS`):
 * sem ele a sala não tem limite. (Em malha P2P o custo cresce com o quadrado do nº de pessoas; o limite existe só
 * para quem quiser impor um teto.) Observadores (o admin) nunca contam para esse limite.
 */
export type RoomStoreOptions = { maxPeers?: number };

export class RoomFullError extends Error {
  constructor() {
    super('room_full');
  }
}

/** IP ou dispositivo banido pelo admin. */
export class BannedError extends Error {
  constructor(public detail?: string) {
    super('banned');
  }
}

/** Sala fechada pelo admin (`reason`: o motivo informado). */
export class RoomClosedError extends Error {
  constructor(public reason?: string) {
    super('room_closed');
  }
}

/**
 * Peer/sala/token desconhecidos. `reason` só vem quando o peer foi REMOVIDO PELO ADMIN há pouco (tombstone) e quem
 * pergunta provou ser ele; `detail` é o texto livre do admin (opcional).
 */
export class UnknownPeerError extends Error {
  constructor(
    public reason?: RemovalReason,
    public detail?: string,
  ) {
    super('unknown_peer');
  }
}

/** O store em memória responde direto; o do MongoDB, por Promise. Quem chama sempre usa `await`. */
export type Awaitable<T> = T | Promise<T>;

export type BanResult = { bans: Ban[]; removed: number };
export type BanEntry = { ip?: string; deviceId?: string; reason?: string; bannedName?: string; room?: string };

export interface RoomStore {
  /**
   * `token` é segredo do participante: só volta aqui, nunca em participants nem em eventos.
   * Ordem das checagens (não observador): banido (IP ou dispositivo) → `BannedError`; sala fechada → `RoomClosedError`;
   * sala cheia (só com `maxPeers`) → `RoomFullError`. Observador (o admin) pula as três e não conta para o limite.
   */
  join(
    room: string,
    name: string,
    ctx?: JoinContext,
  ): Awaitable<{ peerId: string; token: string; participants: PeerInfo[]; cursor: number; gen: number }>;
  /** Lança UnknownPeerError se sala/peer não existirem ou o token não bater. */
  authenticate(room: string, peerId: string, token: string): Awaitable<void>;
  events(room: string, peerId: string, since: number): Awaitable<{ events: RoomEvent[]; cursor: number }>;
  /**
   * Igual a events() no filtro e no resultado, mas SÓ LEITURA: não renova o `lastSeen`, não escreve e não varre
   * peers expirados. Serve à espera longa da rota /events (que renova o batimento uma vez por requisição).
   * Lança UnknownPeerError se o peer não existe ou já passou do TTL.
   */
  peekEvents(room: string, peerId: string, since: number): Awaitable<{ events: RoomEvent[]; cursor: number }>;
  signal(room: string, from: string, to: string, data: SignalData): Awaitable<void>;
  chat(room: string, from: string, text: string): Awaitable<void>;
  setState(room: string, from: string, state: PeerMediaState): Awaitable<void>;
  restart(room: string, from: string): Awaitable<number>;
  leave(room: string, peerId: string): Awaitable<void>;

  // ---- administração (só as rotas de admin chamam; a rota é quem garante a sessão) ----

  /** Salas abertas e fechadas, da mais recente para a mais antiga em atividade. */
  listRooms(): Awaitable<AdminRoomSummary[]>;
  /** `null` se a sala não existe e não está fechada. Traz ip/deviceId de cada peer. */
  getRoom(room: string): Awaitable<AdminRoomDetail | null>;
  /** Remove a pessoa (avisa os outros com `leave`) e deixa o tombstone 'kicked'. `false` se ela não existe. */
  kick(room: string, peerId: string, reason?: string): Awaitable<boolean>;
  /** Remove todos (tombstone 'closed') e deixa a sala fechada até `reopenRoom`. Devolve quantos PARTICIPANTES saíram (sem observadores). */
  closeRoom(room: string, reason?: string): Awaitable<number>;
  /** `true` se a sala estava fechada. */
  reopenRoom(room: string): Awaitable<boolean>;
  /** Evento admin `message` para os não observadores da sala (`null` = todas). Devolve quantos alcançou. */
  broadcast(room: string | null, text: string): Awaitable<number>;
  /** Evento admin `command` dirigido a UM peer. `false` se o peer não existe ou o comando é inválido. */
  command(room: string, peerId: string, cmd: AdminCommand): Awaitable<boolean>;
  /** Bane IP e/ou dispositivo (valores inválidos, 'unknown' e vazios são ignorados) e remove quem casar, em qualquer sala. */
  ban(entry: BanEntry): Awaitable<BanResult>;
  /** Bane o IP e o dispositivo de um peer conectado. `null` se ele não existe. */
  banPeer(room: string, peerId: string, reason?: string): Awaitable<BanResult | null>;
  listBans(): Awaitable<Ban[]>;
  unban(id: string): Awaitable<boolean>;
}

// ---- helpers compartilhados pelos dois armazenamentos ----

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** IP utilizável para banir/comparar: não vazio, não 'unknown', de tamanho razoável. */
export function cleanIp(ip: unknown): string | undefined {
  if (typeof ip !== 'string') return undefined;
  const v = ip.trim();
  return v && v.toLowerCase() !== 'unknown' && v.length <= 64 ? v : undefined;
}

/** Id estável de um ban: banir duas vezes o mesmo valor é o mesmo registro. */
export const banId = (kind: Ban['kind'], value: string) => `${kind}-${createHash('sha256').update(value).digest('hex').slice(0, 20)}`;

export const cleanReason = (reason: unknown, fallback = ''): string => {
  const v = typeof reason === 'string' ? reason.trim().slice(0, ADMIN_REASON_MAX) : '';
  return v || fallback;
};

/** Texto de mensagem do admin já limpo (ou `null` se ficou vazio). */
export function cleanMessage(text: unknown): string | null {
  const v = typeof text === 'string' ? text.trim().slice(0, ADMIN_MESSAGE_MAX) : '';
  return v || null;
}

const COMMANDS = ['screens', 'screen', 'camera', 'mic', 'all'] as const;

/** Valida um comando do admin; devolve a versão limpa ou `null`. */
export function cleanCommand(cmd: unknown): AdminCommand | null {
  if (!cmd || typeof cmd !== 'object') return null;
  const { what, slot } = cmd as AdminCommand;
  if (!COMMANDS.includes(what)) return null;
  if (what === 'screen') {
    if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot >= MAX_SCREENS) return null;
    return { what, slot };
  }
  return { what };
}
