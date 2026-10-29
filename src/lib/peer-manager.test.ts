import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PeerManager, type ConnState } from './peer-manager';
import type { SignalData } from './types';

class FakeTransceiver {
  mid: string | null = null;
  direction: RTCRtpTransceiverDirection = 'sendrecv';
  sender = {
    track: null as MediaStreamTrack | null,
    replaceTrack: vi.fn(async (t: MediaStreamTrack | null) => {
      this.sender.track = t;
    }),
  };
  constructor(public kind: 'audio' | 'video') {}
}

class FakeDC extends EventTarget {
  readyState: RTCDataChannelState = 'open';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  binaryType = 'blob';
  onmessage: ((e: { data: unknown }) => void) | null = null;
  sent: unknown[] = [];
  send = vi.fn((d: unknown) => void this.sent.push(d));
  close = vi.fn(() => {
    this.readyState = 'closed';
  });
}

class FakePC {
  static all: FakePC[] = [];
  transceivers: FakeTransceiver[] = [];
  signalingState = 'stable';
  connectionState = 'new';
  localDescription: { type: string; sdp: string } | null = null;
  remoteDescription: { type: string; sdp: string } | null = null;
  candidates: unknown[] = [];
  closed = false;
  dc: FakeDC | null = null;
  onicecandidate: ((e: unknown) => void) | null = null;
  ontrack: ((e: unknown) => void) | null = null;
  onconnectionstatechange: (() => void) | null = null;
  ondatachannel: ((e: { channel: FakeDC }) => void) | null = null;
  index = FakePC.all.length;

  constructor() {
    FakePC.all.push(this);
  }
  addTransceiver(kind: 'audio' | 'video') {
    const t = new FakeTransceiver(kind);
    this.transceivers.push(t);
    return t;
  }
  getTransceivers() {
    return this.transceivers;
  }
  createDataChannel() {
    this.dc = new FakeDC();
    return this.dc;
  }
  async createOffer() {
    return { type: 'offer', sdp: `offer-${this.index}` };
  }
  async createAnswer() {
    return { type: 'answer', sdp: `answer-${this.index}` };
  }
  async setLocalDescription(d: { type: string; sdp: string }) {
    this.localDescription = d;
    this.signalingState = d.type === 'offer' ? 'have-local-offer' : 'stable';
  }
  async setRemoteDescription(d: { type: string; sdp: string }) {
    this.remoteDescription = d;
    if (d.type === 'offer') {
      // Como o Chrome: transceivers de addTransceiver NÃO são reaproveitados; a offer cria novos, recvonly.
      (['audio', 'video', 'video', 'audio'] as const).forEach((kind, i) => {
        const t = new FakeTransceiver(kind);
        t.mid = String(i);
        t.direction = 'recvonly';
        this.transceivers.push(t);
      });
    }
    this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable';
  }
  async addIceCandidate(c: unknown) {
    this.candidates.push(c);
  }
  close() {
    this.closed = true;
    this.connectionState = 'closed';
  }
  setState(s: string) {
    this.connectionState = s;
    this.onconnectionstatechange?.();
  }
}

const flush = async () => {
  for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(0);
};
const track = (kind: string) => ({ kind }) as unknown as MediaStreamTrack;

function setup(selfId: string, gen = 0) {
  const signals: Array<{ to: string; data: SignalData }> = [];
  const states: Array<[string, ConnState]> = [];
  const remote: Array<[string, Record<string, MediaStreamTrack | undefined>]> = [];
  const files: Array<{ peerId: string; name: string }> = [];
  const manager = new PeerManager({
    selfId,
    gen,
    iceServers: [],
    jitterMs: 0,
    sendSignal: async (to, data) => void signals.push({ to, data }),
    onRemoteTracks: (id, t) => remote.push([id, t]),
    onConnState: (id, s) => states.push([id, s]),
    onFile: (peerId, f) => files.push({ peerId, name: f.header.name }),
    createPC: () => new FakePC() as unknown as RTCPeerConnection,
  });
  const offers = () => signals.filter((s) => s.data.kind === 'offer');
  return { manager, signals, states, remote, files, offers };
}

