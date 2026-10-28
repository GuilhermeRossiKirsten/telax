import { FileAssembler, sendFile, type FileHeader } from './file-transfer';
import { RestartQueue, isOfferer, isStale } from './negotiation';
import type { SignalData } from './types';

export type ConnState = 'connecting' | 'connected' | 'reconnecting' | 'failed';

type Slot = 'audio' | 'camera' | 'screen';
const SLOTS: Slot[] = ['audio', 'camera', 'screen'];
type RemoteTracks = Partial<Record<Slot, MediaStreamTrack>>;
type LocalTracks = Record<Slot, MediaStreamTrack | null>;

const DISCONNECT_GRACE_MS = 5000;
const RETRY_BASE_MS = 1000;
const RETRY_MAX_MS = 30_000;
const NEGOTIATE_TIMEOUT_MS = 8000;
/** Sessão que não conecta nesse prazo (ex.: offer ou reset perdidos) é tratada como 'failed'. */
const SESSION_TIMEOUT_MS = 20_000;
const noop = () => {};

export type PeerManagerOpts = {
  selfId: string;
  iceServers: RTCIceServer[];
  gen: number;
  sendSignal(to: string, data: SignalData): Promise<void>;
  onRemoteTracks(peerId: string, tracks: RemoteTracks): void;
  onConnState(peerId: string, state: ConnState): void;
  onFile(peerId: string, file: { header: FileHeader; blob: Blob }): void;
  createPC?: (cfg: RTCConfiguration) => RTCPeerConnection;
  /** Atraso aleatório (0..jitterMs) antes de cada offer, para espalhar a carga num reinício. */
  jitterMs?: number;
};

type Entry = {
  id: string;
  offerer: boolean;
  pc: RTCPeerConnection;
  /** Offerer: criados por nós. Quem responde: adotados da offer (ver adoptTransceivers). */
  tx: Partial<Record<Slot, RTCRtpTransceiver>>;
  channel: RTCDataChannel | null;
  assembler: FileAssembler;
  remoteSet: boolean;
  /** Sessão corrente: gerada pelo offerer a cada PC; quem responde copia da offer. */
  sid?: number;
  pending: Array<{ sid: number; candidate: RTCIceCandidateInit }>;
  remoteTracks: RemoteTracks;
  sendChain: Promise<void>;
  everConnected: boolean;
  attempts: number;
  lastState: ConnState | null;
  disconnectTimer?: ReturnType<typeof setTimeout>;
  retryTimer?: ReturnType<typeof setTimeout>;
  sessionTimer?: ReturnType<typeof setTimeout>;
  settle?: () => void;
};

export class PeerManager {
  private peers = new Map<string, Entry>();
  private gen: number;
  private queue = new RestartQueue(2);
  private local: LocalTracks = { audio: null, camera: null, screen: null };
  private closed = false;

  constructor(private opts: PeerManagerOpts) {
    this.gen = opts.gen;
  }

  setLocalTracks(tracks: LocalTracks): void {
    this.local = { ...tracks };
    for (const e of this.peers.values()) this.applyLocalTracks(e);
  }

  addPeer(peerId: string): void {
    if (this.closed || this.peers.has(peerId)) return;
    const e = { id: peerId, offerer: isOfferer(this.opts.selfId, peerId), sendChain: Promise.resolve(), attempts: 0 } as Entry;
    e.everConnected = false;
    e.lastState = null;
    this.peers.set(peerId, e);
    this.open(e);
    this.report(e, 'connecting');
    if (e.offerer) this.queueOffer(e);
  }

  removePeer(peerId: string): void {
    const e = this.peers.get(peerId);
    if (!e) return;
    this.clearTimers(e);
    this.closePc(e);
    this.peers.delete(peerId);
  }

