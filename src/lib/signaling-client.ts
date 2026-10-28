import type { PeerInfo, PeerMediaState, RoomEvent, SignalData } from './types';

export const POLL_MS = 1000;
const MAX_BACKOFF_MS = 5000;

export type SignalingStatus = 'connecting' | 'online' | 'reconnecting' | 'full' | 'error';

export type JoinResult = {
  peerId: string;
  participants: PeerInfo[];
  gen: number;
  iceServers: RTCIceServer[];
};

export type SignalingHandlers = {
  onJoined(result: JoinResult, isRejoin: boolean): void;
  onEvent(event: RoomEvent): void;
  onStatus(status: SignalingStatus): void;
};

type Options = SignalingHandlers & {
  room: string;
  name: string;
  fetch?: typeof fetch;
  pollMs?: number;
};

export function createSignalingClient(opts: Options) {
  const doFetch: typeof fetch = opts.fetch ?? ((input, init) => fetch(input, init));
  const pollMs = opts.pollMs ?? POLL_MS;
  const base = `/api/rooms/${encodeURIComponent(opts.room)}`;

  let peerId: string | null = null;
  /** Segredo devolvido pelo join; autentica todo POST e o poll. Nunca sai deste módulo. */
  let token = '';
  let cursor = 0;
  let failures = 0;
  let hasJoined = false;
  let stopped = false;
  let status: SignalingStatus | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const abort = new AbortController();

  function setStatus(next: SignalingStatus) {
    if (next === status) return;
    status = next;
    opts.onStatus(next);
  }

  /** Devolve false se a sala está cheia (polling deve parar). */
  async function join(): Promise<boolean> {
    // Sem AbortSignal de propósito: abortar um join em voo deixaria um participante fantasma
    // no servidor sem que saibamos o peerId para removê-lo.
    const res = await doFetch(`${base}/join`, { method: 'POST', body: JSON.stringify({ name: opts.name }) });
    if (res.status === 409) {
      if (!stopped) setStatus('full');
      return false;
    }
    if (!res.ok) throw new Error(`join ${res.status}`);
    const body = (await res.json()) as JoinResult & { cursor: number; token: string };
    if (stopped) {
      sendLeave(body.peerId, body.token);
      return true;
    }
    peerId = body.peerId;
    token = body.token;
    cursor = body.cursor;
    const isRejoin = hasJoined;
    hasJoined = true;
    failures = 0;
    setStatus('online');
    opts.onJoined(
      { peerId: body.peerId, participants: body.participants, gen: body.gen, iceServers: body.iceServers },
      isRejoin,
    );
    return true;
  }

  async function poll(): Promise<boolean> {
    const url = `${base}/events?peerId=${encodeURIComponent(peerId!)}&token=${encodeURIComponent(token)}&since=${cursor}`;
    const res = await doFetch(url, { signal: abort.signal });
    if (stopped) return true;
    if (res.status === 410) {
      peerId = null;
      return join();
    }
    if (!res.ok) throw new Error(`events ${res.status}`);
    const body = (await res.json()) as { events: RoomEvent[]; cursor: number };
    if (stopped) return true;
    cursor = body.cursor;
    if (failures > 0) {
      failures = 0;
      setStatus('online');
    }
    for (const event of body.events) opts.onEvent(event);
    return true;
  }

  function sendLeave(id: string, tok: string) {
    doFetch(`${base}/leave`, { method: 'POST', body: JSON.stringify({ peerId: id, token: tok }), keepalive: true }).catch(
      () => {},
    );
  }

  function schedule() {
    if (stopped) return;
    const delay = failures === 0 ? pollMs : Math.min(pollMs * 2 ** failures, MAX_BACKOFF_MS);
    timer = setTimeout(tick, delay);
  }

  async function step(): Promise<boolean> {
    try {
      return peerId ? await poll() : await join();
    } catch {
      if (stopped) return true;
      failures += 1;
      setStatus('reconnecting');
      return true;
    }
  }

  async function tick() {
    timer = undefined;
    if (stopped) return;
    if (await step()) schedule();
  }

  async function post(path: string, body: Record<string, unknown>): Promise<Response> {
    if (!peerId) throw new Error('not joined');
    return doFetch(`${base}/${path}`, { method: 'POST', body: JSON.stringify({ from: peerId, token, ...body }) });
  }

  return {
    async start() {
      setStatus('connecting');
      if (await step()) schedule();
    },

    stop() {
      stopped = true;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      abort.abort();
    },

    async signal(to: string, data: SignalData) {
      await post('signal', { to, data });
    },

    async chat(text: string) {
      await post('chat', { text });
    },

    async setState(state: PeerMediaState) {
      await post('state', { ...state });
    },

    async restart(): Promise<number> {
      const res = await post('restart', {});
      if (!res.ok) throw new Error(`restart ${res.status}`);
      return ((await res.json()) as { gen: number }).gen;
    },

    /** Avisa o servidor que saímos; usa keepalive para sobreviver ao fechamento da aba. */
    leave() {
      if (peerId) sendLeave(peerId, token);
    },
  };
}