beforeEach(() => {
  FakePC.all = [];
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('criação do par', () => {
  it('cria 4 transceivers na ordem áudio, câmera, tela, áudio da tela', () => {
    const { manager } = setup('a');
    manager.addPeer('b');
    expect(FakePC.all[0].transceivers.map((t) => t.kind)).toEqual(['audio', 'video', 'video', 'audio']);
    manager.close();
  });

  it('quem só responde não cria transceivers antes da offer', () => {
    const { manager } = setup('b');
    manager.addPeer('a');
    expect(FakePC.all[0].transceivers).toHaveLength(0);
    manager.close();
  });

  it('quem responde adota os 4 transceivers da offer como sendrecv, com os tracks locais, antes da answer', async () => {
    const { manager, signals } = setup('b');
    const audio = track('audio');
    const camera = track('video');
    manager.setLocalTracks({ audio, camera, screen: null, screenAudio: null });
    manager.addPeer('a');
    await manager.handleSignal('a', { gen: 0, kind: 'offer', sid: 1, sdp: 'o' });
    const tx = FakePC.all[0].transceivers;
    expect(tx).toHaveLength(4);
    expect(tx.map((t) => t.direction)).toEqual(['sendrecv', 'sendrecv', 'sendrecv', 'sendrecv']);
    expect(tx.map((t) => t.sender.track)).toEqual([audio, camera, null, null]);
    expect(signals.at(-1)?.data.kind).toBe('answer');

    const screen = track('video');
    manager.setLocalTracks({ audio, camera, screen, screenAudio: null });
    await flush();
    expect(tx[2].sender.track).toBe(screen);
    manager.close();
  });

  it('o menor id oferece (com gen) e cria o DataChannel', async () => {
    const { manager, offers } = setup('a', 4);
    manager.addPeer('b');
    await flush();
    expect(offers()).toHaveLength(1);
    expect(offers()[0]).toMatchObject({ to: 'b', data: { gen: 4, kind: 'offer', sdp: 'offer-0' } });
    expect(FakePC.all[0].dc).not.toBeNull();
    manager.close();
  });

  it('o maior id não oferece: espera a offer, responde com answer e escuta o DataChannel', async () => {
    const { manager, signals, offers } = setup('b');
    manager.addPeer('a');
    await flush();
    expect(offers()).toHaveLength(0);
    expect(FakePC.all[0].ondatachannel).not.toBeNull();
    await manager.handleSignal('a', { gen: 0, kind: 'offer', sid: 1, sdp: 'o' });
    expect(FakePC.all[0].remoteDescription).toEqual({ type: 'offer', sdp: 'o' });
    expect(signals.at(-1)).toMatchObject({ to: 'a', data: { gen: 0, kind: 'answer', sdp: 'answer-0' } });
    manager.close();
  });

  it('repassa candidatos ICE locais como sinais', async () => {
    const { manager, signals } = setup('a');
    manager.addPeer('b');
    await flush();
    FakePC.all[0].onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'c1' }) } });
    FakePC.all[0].onicecandidate?.({ candidate: null });
    await flush();
    const cands = signals.filter((s) => s.data.kind === 'candidate');
    expect(cands).toHaveLength(1);
    expect(cands[0].data.candidate).toEqual({ candidate: 'c1' });
    manager.close();
  });

  it('o offerer aplica a answer recebida', async () => {
    const { manager, offers } = setup('a');
    manager.addPeer('b');
    await flush();
    await manager.handleSignal('b', { gen: 0, kind: 'answer', sid: offers().at(-1)!.data.sid, sdp: 'ans' });
    expect(FakePC.all[0].remoteDescription).toEqual({ type: 'answer', sdp: 'ans' });
    manager.close();
  });
});

