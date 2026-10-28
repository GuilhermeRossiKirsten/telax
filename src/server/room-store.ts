import type { PeerInfo, PeerMediaState, RoomEvent, SignalData } from '@/lib/types';

export const MAX_PEERS = 8;
export const PEER_TTL_MS = 15_000;
export const MAX_EVENTS = 500;

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

export interface RoomStore {
  /** `token` é segredo do participante: só volta aqui, nunca em participants nem em eventos. */
  join(
    room: string,
    name: string,
  ): { peerId: string; token: string; participants: PeerInfo[]; cursor: number; gen: number };
  /** Lança UnknownPeerError se sala/peer não existirem ou o token não bater. */
  authenticate(room: string, peerId: string, token: string): void;
  events(room: string, peerId: string, since: number): { events: RoomEvent[]; cursor: number };
  signal(room: string, from: string, to: string, data: SignalData): void;
  chat(room: string, from: string, text: string): void;
  setState(room: string, from: string, state: PeerMediaState): void;
  restart(room: string, from: string): number;
  leave(room: string, peerId: string): void;
}