  async handleSignal(from: string, data: SignalData): Promise<void> {
    if (this.closed || isStale(data.gen, this.gen)) return;
    if (data.gen > this.gen) this.restartAll(data.gen);
    if (!this.peers.has(from)) this.addPeer(from);
    const e = this.peers.get(from);
    if (!e) return;

    switch (data.kind) {
      case 'offer':
        if (!e.offerer && data.sdp && typeof data.sid === 'number') await this.answer(e, data.sdp, data.sid);
        break;
      case 'answer':
        // answer de outra sessão (ex.: de antes de um reset) não pode parear com o PC atual
        if (e.offerer && data.sdp && data.sid === e.sid) await this.applyAnswer(e, data.sdp);
        break;
      case 'candidate':
        if (!data.candidate || typeof data.sid !== 'number') break;
        if (e.sid !== undefined && data.sid !== e.sid) break;
        if (e.remoteSet) e.pc.addIceCandidate(data.candidate).catch(noop);
        // quem responde, antes da offer: a sessão só é conhecida em markRemoteSet
        else e.pending.push({ sid: data.sid, candidate: data.candidate });
        break;
      case 'reset':
        if (e.offerer) this.reopen(e);
        break;
    }
  }

  /** Recria todos os pares; só o lado offerer reoferta, via fila com concorrência limitada. */
  restartAll(newGen: number): void {
    if (this.closed || newGen <= this.gen) return;
    this.gen = newGen;
    for (const e of this.peers.values()) this.recreate(e, 'restart');
  }

  async sendFileToAll(file: File, onProgress?: (peerId: string, sent: number) => void): Promise<void> {
    const open = [...this.peers.values()].filter((e) => e.channel?.readyState === 'open');
    if (open.length === 0) throw new Error('no_open_channel');
    const results = await Promise.allSettled(
      open.map((e) => sendFile(e.channel!, file, (sent) => onProgress?.(e.id, sent))),
    );
    const failed = results.find((r): r is PromiseRejectedResult => r.status === 'rejected');
    if (failed && results.every((r) => r.status === 'rejected')) throw failed.reason;
  }

  close(): void {
    this.closed = true;
    for (const e of this.peers.values()) {
      this.clearTimers(e);
      this.closePc(e);
    }
    this.peers.clear();
  }

  // --- conexão -----------------------------------------------------------

  /** Cria um RTCPeerConnection novo (e tudo que depende dele) dentro da entrada. */
  private open(e: Entry): void {
    const create = this.opts.createPC ?? ((cfg: RTCConfiguration) => new RTCPeerConnection(cfg));
    const pc = create({ iceServers: this.opts.iceServers });
    e.pc = pc;
    e.remoteSet = false;
    e.pending = [];
    e.sid = e.offerer ? 1 + Math.floor(Math.random() * 2 ** 31) : undefined;
    e.remoteTracks = {};
    e.channel = null;
    e.assembler = new FileAssembler((file) => this.opts.onFile(e.id, file));
    if (e.offerer) {
      // Só o offerer cria os transceivers: o navegador não reaproveita os de addTransceiver ao
      // aplicar uma offer, então quem responde adota os que a offer cria (adoptTransceivers).
      e.tx = {
        audio: pc.addTransceiver('audio', { direction: 'sendrecv' }),
        camera: pc.addTransceiver('video', { direction: 'sendrecv' }),
        screen: pc.addTransceiver('video', { direction: 'sendrecv' }),
      };
      this.applyLocalTracks(e);
      this.attachChannel(e, pc.createDataChannel('files'));
    } else {
      e.tx = {};
      pc.ondatachannel = (ev) => this.attachChannel(e, ev.channel);
    }

    pc.onicecandidate = (ev) => {
      if (e.pc !== pc || !ev.candidate) return;
      this.signalTo(e, { kind: 'candidate', sid: e.sid, candidate: ev.candidate.toJSON() });
    };
    pc.ontrack = (ev) => {
      if (e.pc !== pc) return;
      const slot = this.slotOf(e, ev.transceiver);
      if (!slot) return;
      e.remoteTracks[slot] = ev.track;
      this.opts.onRemoteTracks(e.id, { ...e.remoteTracks });
    };
    pc.onconnectionstatechange = () => {
      if (e.pc === pc) this.onState(e, pc.connectionState);
    };

    // O offerer só arma o watchdog quando a offer sai (offer()): na fila de reinício ele pode esperar a vez.
    if (!e.offerer) this.armSessionTimer(e, pc);
  }