describe('sinais', () => {
  it('descarta sinal de gen menor sem tocar no PC', async () => {
    const { manager } = setup('b', 2);
    manager.addPeer('a');
    await manager.handleSignal('a', { gen: 1, kind: 'offer', sid: 1, sdp: 'velho' });
    expect(FakePC.all[0].remoteDescription).toBeNull();
    manager.close();
  });

  it('candidato que chega antes da offer fica em fila e é aplicado depois', async () => {
    const { manager } = setup('b');
    manager.addPeer('a');
    await manager.handleSignal('a', { gen: 0, kind: 'candidate', sid: 1, candidate: { candidate: 'cedo' } });
    expect(FakePC.all[0].candidates).toHaveLength(0);
    await manager.handleSignal('a', { gen: 0, kind: 'offer', sid: 1, sdp: 'o' });
    expect(FakePC.all[0].candidates).toEqual([{ candidate: 'cedo' }]);
    manager.close();
  });

  it('gen futuro adota o gen e recria os pares', async () => {
    const { manager } = setup('b');
    manager.addPeer('a');
    await manager.handleSignal('a', { gen: 3, kind: 'offer', sid: 1, sdp: 'novo' });
    expect(FakePC.all[0].closed).toBe(true);
    expect(FakePC.all.at(-1)!.remoteDescription).toEqual({ type: 'offer', sdp: 'novo' });
    manager.close();
  });

  it('quem responde recria o PC a cada nova offer (sessão nova)', async () => {
    const { manager, signals } = setup('b');
    manager.addPeer('a');
    await manager.handleSignal('a', { gen: 0, kind: 'offer', sid: 1, sdp: 'o1' });
    await manager.handleSignal('a', { gen: 0, kind: 'offer', sid: 2, sdp: 'o2' });
    expect(FakePC.all).toHaveLength(2);
    expect(FakePC.all[0].closed).toBe(true);
    expect(FakePC.all[1].remoteDescription).toEqual({ type: 'offer', sdp: 'o2' });
    expect(signals.filter((s) => s.data.kind === 'answer')).toHaveLength(2);
    manager.close();
  });

  it('sinal de peer desconhecido cria o par', async () => {
    const { manager } = setup('b');
    await manager.handleSignal('a', { gen: 0, kind: 'offer', sid: 1, sdp: 'o' });
    expect(FakePC.all).toHaveLength(1);
    manager.close();
  });
});

describe('id de sessão (sid)', () => {
  it('offerer reabriu: answer com o sid antigo é ignorada, com o sid novo é aplicada', async () => {
    const { manager, offers } = setup('a');
    manager.addPeer('b');
    await flush();
    const oldSid = offers()[0].data.sid;
    // o answerer pediu reset: o offerer recria e reoferta (mesmo gen)
    await manager.handleSignal('b', { gen: 0, kind: 'reset' });
    await flush();
    expect(offers()).toHaveLength(2);
    const newSid = offers()[1].data.sid;
    await manager.handleSignal('b', { gen: 0, kind: 'answer', sid: oldSid, sdp: 'da-sessao-velha' });
    expect(FakePC.all[1].remoteDescription).toBeNull();
    await manager.handleSignal('b', { gen: 0, kind: 'answer', sid: newSid, sdp: 'da-sessao-nova' });
    expect(FakePC.all[1].remoteDescription).toEqual({ type: 'answer', sdp: 'da-sessao-nova' });
    manager.close();
  });

  it('candidato com sid diferente é descartado; com sid igual é aplicado', async () => {
    const { manager, offers } = setup('a');
    manager.addPeer('b');
    await flush();
    const sid = offers()[0].data.sid!;
    await manager.handleSignal('b', { gen: 0, kind: 'answer', sid, sdp: 'ans' });
    await manager.handleSignal('b', { gen: 0, kind: 'candidate', sid: sid + 1, candidate: { candidate: 'outro' } });
    await manager.handleSignal('b', { gen: 0, kind: 'candidate', candidate: { candidate: 'sem-sid' } });
    expect(FakePC.all[0].candidates).toHaveLength(0);
    await manager.handleSignal('b', { gen: 0, kind: 'candidate', sid, candidate: { candidate: 'meu' } });
    expect(FakePC.all[0].candidates).toEqual([{ candidate: 'meu' }]);
    manager.close();
  });

  it('quem responde ecoa o sid da offer na answer e nos candidatos locais', async () => {
    const { manager, signals } = setup('b');
    manager.addPeer('a');
    await manager.handleSignal('a', { gen: 0, kind: 'offer', sid: 42, sdp: 'o' });
    expect(signals.at(-1)!.data).toMatchObject({ kind: 'answer', sid: 42 });
    FakePC.all[0].onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'c1' }) } });
    await flush();
    expect(signals.at(-1)!.data).toMatchObject({ kind: 'candidate', sid: 42, candidate: { candidate: 'c1' } });
    manager.close();
  });

  it('quem responde ignora offer sem sid', async () => {
    const { manager, signals } = setup('b');
    manager.addPeer('a');
    await manager.handleSignal('a', { gen: 0, kind: 'offer', sdp: 'o' });
    expect(FakePC.all[0].remoteDescription).toBeNull();
    expect(signals).toHaveLength(0);
    manager.close();
  });

  it('candidato que chega antes da offer só é aplicado se o sid coincidir com o da offer', async () => {
    const { manager } = setup('b');
    manager.addPeer('a');
    await manager.handleSignal('a', { gen: 0, kind: 'candidate', sid: 5, candidate: { candidate: 'velho' } });
    await manager.handleSignal('a', { gen: 0, kind: 'candidate', sid: 6, candidate: { candidate: 'certo' } });
    await manager.handleSignal('a', { gen: 0, kind: 'candidate', candidate: { candidate: 'sem-sid' } });
    expect(FakePC.all[0].candidates).toHaveLength(0);
    await manager.handleSignal('a', { gen: 0, kind: 'offer', sid: 6, sdp: 'o' });
    expect(FakePC.all[0].candidates).toEqual([{ candidate: 'certo' }]);
    manager.close();
  });

  it('offerer: offer e candidatos levam o sid do PC corrente; PCs consecutivos têm sid diferentes', async () => {
    const { manager, signals, offers } = setup('a');
    manager.addPeer('b');
    await flush();
    FakePC.all[0].onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'c0' }) } });
    await flush();
    const sid0 = offers()[0].data.sid;
    expect(typeof sid0).toBe('number');
    expect(sid0).toBeGreaterThan(0);
    expect(signals.at(-1)!.data).toMatchObject({ kind: 'candidate', sid: sid0 });

    await manager.handleSignal('b', { gen: 0, kind: 'reset' });
    await flush();
    FakePC.all[1].onicecandidate?.({ candidate: { toJSON: () => ({ candidate: 'c1' }) } });
    await flush();
    const sid1 = offers()[1].data.sid;
    expect(typeof sid1).toBe('number');
    expect(sid1).not.toBe(sid0);
    expect(signals.at(-1)!.data).toMatchObject({ kind: 'candidate', sid: sid1 });
    manager.close();
  });
});

