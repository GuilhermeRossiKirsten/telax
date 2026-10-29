import { randomUUID, timingSafeEqual } from 'node:crypto';
import type { ChatPayload, PeerInfo, PeerMediaState, RoomEvent, RoomEventType, SignalData } from '@/lib/types';
import {
  MAX_EVENTS,
  MAX_PEERS,
  PEER_TTL_MS,
  RoomFullError,
  UnknownPeerError,
  type RoomStore,
} from './room-store';
import { resolveMediaState } from '@/lib/validation';

type Peer = PeerInfo & { lastSeen: number; token: string };

type Room = {
  peers: Map<string, Peer>;
  events: RoomEvent[];
  seq: number;
  gen: number;
};

function toInfo({ lastSeen: _lastSeen, token: _token, ...info }: Peer): PeerInfo {
  return info;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class MemoryRoomStore implements RoomStore {
  private rooms = new Map<string, Room>();

  constructor(private now: () => number = Date.now) {}

  join(room: string, name: string) {
    this.sweep();
    const r = this.rooms.get(room) ?? this.createRoom(room);
    if (r.peers.size >= MAX_PEERS) throw new RoomFullError();
    const t = this.now();
    const peer: Peer = {
      id: randomUUID(),
      name,
      joinedAt: t,
      lastSeen: t,
      audio: true,
      video: true,
      sharing: false,
      screenSlots: 0,
      token: randomUUID(),
    };
    r.peers.set(peer.id, peer);
    this.emit(r, 'join', peer.id, toInfo(peer));
    return {
      peerId: peer.id,
      token: peer.token,
      participants: [...r.peers.values()].map(toInfo),
      cursor: r.seq,
      gen: r.gen,
    };
  }

  authenticate(room: string, peerId: string, token: string) {
    this.sweep();
    const peer = this.rooms.get(room)?.peers.get(peerId);
    if (!peer || !sameToken(peer.token, token)) throw new UnknownPeerError();
  }

  events(room: string, peerId: string, since: number) {
    this.sweep();
    const r = this.rooms.get(room);
    const peer = r?.peers.get(peerId);
    if (!r || !peer) throw new UnknownPeerError();
    peer.lastSeen = this.now();
    const events = r.events.filter(
      (e) => e.seq > since && e.from !== peerId && (e.to === undefined || e.to === peerId),
    );
    return { events, cursor: r.seq };
  }

  signal(room: string, from: string, to: string, data: SignalData) {
    const r = this.requirePeer(room, from);
    // Cliente legítimo nunca está à frente da sala; aceitar deixaria alguém arrastar todos para um gen enorme.
    if (!r.peers.has(to) || data.gen > r.gen) return;
    this.emit(r, 'signal', from, data, to);
  }

  chat(room: string, from: string, text: string) {
    const r = this.requirePeer(room, from);
    const payload: ChatPayload = {
      id: randomUUID(),
      name: r.peers.get(from)!.name,
      text,
      at: this.now(),
    };
    this.emit(r, 'chat', from, payload);
  }

  setState(room: string, from: string, state: PeerMediaState) {
    const r = this.requirePeer(room, from);
    const peer = r.peers.get(from)!;
    const media = resolveMediaState(state);
    peer.audio = media.audio;
    peer.video = media.video;
    peer.sharing = media.sharing;
    peer.screenSlots = media.screenSlots;
    this.emit(r, 'state', from, media);
  }

  restart(room: string, from: string) {
    const r = this.requirePeer(room, from);
    r.gen += 1;
    this.emit(r, 'restart', from, { gen: r.gen });
    return r.gen;
  }

  leave(room: string, peerId: string) {
    const r = this.rooms.get(room);
    if (!r || !r.peers.delete(peerId)) return;
    this.emit(r, 'leave', peerId, {});
    if (r.peers.size === 0) this.rooms.delete(room);
  }

  private createRoom(name: string): Room {
    const r: Room = { peers: new Map(), events: [], seq: 0, gen: 0 };
    this.rooms.set(name, r);
    return r;
  }

  /** Confirma que o peer existe e o conta como ativo. */
  private requirePeer(room: string, peerId: string): Room {
    this.sweep();
    const r = this.rooms.get(room);
    const peer = r?.peers.get(peerId);
    if (!r || !peer) throw new UnknownPeerError();
    peer.lastSeen = this.now();
    return r;
  }

  private emit(r: Room, type: RoomEventType, from: string, payload: unknown, to?: string) {
    r.seq += 1;
    r.events.push({ seq: r.seq, type, from, to, payload });
    let excess = r.events.length - MAX_EVENTS;
    if (excess <= 0) return;
    // Os sinais (SDP/ICE) são efêmeros e muito numerosos: numa sala com várias pessoas eles lotam o log em segundos.
    // Ao estourar o limite saem PRIMEIRO os sinais mais velhos; entradas, saídas, estados e chat só saem se faltar espaço
    // (cortar uma entrada faria quem demorou a consultar nunca mais ver aquela pessoa).
    const kept: typeof r.events = [];
    for (const e of r.events) {
      if (excess > 0 && e.type === 'signal') excess -= 1;
      else kept.push(e);
    }
    r.events = kept;
    if (excess > 0) r.events.splice(0, excess);
  }

  private sweep() {
    const limit = this.now() - PEER_TTL_MS;
    for (const [name, r] of [...this.rooms]) {
      for (const peer of [...r.peers.values()]) {
        if (peer.lastSeen < limit) this.leave(name, peer.id);
      }
    }
  }
}