  /** Se o par não conectar em SESSION_TIMEOUT_MS (sinal perdido, etc.), trata como `failed` e reabre com backoff. */
  private armSessionTimer(e: Entry, pc: RTCPeerConnection): void {
    if (e.sessionTimer) clearTimeout(e.sessionTimer);
    e.sessionTimer = setTimeout(() => {
      e.sessionTimer = undefined;
      if (e.pc === pc && pc.connectionState !== 'connected') this.onState(e, 'failed');
    }, SESSION_TIMEOUT_MS);
  }

  private closePc(e: Entry): void {
    const { pc, channel } = e;
    pc.onicecandidate = null;
    pc.ontrack = null;
    pc.onconnectionstatechange = null;
    pc.ondatachannel = null;
    if (channel) {
      channel.onmessage = null;
      channel.close();
      e.channel = null;
    }
    pc.close();
    e.settle?.();
  }

  private recreate(e: Entry, why: 'restart' | 'retry'): void {
    this.clearTimers(e);
    this.closePc(e);
    if (why === 'restart') e.attempts = 0;
    this.open(e);
    this.report(e, e.everConnected ? 'reconnecting' : 'connecting');
    if (e.offerer) this.queueOffer(e);
  }

  /** Reabre um par sem mexer no gen global. Quem só responde pede a nova offer com `reset`. */
  private reopen(e: Entry): void {
    this.recreate(e, 'retry');
    if (!e.offerer) this.signalTo(e, { kind: 'reset' });
  }

  private onState(e: Entry, state: RTCPeerConnectionState): void {
    switch (state) {
      case 'connected':
        this.clearTimers(e);
        e.everConnected = true;
        e.attempts = 0;
        this.report(e, 'connected');
        e.settle?.();
        break;
      case 'disconnected':
        this.report(e, 'reconnecting');
        e.disconnectTimer ??= setTimeout(() => {
          e.disconnectTimer = undefined;
          this.reopen(e);
        }, DISCONNECT_GRACE_MS);
        break;
      case 'failed': {
        this.report(e, 'failed');
        e.settle?.();
        if (e.disconnectTimer) clearTimeout(e.disconnectTimer);
        e.disconnectTimer = undefined;
        if (e.retryTimer) break;
        const delay = Math.min(RETRY_BASE_MS * 2 ** e.attempts, RETRY_MAX_MS);
        e.attempts += 1;
        e.retryTimer = setTimeout(() => {
          e.retryTimer = undefined;
          this.reopen(e);
        }, delay);
        break;
      }
      case 'closed':
        e.settle?.();
        break;
      default:
        this.report(e, e.everConnected ? 'reconnecting' : 'connecting');
    }
  }

  private clearTimers(e: Entry): void {
    if (e.disconnectTimer) clearTimeout(e.disconnectTimer);
    if (e.retryTimer) clearTimeout(e.retryTimer);
    if (e.sessionTimer) clearTimeout(e.sessionTimer);
    e.disconnectTimer = undefined;
    e.retryTimer = undefined;
    e.sessionTimer = undefined;
  }

  private report(e: Entry, state: ConnState): void {
    if (e.lastState === state) return;
    e.lastState = state;
    this.opts.onConnState(e.id, state);
  }

  // --- negociação --------------------------------------------------------

  private queueOffer(e: Entry): void {
    const pc = e.pc;
    const gen = this.gen;
    this.queue.run(() => this.offer(e, pc, gen)).catch(noop);
  }

  private async offer(e: Entry, pc: RTCPeerConnection, gen: number): Promise<void> {
    const jitter = this.opts.jitterMs ?? 150;
    if (jitter > 0) await new Promise((r) => setTimeout(r, Math.random() * jitter));
    const current = () => !this.closed && e.pc === pc && gen === this.gen;
    if (!current()) return;
    const offer = await pc.createOffer();
    if (!current()) return;
    await pc.setLocalDescription(offer);
    if (!current()) return;
    this.signalTo(e, { kind: 'offer', sid: e.sid, sdp: pc.localDescription?.sdp ?? offer.sdp });
    this.armSessionTimer(e, pc);
    await this.settled(e, pc);
  }