describe('mídia local e remota', () => {
  it('setLocalTracks faz replaceTrack nos 4 transceivers sem nova offer', async () => {
    const { manager, offers } = setup('a');
    manager.addPeer('b');
    await flush();
    const before = offers().length;
    const audio = track('audio');
    const camera = track('video');
    manager.setLocalTracks({ audio, camera, screen: null, screenAudio: null });
    await flush();
    const tx = FakePC.all[0].transceivers;
    expect(tx.map((t) => t.sender.track)).toEqual([audio, camera, null, null]);
    expect(offers()).toHaveLength(before);
    manager.close();
  });

  it('pares criados depois já nascem com os tracks locais', async () => {
    const { manager } = setup('a');
    const audio = track('audio');
    manager.setLocalTracks({ audio, camera: null, screen: null, screenAudio: null });
    manager.addPeer('b');
    await flush();
    expect(FakePC.all[0].transceivers[0].sender.track).toBe(audio);
    manager.close();
  });

  it('quem responde identifica câmera e tela pela ordem das m-lines da offer', async () => {
    const { manager, remote } = setup('b');
    manager.addPeer('a');
    await manager.handleSignal('a', { gen: 0, kind: 'offer', sid: 1, sdp: 'o' });
    const pc = FakePC.all[0];
    const cam = track('video');
    const scr = track('video');
    pc.ontrack?.({ track: cam, transceiver: pc.transceivers[1] });
    pc.ontrack?.({ track: scr, transceiver: pc.transceivers[2] });
    expect(remote.at(-1)).toEqual(['a', { camera: cam, screen: scr }]);
    manager.close();
  });

  it('ontrack identifica câmera e tela pelo transceiver', async () => {
    const { manager, remote } = setup('a');
    manager.addPeer('b');
    const pc = FakePC.all[0];
    const cam = track('video');
    const scr = track('video');
    pc.ontrack?.({ track: cam, transceiver: pc.transceivers[1] });
    pc.ontrack?.({ track: scr, transceiver: pc.transceivers[2] });
    expect(remote.at(-1)).toEqual(['b', { camera: cam, screen: scr }]);
    manager.close();
  });
});

