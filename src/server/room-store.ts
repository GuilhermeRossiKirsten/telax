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
import type { PasswordRecord } from './room-password';

export const PEER_TTL_MS = 15_000;
export const MAX_EVENTS = 500;
/** Por quanto tempo um peer removido pelo admin ainda recebe o motivo (`410 gone` com `reason`). */
export const TOMBSTONE_MS = 120_000;

/** A senha da sala expira tanto tempo depois do último uso (definir ou entrar com sucesso). Sobrevive à sala ficar vazia. */
export const PASSWORD_TTL_MS = 24 * 60 * 60_000;
/** Janela em que os erros de senha são contados. */
export const PASSWORD_ATTEMPT_WINDOW_MS = 10 * 60_000;
/** Por (sala, IP): 5 erros na janela trancam a tentativa por 5 min. */
export const PASSWORD_KEY_LIMIT = 5;
export const PASSWORD_KEY_LOCK_MS = 5 * 60_000;
/** Por sala (todos os IPs): 50 erros na janela trancam todos por 1 min. */
export const PASSWORD_ROOM_LIMIT = 50;
export const PASSWORD_ROOM_LOCK_MS = 60_000;

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

/** O que a tela inicial pode saber de uma sala sem entrar nela. */
export type RoomPreview = {
  count: number;
  closed: boolean;
  /** existe uma senha VIVA para a sala (só a existência: nunca o hash). */
  protected: boolean;
};

/** Estado da trava de tentativas de senha. `retryAfterMs` é 0 quando não está trancado. */
export type PasswordThrottle = { locked: boolean; retryAfterMs: number };
export type SetPasswordResult = 'ok' | 'not_host' | 'unknown_peer';

/** O anfitrião: o participante (sem observadores) mais antigo; desempate pelo menor id. Recebe só quem está vivo. */
export function pickHost(peers: Iterable<{ id: string; joinedAt: number; observer?: boolean }>): string | undefined {
  let host: { id: string; joinedAt: number } | undefined;
  for (const p of peers) {
    if (p.observer) continue;
    if (!host || p.joinedAt < host.joinedAt || (p.joinedAt === host.joinedAt && p.id < host.id)) host = p;
  }
  return host?.id;
}

/** Chave de tentativa limitada a um tamanho razoável (vem do IP do cliente). */
export const cleanThrottleKey = (key: unknown): string => (typeof key === 'string' ? key.slice(0, 80) : '');

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
  /**
   * Preview PÚBLICO da sala para a tela inicial: quantas pessoas vivas há nela (TTL aplicado na leitura; sem
   * observadores/administrador; sala inexistente = 0), se o admin a fechou e se exige senha. SÓ LEITURA e sem identificar ninguém:
   * o resultado tem exatamente `count`, `closed` e `protected` (nunca nomes, ids, ips nem tokens).
   */
  roomPreview(room: string): Awaitable<RoomPreview>;
  // ---- senha da sala (a rota faz o hash e a verificação; o store guarda, confere o anfitrião e conta tentativas) ----

  /** Registro de senha VIVO da sala (TTL de 24 h aplicado na leitura) ou `null`. Sobrevive à sala ficar vazia. */
  getRoomPassword(room: string): Awaitable<PasswordRecord | null>;
  /**
   * Define (registro) ou remove (`null`) a senha. Só o anfitrião: `'not_host'` para os outros (inclusive observador);
   * `'unknown_peer'` se o peer não está vivo na sala. Renova o TTL de 24 h e emite o evento `room` `{protected}`
   * (de `peerId`, só para não observadores).
   */
  setRoomPassword(room: string, peerId: string, record: PasswordRecord | null): Awaitable<SetPasswordResult>;
  /** `true` se o peer é o anfitrião (o participante vivo mais antigo). */
  isRoomHost(room: string, peerId: string): Awaitable<boolean>;
  /** Consulta a trava de `key` (por IP) e da sala, SEM contar. */
  passwordThrottle(room: string, key: string): Awaitable<PasswordThrottle>;
  /** Conta um erro de senha para `key` e para a sala; devolve o estado da trava depois de contar. */
  passwordFailed(room: string, key: string): Awaitable<PasswordThrottle>;
  /** Senha certa: zera o contador de `key` e renova o TTL do registro. */
  passwordSucceeded(room: string, key: string): Awaitable<void>;
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
