import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomEvent } from './types';
import { createSignalingClient, type JoinResult, type SignalingStatus } from './signaling-client';

type Handler = (call: number, url: URL, init: RequestInit) => Response | Promise<Response>;

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const joinBody = (peerId: string, cursor = 5) => ({
  peerId,
  participants: [],
  cursor,
  gen: 0,
  iceServers: [],
});
const ev = (seq: number): RoomEvent => ({ seq, type: 'chat', from: 'x', payload: { text: `m${seq}` } });

/** fetch falso: cada rota ('join', 'events', ...) tem um handler que recebe o nº da chamada. */
function makeFetch(handlers: Record<string, Handler>) {
  const counts: Record<string, number> = {};
  const calls: Array<{ route: string; url: URL; init: RequestInit; at: number }> = [];
  const fn = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = new URL(String(input), 'http://t');
    const route = url.pathname.split('/').pop()!;
    counts[route] = (counts[route] ?? 0) + 1;
    calls.push({ route, url, init, at: Date.now() });
    const handler = handlers[route];
    if (!handler) throw new Error(`sem handler para ${route}`);
    return handler(counts[route], url, init);
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

function setup(handlers: Record<string, Handler>, pollMs = 1000) {
  const { fn, calls } = makeFetch(handlers);
  const statuses: SignalingStatus[] = [];
  const joined: Array<[JoinResult, boolean]> = [];
  const events: RoomEvent[] = [];
  const client = createSignalingClient({
    room: 'sala',
    name: 'Ana',
    fetch: fn,
    pollMs,
    onJoined: (r, isRejoin) => joined.push([r, isRejoin]),
    onEvent: (e) => events.push(e),
    onStatus: (s) => statuses.push(s),
  });
  return { client, calls, statuses, joined, events };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('start', () => {
  it('faz join, chama onJoined(…, false) e fica online', async () => {
    const t = setup({ join: () => ok(joinBody('p1')), events: () => ok({ events: [], cursor: 5 }) });
    await t.client.start();
    expect(t.joined).toHaveLength(1);
    expect(t.joined[0][0].peerId).toBe('p1');
    expect(t.joined[0][1]).toBe(false);
    expect(t.statuses).toEqual(['connecting', 'online']);
    t.client.stop();
  });

  it('join com 409 → status full e nenhum polling', async () => {
    const t = setup({ join: () => ok({ error: 'room_full' }, 409), events: () => ok({ events: [], cursor: 0 }) });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(5000);
    expect(t.statuses).toContain('full');
    expect(t.calls.filter((c) => c.route === 'events')).toHaveLength(0);
  });
});

describe('polling', () => {
  it('consulta events desde o cursor e repassa os eventos em ordem', async () => {
    const t = setup({
      join: () => ok(joinBody('p1', 5)),
      events: (call) => (call === 1 ? ok({ events: [ev(6), ev(7)], cursor: 7 }) : ok({ events: [], cursor: 7 })),
    });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    const polls = t.calls.filter((c) => c.route === 'events');
    expect(polls[0].url.searchParams.get('since')).toBe('5');
    expect(polls[0].url.searchParams.get('peerId')).toBe('p1');
    expect(polls[1].url.searchParams.get('since')).toBe('7');
    expect(t.events.map((e) => e.seq)).toEqual([6, 7]);
    t.client.stop();
  });

  it('falha de rede → reconnecting com backoff até 5 s e volta a online', async () => {
    const t = setup({
      join: () => ok(joinBody('p1')),
      events: (call) => {
        if (call <= 3) throw new TypeError('network');
        return ok({ events: [], cursor: 5 });
      },
    });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(30_000);
    const times = t.calls.filter((c) => c.route === 'events').map((c) => c.at);
    const gaps = times.slice(1, 5).map((x, i) => x - times[i]);
    expect(gaps).toEqual([2000, 4000, 5000, 1000]);
    expect(t.statuses).toContain('reconnecting');
    expect(t.statuses.at(-1)).toBe('online');
    t.client.stop();
  });

  it('410 → novo join e onJoined(…, true), e o poll seguinte usa o novo peerId', async () => {
    const t = setup({
      join: (call) => ok(joinBody(call === 1 ? 'p1' : 'p2', call === 1 ? 5 : 40)),
      events: (call, url) =>
        call === 1 ? ok({ error: 'gone' }, 410) : ok({ events: [], cursor: Number(url.searchParams.get('since')) }),
    });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(t.joined.map(([r, rejoin]) => [r.peerId, rejoin])).toEqual([
      ['p1', false],
      ['p2', true],
    ]);
    const polls = t.calls.filter((c) => c.route === 'events');
    const last = polls.at(-1)!;
    expect(last.url.searchParams.get('peerId')).toBe('p2');
    expect(last.url.searchParams.get('since')).toBe('40');
    t.client.stop();
  });
});

describe('stop e leave', () => {
  it('stop cancela o timer e ignora resposta pendente', async () => {
    let release!: (r: Response) => void;
    const t = setup({
      join: () => ok(joinBody('p1')),
      events: () => new Promise<Response>((resolve) => (release = resolve)),
    });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(1000); // poll em andamento
    t.client.stop();
    release(ok({ events: [ev(6)], cursor: 6 }));
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.events).toHaveLength(0);
    expect(t.calls.filter((c) => c.route === 'events')).toHaveLength(1);
  });

  it('stop durante um join pendente avisa leave do peerId recebido e não notifica onJoined', async () => {
    let release!: (r: Response) => void;
    const t = setup({
      join: () => new Promise<Response>((resolve) => (release = resolve)),
      leave: () => ok({ ok: true }),
    });
    const started = t.client.start();
    t.client.stop();
    release(ok(joinBody('p9')));
    await started;
    const call = t.calls.find((c) => c.route === 'leave');
    expect(call).toBeDefined();
    expect(JSON.parse(String(call!.init.body))).toEqual({ peerId: 'p9' });
    expect(t.joined).toHaveLength(0);
  });

  it('leave envia o peerId com keepalive', async () => {
    const t = setup({
      join: () => ok(joinBody('p1')),
      events: () => ok({ events: [], cursor: 5 }),
      leave: () => ok({ ok: true }),
    });
    await t.client.start();
    t.client.leave();
    const call = t.calls.find((c) => c.route === 'leave')!;
    expect(JSON.parse(String(call.init.body))).toEqual({ peerId: 'p1' });
    expect(call.init.keepalive).toBe(true);
    t.client.stop();
  });
});

describe('envio', () => {
  it('signal, chat, setState e restart postam com from = peerId; restart devolve gen', async () => {
    const t = setup({
      join: () => ok(joinBody('p1')),
      events: () => ok({ events: [], cursor: 5 }),
      signal: () => ok({ ok: true }),
      chat: () => ok({ ok: true }),
      state: () => ok({ ok: true }),
      restart: () => ok({ gen: 3 }),
    });
    await t.client.start();
    await t.client.signal('p2', { gen: 0, kind: 'offer', sdp: 'v=0' });
    await t.client.chat('oi');
    await t.client.setState({ audio: true, video: false, sharing: false });
    expect(await t.client.restart()).toBe(3);
    const body = (route: string) => JSON.parse(String(t.calls.find((c) => c.route === route)!.init.body));
    expect(body('signal')).toEqual({ from: 'p1', to: 'p2', data: { gen: 0, kind: 'offer', sdp: 'v=0' } });
    expect(body('chat')).toEqual({ from: 'p1', text: 'oi' });
    expect(body('state')).toEqual({ from: 'p1', audio: true, video: false, sharing: false });
    expect(body('restart')).toEqual({ from: 'p1' });
    t.client.stop();
  });
});