describe('áudio da aba compartilhada', () => {
  it('o áudio da tela sai pelo 4º transceiver, junto com a tela, sem nova offer', async () => {
    const { manager, offers } = setup('a');
    manager.addPeer('b');
    await flush();
    const before = offers().length;
    const audio = track('audio');
    const screen = track('video');
    const screenAudio = track('audio');
    manager.setLocalTracks({ audio, camera: null, screen, screenAudio });
    await flush();
    const tx = FakePC.all[0].transceivers;
    expect(tx.map((t) => t.sender.track)).toEqual([audio, null, screen, screenAudio]);
    expect(offers()).toHaveLength(before);
    manager.setLocalTracks({ audio, camera: null, screen: null, screenAudio: null });
    await flush();
    expect(tx[3].sender.track).toBeNull();
    manager.close();
  });

  it('o áudio remoto da tela chega separado do microfone, nos dois papéis', async () => {
    const offerer = setup('a');
    offerer.manager.addPeer('b');
    const pcA = FakePC.all[0];
    const mic = track('audio');
    const tab = track('audio');
    pcA.ontrack?.({ track: mic, transceiver: pcA.transceivers[0] });
    pcA.ontrack?.({ track: tab, transceiver: pcA.transceivers[3] });
    expect(offerer.remote.at(-1)).toEqual(['b', { audio: mic, screenAudio: tab }]);
    offerer.manager.close();

    const answerer = setup('b');
    answerer.manager.addPeer('a');
    await answerer.manager.handleSignal('a', { gen: 0, kind: 'offer', sid: 1, sdp: 'o' });
    const pcB = FakePC.all[1];
    const tab2 = track('audio');
    pcB.ontrack?.({ track: tab2, transceiver: pcB.transceivers[3] });
    expect(answerer.remote.at(-1)).toEqual(['a', { screenAudio: tab2 }]);
    answerer.manager.close();
  });
});

describe('reinício global', () => {
  it('restartAll fecha os PCs antigos e só o offerer reoferta', async () => {
    const off = setup('a');
    off.manager.addPeer('b');
    await flush();
    off.manager.restartAll(1);
    await flush();
    expect(FakePC.all[0].closed).toBe(true);
    expect(FakePC.all).toHaveLength(2);
    expect(off.offers().at(-1)).toMatchObject({ to: 'b', data: { gen: 1, sdp: 'offer-1' } });
    off.manager.close();

    FakePC.all = [];
    const ans = setup('b');
    ans.manager.addPeer('a');
    await flush();
    ans.manager.restartAll(1);
    await flush();
    expect(FakePC.all).toHaveLength(2);
    expect(ans.offers()).toHaveLength(0);
    ans.manager.close();
  });

  it('nunca há mais de 2 renegociações simultâneas', async () => {
    const { manager, offers } = setup('a');
    for (const id of ['b', 'c', 'd', 'e', 'f']) manager.addPeer(id);
    await flush();
    expect(offers()).toHaveLength(2);
    FakePC.all[0].setState('connected');
    FakePC.all[1].setState('connected');
    await flush();
    expect(offers()).toHaveLength(4);
    FakePC.all[2].setState('connected');
    await flush();
    expect(offers()).toHaveLength(5);
    manager.close();
  });

  it('dois restartAll seguidos convergem para o maior gen e descartam o menor', async () => {
    const { manager, offers } = setup('a');
    manager.addPeer('b');
    await flush();
    manager.restartAll(1);
    manager.restartAll(2);
    await flush();
    expect(offers().filter((o) => o.data.gen === 1)).toHaveLength(0);
    expect(offers().at(-1)!.data.gen).toBe(2);
    await manager.handleSignal('b', { gen: 1, kind: 'answer', sid: offers().at(-1)!.data.sid, sdp: 'velha' });
    expect(FakePC.all.at(-1)!.remoteDescription).toBeNull();
    await manager.handleSignal('b', { gen: 2, kind: 'answer', sid: offers().at(-1)!.data.sid, sdp: 'nova' });
    expect(FakePC.all.at(-1)!.remoteDescription).toEqual({ type: 'answer', sdp: 'nova' });
    manager.restartAll(2); // repetido: ignorado
    expect(FakePC.all).toHaveLength(3);
    manager.close();
  });
});

