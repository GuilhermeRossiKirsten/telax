import type { PeerInfo, PeerMediaState, RoomEvent, SignalData } from '@/lib/types';

export const PEER_TTL_MS = 15_000;
export const MAX_EVENTS = 500;

/**
 * Opções dos armazenamentos. `maxPeers` é um limite OPCIONAL de pessoas por sala (variável de ambiente `MAX_PEERS`):
 * sem ele a sala não tem limite. (Em malha P2P o custo cresce com o quadrado do nº de pessoas; o limite existe só
 * para quem quiser impor um teto.)
 */
export type RoomStoreOptions = { maxPeers?: number };

export class RoomFullError extends Error {
  constructor() {
    super('room_full');
  }
}

export class UnknownPeerError extends Error {
  constructor() {
    super('unknown_peer');
  }
}

/** O store em memória responde direto; o do MongoDB, por Promise. Quem chama sempre usa `await`. */
export type Awaitable<T> = T | Promise<T>;

export interface RoomStore {
  /** `token` é segredo do participante: só volta aqui, nunca em participants nem em eventos. */
  join(
    room: string,
    name: string,
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
}
