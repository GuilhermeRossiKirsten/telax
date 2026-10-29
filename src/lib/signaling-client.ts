import type { PeerInfo, PeerMediaState, RoomEvent, SignalData } from './types';

/** Espera mínima entre polls quando o servidor NÃO segurou a resposta (servidor antigo, ou erro rápido). */
export const POLL_MS = 1000;
/** Quanto o servidor pode segurar a resposta de /events esperando um evento (cada poll vira UMA invocação a cada ~8 s). */
export const POLL_WAIT_MS = 8000;
/** Uma resposta vazia que voltou antes disto não foi uma espera de verdade: aplica o piso para não formar laço quente. */
const FAST_RESPONSE_MS = 250;
const MAX_BACKOFF_MS = 5000;
/**
 * Re-joins seguidos (410) significam que o servidor não guarda a sala entre requisições, ex.: várias
 * instâncias serverless sem memória compartilhada. Reentrar sem parar só cria participantes fantasma.
 */
export const MAX_REJOINS = 3;
export const REJOIN_WINDOW_MS = 30_000;

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
  let rejoinTimes: number[] = [];
  let stopped = false;
  let status: SignalingStatus | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Controlador do poll em andamento: stop() e leave() o cancelam na hora (um poll pode estar pendurado por até 8 s). */
  let pollCtl: AbortController | undefined;
  /** Como foi o último poll bem-sucedido (null depois de um join): decide se o próximo sai já ou espera o piso. */
  let lastPoll: { elapsed: number; hadEvents: boolean } | null = null;

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
    lastPoll = null;
    setStatus('online');
    opts.onJoined(
      { peerId: body.peerId, participants: body.participants, gen: body.gen, iceServers: body.iceServers },
      isRejoin,
    );
    return true;
  }

  async function poll(): Promise<boolean> {
    const url = `${base}/events?peerId=${encodeURIComponent(peerId!)}&token=${encodeURIComponent(token)}&since=${cursor}&wait=${POLL_WAIT_MS}`;
    const ctl = (pollCtl = new AbortController());
    const startedAt = Date.now();
    let res: Response;
    let body: { events: RoomEvent[]; cursor: number } | null = null;
    try {
      res = await doFetch(url, { signal: ctl.signal });
      if (stopped) return true;
      if (res.ok) body = (await res.json()) as { events: RoomEvent[]; cursor: number };
    } catch (e) {
      // cancelado por stop() ou leave(): não é falha de rede
      if (ctl.signal.aborted) return true;
      throw e;
    } finally {
      if (pollCtl === ctl) pollCtl = undefined;
    }
    if (stopped) return true;
    if (res.status === 410) {
      peerId = null;
      const now = Date.now();
      rejoinTimes = rejoinTimes.filter((t) => now - t < REJOIN_WINDOW_MS);
      if (rejoinTimes.length >= MAX_REJOINS) {
        setStatus('error');
        return false;
      }
      rejoinTimes.push(now);
      return join();
    }
    if (!res.ok || !body) throw new Error(`events ${res.status}`);
    cursor = body.cursor;
    if (failures > 0) {
      failures = 0;
      setStatus('online');
    }
    lastPoll = { elapsed: Date.now() - startedAt, hadEvents: body.events.length > 0 };
    for (const event of body.events) opts.onEvent(event);
    return true;
  }

  function sendLeave(id: string, tok: string) {
    doFetch(`${base}/leave`, { method: 'POST', body: JSON.stringify({ peerId: id, token: tok }), keepalive: true }).catch(
      () => {},
    );
  }

  /**
   * Quando sai o próximo passo. Com a espera longa é o SERVIDOR quem espera, então depois de uma resposta que
   * trouxe eventos, ou que demorou (o servidor segurou), o próximo poll sai na hora. Resposta rápida e vazia
   * (servidor que ignora `wait`, ou erro rápido) cai no piso de `pollMs`; falhas seguem o backoff.
   */
  function nextDelay(): number {
    if (failures > 0) return Math.min(pollMs * 2 ** failures, MAX_BACKOFF_MS);
    if (lastPoll === null) return 0; // recém-entrou: começa a espera longa já
    return lastPoll.hadEvents || lastPoll.elapsed >= FAST_RESPONSE_MS ? 0 : pollMs;
  }

  function schedule() {
    if (stopped) return;
    timer = setTimeout(tick, nextDelay());
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
      pollCtl?.abort();
    },

    async signal(to: string, data: SignalData) {
      await post('signal', { to, data });
    },

    /** Vários sinais (ex.: candidatos ICE) numa única requisição: cada requisição é uma invocação da função. */
    async signals(items: Array<{ to: string; data: SignalData }>) {
      await post('signal', { items });
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
      pollCtl?.abort(); // não deixa um poll pendurado por 8 s depois de sair
    },
  };
}