  /** Espera o par conectar, falhar ou estourar o tempo, para liberar a vaga na fila. */
  private settled(e: Entry, pc: RTCPeerConnection): Promise<void> {
    if (pc.connectionState === 'connected') return Promise.resolve();
    e.settle?.();
    return new Promise<void>((resolve) => {
      const timer = setTimeout(done, NEGOTIATE_TIMEOUT_MS);
      function done() {
        clearTimeout(timer);
        if (e.settle === done) e.settle = undefined;
        resolve();
      }
      e.settle = done;
    });
  }

  private async answer(e: Entry, sdp: string, sid: number): Promise<void> {
    // Sem renegociação dentro de uma sessão: toda offer nova é uma sessão nova.
    if (e.remoteSet) this.recreate(e, 'retry');
    const pc = e.pc;
    // antes de qualquer await: candidatos que chegarem durante a negociação já são filtrados por ele
    e.sid = sid;
    await pc.setRemoteDescription({ type: 'offer', sdp });
    if (e.pc !== pc) return;
    this.adoptTransceivers(e, pc);
    await this.markRemoteSet(e, pc);
    const answer = await pc.createAnswer();
    if (e.pc !== pc) return;
    await pc.setLocalDescription(answer);
    if (e.pc !== pc) return;
    this.signalTo(e, { kind: 'answer', sid, sdp: pc.localDescription?.sdp ?? answer.sdp });
  }

  private async applyAnswer(e: Entry, sdp: string): Promise<void> {
    const pc = e.pc;
    if (pc.signalingState !== 'have-local-offer') return;
    await pc.setRemoteDescription({ type: 'answer', sdp });
    if (e.pc !== pc) return;
    await this.markRemoteSet(e, pc);
  }

  private async markRemoteSet(e: Entry, pc: RTCPeerConnection): Promise<void> {
    e.remoteSet = true;
    const queued = e.pending.filter((p) => p.sid === e.sid);
    e.pending = [];
    await Promise.all(queued.map((p) => pc.addIceCandidate(p.candidate).catch(noop)));
  }

  /** Envia em série por par, para a offer sempre chegar antes dos candidatos dela. */
  private signalTo(e: Entry, data: Omit<SignalData, 'gen'>): void {
    const full: SignalData = { gen: this.gen, ...data };
    e.sendChain = e.sendChain.then(() => this.opts.sendSignal(e.id, full)).catch(noop);
  }

  // --- mídia e canal -----------------------------------------------------

  private applyLocalTracks(e: Entry): void {
    for (const slot of SLOTS) e.tx[slot]?.sender.replaceTrack(this.local[slot]).catch(noop);
  }

  /** Quem responde: os transceivers criados pela offer (ordem das m-lines) viram sendrecv com nossos tracks. */
  private adoptTransceivers(e: Entry, pc: RTCPeerConnection): void {
    const created = pc.getTransceivers().filter((t) => t.mid !== null);
    SLOTS.forEach((slot, i) => {
      const t = created[i];
      if (!t) return;
      t.direction = 'sendrecv';
      e.tx[slot] = t;
    });
    this.applyLocalTracks(e);
  }

  private slotOf(e: Entry, transceiver: RTCRtpTransceiver): Slot | null {
    const byIdentity = SLOTS.find((s) => e.tx[s] === transceiver);
    if (byIdentity) return byIdentity;
    return SLOTS[e.pc.getTransceivers().indexOf(transceiver)] ?? null;
  }

  private attachChannel(e: Entry, channel: RTCDataChannel): void {
    e.channel = channel;
    channel.binaryType = 'arraybuffer';
    channel.onmessage = (ev) => {
      if (typeof ev.data === 'string' || ev.data instanceof ArrayBuffer) e.assembler.handle(ev.data);
    };
  }
}
