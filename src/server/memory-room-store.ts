import { randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  AdminCommand,
  AdminEventPayload,
  AdminPeer,
  AdminRoomDetail,
  AdminRoomSummary,
  Ban,
  JoinContext,
  RemovalReason,
} from '@/lib/admin-types';
import type { ChatPayload, PeerInfo, PeerMediaState, RoomEvent, RoomEventType, SignalData } from '@/lib/types';
import {
  BannedError,
  MAX_EVENTS,
  PEER_TTL_MS,
  RoomClosedError,
  RoomFullError,
  TOMBSTONE_MS,
  UnknownPeerError,
  banId,
  cleanCommand,
  cleanIp,
  cleanMessage,
  cleanReason,
  isUuid,
  type BanEntry,
  type BanResult,
  type RoomStore,
  type RoomStoreOptions,
} from './room-store';
import { resolveMediaState } from '@/lib/validation';

/** ip/deviceId só existem aqui: nunca saem em PeerInfo nem em eventos (só `getRoom`, para o admin). */
type Peer = PeerInfo & { lastSeen: number; token: string; ip?: string; deviceId?: string };

/** `audience: 'peers'`: o evento só vai a quem NÃO é observador (a mensagem do admin não precisa chegar ao próprio admin). */
type StoredEvent = RoomEvent & { audience?: 'peers' };

type Room = {
  peers: Map<string, Peer>;
  events: StoredEvent[];
  seq: number;
  gen: number;
  createdAt: number;
  lastActivity: number;
};

type Tombstone = { reason: RemovalReason; detail?: string; token: string; at: number };

function toInfo({ lastSeen: _lastSeen, token: _token, ip: _ip, deviceId: _deviceId, ...info }: Peer): PeerInfo {
  return info;
}