describe('reconexão automática', () => {
  it('failed → reporta failed e reabre o par com backoff de 1 s', async () => {
    const { manager, states, offers } = setup('a');
    manager.addPeer('b');
    await flush();
    FakePC.all[0].setState('failed');
    expect(states.at(-1)).toEqual(['b', 'failed']);
    await vi.advanceTimersByTimeAsync(999);
    expect(FakePC.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await flush();
    expect(FakePC.all).toHaveLength(2);
    expect(FakePC.all[0].closed).toBe(true);
    expect(offers()).toHaveLength(2);
    manager.close();
  });

  it('disconnected por mais de 5 s reabre; se voltar antes, não', async () => {
    const { manager, states } = setup('a');
    manager.addPeer('b');
    await flush();
    FakePC.all[0].setState('connected');
    FakePC.all[0].setState('disconnected');
    expect(states.at(-1)).toEqual(['b', 'reconnecting']);
    await vi.advanceTimersByTimeAsync(4999);
    expect(FakePC.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakePC.all).toHaveLength(2);

    FakePC.all[1].setState('connected');
    FakePC.all[1].setState('disconnected');
    await vi.advanceTimersByTimeAsync(3000);
    FakePC.all[1].setState('connected');
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakePC.all).toHaveLength(2);
    manager.close();
  });

  it('quem responde reabre e pede nova offer com reset; o offerer reoferta ao receber', async () => {
    const ans = setup('b');
    ans.manager.addPeer('a');
    await flush();
    FakePC.all[0].setState('failed');
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakePC.all).toHaveLength(2);
    expect(ans.signals.at(-1)).toMatchObject({ to: 'a', data: { kind: 'reset' } });
    ans.manager.close();

    FakePC.all = [];
    const off = setup('a');
    off.manager.addPeer('b');
    await flush();
    await off.manager.handleSignal('b', { gen: 0, kind: 'reset' });
    await flush();
    expect(FakePC.all).toHaveLength(2);
    expect(off.offers()).toHaveLength(2);
    off.manager.close();
  });
});

describe('watchdog de sessão', () => {
  it('offerer com offer sem resposta por 20 s → failed, e após o backoff cria PC novo e reoferta', async () => {
    const { manager, states, offers } = setup('a');
    manager.addPeer('b');
    await flush();
    expect(offers()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(19_999);
    expect(states.at(-1)).toEqual(['b', 'connecting']);
    await vi.advanceTimersByTimeAsync(1);
    expect(states.at(-1)).toEqual(['b', 'failed']);
    expect(FakePC.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(FakePC.all).toHaveLength(2);
    expect(FakePC.all[0].closed).toBe(true);
    expect(offers()).toHaveLength(2);
    expect(offers().at(-1)!.data.sdp).toBe('offer-1');
    manager.close();
  });

  it('offerer que ainda espera a vez na fila não estoura o watchdog antes de enviar a offer', async () => {
    const { manager, states, offers } = setup('a');
    for (const id of ['b', 'c', 'd']) manager.addPeer(id); // fila de 2: b e c ofertam agora, d espera
    await flush();
    expect(offers().map((o) => o.to)).toEqual(['b', 'c']);
    await vi.advanceTimersByTimeAsync(8000); // as vagas de b e c expiram e d finalmente oferta
    await flush();
    expect(offers().map((o) => o.to)).toContain('d');
    await vi.advanceTimersByTimeAsync(17_000); // t = 25 s: b e c passaram dos 20 s, d só tem 17 s desde a offer
    const failed = (id: string) => states.filter(([p, s]) => p === id && s === 'failed').length;
    expect(failed('b')).toBe(1);
    expect(failed('c')).toBe(1);
    expect(failed('d')).toBe(0);
    manager.close();
  });

  it('quem responde sem receber offer por 20 s → failed, reabre e envia reset', async () => {
    const { manager, states, signals } = setup('b');
    manager.addPeer('a');
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(states.at(-1)).toEqual(['a', 'failed']);
    await vi.advanceTimersByTimeAsync(1000);
    await flush();
    expect(FakePC.all).toHaveLength(2);
    expect(FakePC.all[0].closed).toBe(true);
    expect(signals.at(-1)).toMatchObject({ to: 'a', data: { kind: 'reset' } });
    manager.close();
  });

  it('par que conecta antes de 20 s não é reaberto', async () => {
    const { manager, states, offers } = setup('a');
    manager.addPeer('b');
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    FakePC.all[0].setState('connected');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakePC.all).toHaveLength(1);
    expect(offers()).toHaveLength(1);
    expect(states.some(([, s]) => s === 'failed')).toBe(false);
    manager.close();
  });

  it('close e removePeer cancelam o watchdog', async () => {
    const a = setup('a');
    a.manager.addPeer('b');
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    a.manager.close();
    const n = a.signals.length;
    const s = a.states.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakePC.all).toHaveLength(1);
    expect(a.signals.length).toBe(n);
    expect(a.states.length).toBe(s);

    FakePC.all = [];
    const b = setup('b');
    b.manager.addPeer('a');
    await flush();
    await vi.advanceTimersByTimeAsync(10_000);
    b.manager.removePeer('a');
    const m = b.signals.length;
    const t = b.states.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakePC.all).toHaveLength(1);
    expect(b.signals.length).toBe(m);
    expect(b.states.length).toBe(t);
    b.manager.close();
  });

  it('duas sessões presas seguidas usam backoff crescente (1 s, depois 2 s)', async () => {
    const { manager, states } = setup('a');
    manager.addPeer('b');
    await flush();
    await vi.advanceTimersByTimeAsync(20_000);
    await vi.advanceTimersByTimeAsync(999);
    expect(FakePC.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakePC.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(states.at(-1)).toEqual(['b', 'failed']);
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakePC.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakePC.all).toHaveLength(3);
    manager.close();
  });
});