function sameToken(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export class MemoryRoomStore implements RoomStore {
  private rooms = new Map<string, Room>();
  private closed = new Map<string, { reason?: string; at: number }>();
  private bans = new Map<string, Ban>();
  private tombstones = new Map<string, Tombstone>();

  constructor(
    private now: () => number = Date.now,
    private opts: RoomStoreOptions = {},
  ) {}

  join(room: string, name: string, ctx?: JoinContext) {
    this.sweep();
    const observer = ctx?.observer === true;
    const ip = cleanIp(ctx?.ip);
    const deviceId = isUuid(ctx?.deviceId) ? ctx.deviceId : undefined;
    const existing = this.rooms.get(room);
    if (!observer) {
      if (this.isBanned(ip, deviceId)) throw new BannedError();
      const closed = this.closed.get(room);
      if (closed) throw new RoomClosedError(closed.reason);
      if (this.opts.maxPeers !== undefined && existing && this.participants(existing).length >= this.opts.maxPeers) {
        throw new RoomFullError();
      }
    }
    const r = existing ?? this.createRoom(room);
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
      ...(observer ? { observer: true } : {}),
      ...(ip ? { ip } : {}),
      ...(deviceId ? { deviceId } : {}),
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
    if (!peer || !sameToken(peer.token, token)) throw this.gone(room, peerId, token);
  }

  events(room: string, peerId: string, since: number) {
    this.sweep();
    const r = this.rooms.get(room);
    const peer = r?.peers.get(peerId);
    if (!r || !peer) throw this.gone(room, peerId);
    peer.lastSeen = this.now();
    return this.read(r, peerId, since);
  }

  peekEvents(room: string, peerId: string, since: number) {
    const r = this.rooms.get(room);
    const peer = r?.peers.get(peerId);
    // só leitura: nada de sweep (que escreveria) nem de lastSeen; o TTL é conferido na hora
    if (!r || !peer || peer.lastSeen < this.now() - PEER_TTL_MS) throw this.gone(room, peerId);
    return this.read(r, peerId, since);
  }

  private read(r: Room, peerId: string, since: number) {
    const observer = r.peers.get(peerId)?.observer === true;
    const events: RoomEvent[] = [];
    for (const { audience, ...e } of r.events) {
      if (e.seq <= since || e.from === peerId || (e.to !== undefined && e.to !== peerId)) continue;
      if (audience === 'peers' && observer) continue;
      events.push(e);
    }
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

  // ---- administração ----

  listRooms(): AdminRoomSummary[] {
    this.sweep();
    const names = new Set([...this.rooms.keys(), ...this.closed.keys()]);
    return [...names].map((name) => this.summary(name)).sort((a, b) => b.lastActivity - a.lastActivity || a.name.localeCompare(b.name));
  }

  getRoom(room: string): AdminRoomDetail | null {
    this.sweep();
    const r = this.rooms.get(room);
    if (!r && !this.closed.has(room)) return null;
    const peers: AdminPeer[] = r
      ? [...r.peers.values()].map((p) => ({
          id: p.id,
          name: p.name,
          joinedAt: p.joinedAt,
          lastSeen: p.lastSeen,
          audio: p.audio,
          video: p.video,
          sharing: p.sharing,
          screenSlots: p.screenSlots,
          observer: p.observer === true,
          ip: p.ip ?? null,
          deviceId: p.deviceId ?? null,
        }))
      : [];
    return { ...this.summary(room), peers };
  }

  kick(room: string, peerId: string, reason?: string) {
    const peer = this.rooms.get(room)?.peers.get(peerId);
    if (!peer) return false;
    this.tombstone(room, peer, 'kicked', cleanReason(reason) || undefined);
    this.leave(room, peerId);
    return true;
  }

  closeRoom(room: string, reason?: string) {
    this.sweep();
    const why = cleanReason(reason) || undefined;
    // marca fechada ANTES de remover: um join que chegue agora já é recusado
    this.closed.set(room, { reason: why, at: this.now() });
    const r = this.rooms.get(room);
    if (!r) return 0;
    let removed = 0;
    for (const peer of r.peers.values()) {
      this.tombstone(room, peer, 'closed', why);
      if (!peer.observer) removed += 1;
    }
    this.rooms.delete(room);
    return removed;
  }

  reopenRoom(room: string) {
    return this.closed.delete(room);
  }

  broadcast(room: string | null, text: string) {
    const message = cleanMessage(text);
    if (!message) return 0;
    this.sweep();
    const targets = room === null ? [...this.rooms.values()] : [this.rooms.get(room)].filter((r): r is Room => !!r);
    let reached = 0;
    for (const r of targets) {
      const count = this.participants(r).length;
      if (count === 0) continue;
      const payload: AdminEventPayload = { kind: 'message', text: message, at: this.now() };
      this.emit(r, 'admin', 'admin', payload, undefined, 'peers');
      reached += count;
    }
    return reached;
  }

  command(room: string, peerId: string, cmd: AdminCommand) {
    const clean = cleanCommand(cmd);
    if (!clean) return false;
    this.sweep();
    const r = this.rooms.get(room);
    if (!r || !r.peers.has(peerId)) return false;
    const payload: AdminEventPayload = { kind: 'command', at: this.now(), ...clean };
    this.emit(r, 'admin', 'admin', payload, peerId);
    return true;
  }

  ban(entry: BanEntry): BanResult {
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
      this.bans.set(ban.id, ban);
      bans.push(ban);
    }
    if (bans.length === 0) return { bans: [], removed: 0 };
    return { bans, removed: this.removeMatching(ip, deviceId, reason) };
  }

  banPeer(room: string, peerId: string, reason?: string): BanResult | null {
    this.sweep();
    const peer = this.rooms.get(room)?.peers.get(peerId);
    if (!peer || peer.observer) return null;
    const result = this.ban({ ip: peer.ip, deviceId: peer.deviceId, reason, bannedName: peer.name, room });
    // sem IP nem dispositivo para banir, a pessoa ainda assim sai
    if (this.rooms.get(room)?.peers.has(peerId)) {
      this.tombstone(room, peer, 'banned', cleanReason(reason) || undefined);
      this.leave(room, peerId);
      result.removed += 1;
    }
    return result;
  }

  listBans(): Ban[] {
    return [...this.bans.values()].sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  unban(id: string) {
    return this.bans.delete(id);
  }

  // ---- internos ----

  private isBanned(ip?: string, deviceId?: string) {
    return (!!ip && this.bans.has(banId('ip', ip))) || (!!deviceId && this.bans.has(banId('device', deviceId)));
  }

  private participants(r: Room) {
    return [...r.peers.values()].filter((p) => !p.observer);
  }

  private summary(name: string): AdminRoomSummary {
    const r = this.rooms.get(name);
    const closed = this.closed.get(name);
    const base = closed?.at ?? 0;
    return {
      name,
      peerCount: r ? this.participants(r).length : 0,
      observerCount: r ? r.peers.size - this.participants(r).length : 0,
      createdAt: r?.createdAt ?? base,
      lastActivity: Math.max(r?.lastActivity ?? 0, base),
      closed: !!closed,
      ...(closed?.reason ? { closedReason: closed.reason } : {}),
    };
  }

  /** Remove (com tombstone 'banned') quem casar por IP ou dispositivo, em todas as salas. Observadores ficam. */
  private removeMatching(ip: string | undefined, deviceId: string | undefined, reason: string) {
    let removed = 0;
    for (const [name, r] of [...this.rooms]) {
      for (const peer of [...r.peers.values()]) {
        if (peer.observer) continue;
        if ((ip && peer.ip === ip) || (deviceId && peer.deviceId === deviceId)) {
          this.tombstone(name, peer, 'banned', reason);
          this.leave(name, peer.id);
          removed += 1;
        }
      }
    }
    return removed;
  }

  /** Guarda por ~2 min por que o peer saiu, para o 410 dele carregar o motivo (e só para quem prova ser ele). */
  private tombstone(room: string, peer: Peer, reason: RemovalReason, detail?: string) {
    const t = this.now();
    for (const [key, tomb] of this.tombstones) if (t - tomb.at > TOMBSTONE_MS) this.tombstones.delete(key);
    this.tombstones.set(`${room}:${peer.id}`, { reason, detail, token: peer.token, at: t });
  }

  /** Erro de peer desconhecido; com o motivo se foi removido pelo admin há pouco (e, havendo token, só se ele bater). */
  private gone(room: string, peerId: string, token?: string): UnknownPeerError {
    const tomb = this.tombstones.get(`${room}:${peerId}`);
    if (tomb && this.now() - tomb.at <= TOMBSTONE_MS && (token === undefined || sameToken(tomb.token, token))) {
      return new UnknownPeerError(tomb.reason, tomb.detail);
    }
    return new UnknownPeerError();
  }

  private createRoom(name: string): Room {
    const t = this.now();
    const r: Room = { peers: new Map(), events: [], seq: 0, gen: 0, createdAt: t, lastActivity: t };
    this.rooms.set(name, r);
    return r;
  }

  /** Confirma que o peer existe e o conta como ativo. */
  private requirePeer(room: string, peerId: string): Room {
    this.sweep();
    const r = this.rooms.get(room);
    const peer = r?.peers.get(peerId);
    if (!r || !peer) throw this.gone(room, peerId);
    peer.lastSeen = this.now();
    return r;
  }

  private emit(r: Room, type: RoomEventType, from: string, payload: unknown, to?: string, audience?: 'peers') {
    r.seq += 1;
    r.lastActivity = this.now();
    r.events.push({ seq: r.seq, type, from, to, payload, ...(audience ? { audience } : {}) });
    let excess = r.events.length - MAX_EVENTS;
    if (excess <= 0) return;
    // Os sinais (SDP/ICE) são efêmeros e muito numerosos: numa sala com várias pessoas eles lotam o log em segundos.
    // Ao estourar o limite saem PRIMEIRO os sinais mais velhos; entradas, saídas, estados, chat e eventos de admin só
    // saem se faltar espaço (cortar uma entrada faria quem demorou a consultar nunca mais ver aquela pessoa).
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