describe('arquivos', () => {
  it('mensagens do DataChannel viram onFile e sendFileToAll usa o canal aberto', async () => {
    const { manager, files } = setup('a');
    manager.addPeer('b');
    await flush();
    const dc = FakePC.all[0].dc!;
    dc.onmessage?.({ data: JSON.stringify({ type: 'file-start', header: { id: 'x', name: 'f.txt', size: 2, mime: 'text/plain' } }) });
    dc.onmessage?.({ data: new Uint8Array([1, 2]).buffer });
    dc.onmessage?.({ data: JSON.stringify({ type: 'file-end', id: 'x' }) });
    expect(files).toEqual([{ peerId: 'b', name: 'f.txt' }]);

    await manager.sendFileToAll(new File([new Uint8Array(10)], 'saida.bin'));
    expect(dc.sent.length).toBeGreaterThanOrEqual(3);
    manager.close();
  });

  it('sendFileToAll sem nenhum canal aberto rejeita', async () => {
    const { manager } = setup('a');
    await expect(manager.sendFileToAll(new File([new Uint8Array(1)], 'x'))).rejects.toThrow('no_open_channel');
    manager.close();
  });
});

describe('limpeza', () => {
  it('removePeer fecha PC e canal e solta todos os handlers', async () => {
    const { manager, states } = setup('a');
    manager.addPeer('b');
    await flush();
    const pc = FakePC.all[0];
    const dc = pc.dc!;
    manager.removePeer('b');
    expect(pc.closed).toBe(true);
    expect(dc.close).toHaveBeenCalled();
    expect(pc.onicecandidate).toBeNull();
    expect(pc.ontrack).toBeNull();
    expect(pc.onconnectionstatechange).toBeNull();
    expect(pc.ondatachannel).toBeNull();
    expect(dc.onmessage).toBeNull();
    const count = states.length;
    pc.setState('failed');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(states.length).toBe(count);
    expect(FakePC.all).toHaveLength(1);
  });

  it('close encerra todos os pares, cancela timers e ignora chamadas posteriores', async () => {
    const { manager, signals } = setup('a');
    manager.addPeer('b');
    manager.addPeer('c');
    await flush();
    FakePC.all[0].setState('failed');
    manager.close();
    expect(FakePC.all.every((p) => p.closed)).toBe(true);
    const n = signals.length;
    await vi.advanceTimersByTimeAsync(60_000);
    manager.addPeer('d');
    await manager.handleSignal('c', { gen: 0, kind: 'candidate', sid: 1, candidate: { candidate: 'x' } });
    await flush();
    expect(FakePC.all).toHaveLength(2);
    expect(signals.length).toBe(n);
  });
});
