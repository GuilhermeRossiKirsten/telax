import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RoomEvent } from './types';
import { createSignalingClient, type JoinResult, type SignalingStatus } from './signaling-client';

type Handler = (call: number, url: URL, init: RequestInit) => Response | Promise<Response>;

const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const joinBody = (peerId: string, cursor = 5, token = `tok-${peerId}`) => ({
  peerId,
  token,
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

describe('re-join repetido (servidor que não lembra de nós)', () => {
  it('após 3 re-joins em 30 s para de tentar: status error, sem novos joins nem polls', async () => {
    let n = 0;
    const t = setup({
      join: () => ok(joinBody(`p${++n}`)),
      events: () => ok({ error: 'gone' }, 410),
    });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(t.joined).toHaveLength(4); // join inicial + 3 re-joins
    expect(t.statuses.at(-1)).toBe('error');
    const calls = t.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.calls).toHaveLength(calls);
    await expect(t.client.chat('oi')).rejects.toThrow('not joined');
  });

  it('410 esporádico (um a cada 40 s) continua reentrando normalmente', async () => {
    let last = -Infinity;
    const t = setup({
      join: (call) => ok(joinBody(`p${call}`)),
      events: () => {
        if (Date.now() - last < 40_000) return ok({ events: [], cursor: 5 });
        last = Date.now();
        return ok({ error: 'gone' }, 410);
      },
    });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(200_000);
    expect(t.joined.length).toBeGreaterThanOrEqual(5);
    expect(t.statuses).not.toContain('error');
    t.client.stop();
  });
});

describe('token', () => {
  it('o poll envia o token do join na query', async () => {
    const t = setup({ join: () => ok(joinBody('p1')), events: () => ok({ events: [], cursor: 5 }) });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(1000);
    const poll = t.calls.find((c) => c.route === 'events')!;
    expect(poll.url.searchParams.get('token')).toBe('tok-p1');
    t.client.stop();
  });

  it('onJoined não recebe o token', async () => {
    const t = setup({ join: () => ok(joinBody('p1')), events: () => ok({ events: [], cursor: 5 }) });
    await t.client.start();
    expect(t.joined[0][0]).not.toHaveProperty('token');
    expect(JSON.stringify(t.joined)).not.toContain('tok-p1');
    t.client.stop();
  });

  it('após 410 o re-join passa a usar o token novo no poll e nos POST', async () => {
    const t = setup({
      join: (call) => ok(joinBody(call === 1 ? 'p1' : 'p2', 5, call === 1 ? 'velho' : 'novo')),
      events: (call) => (call === 1 ? ok({ error: 'gone' }, 410) : ok({ events: [], cursor: 5 })),
      chat: () => ok({ ok: true }),
      leave: () => ok({ ok: true }),
    });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(1000); // 410 → re-join
    await vi.advanceTimersByTimeAsync(1000);
    await t.client.chat('oi');
    t.client.leave();
    const last = t.calls.filter((c) => c.route === 'events').at(-1)!;
    expect(last.url.searchParams.get('token')).toBe('novo');
    const body = (route: string) => JSON.parse(String(t.calls.find((c) => c.route === route)!.init.body));
    expect(body('chat')).toEqual({ from: 'p2', token: 'novo', text: 'oi' });
    expect(body('leave')).toEqual({ peerId: 'p2', token: 'novo' });
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

  it('stop durante um join pendente avisa leave do peerId e token recebidos e não notifica onJoined', async () => {
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
    expect(JSON.parse(String(call!.init.body))).toEqual({ peerId: 'p9', token: 'tok-p9' });
    expect(t.joined).toHaveLength(0);
  });

  it('leave envia o peerId e o token com keepalive', async () => {
    const t = setup({
      join: () => ok(joinBody('p1')),
      events: () => ok({ events: [], cursor: 5 }),
      leave: () => ok({ ok: true }),
    });
    await t.client.start();
    t.client.leave();
    const call = t.calls.find((c) => c.route === 'leave')!;
    expect(JSON.parse(String(call.init.body))).toEqual({ peerId: 'p1', token: 'tok-p1' });
    expect(call.init.keepalive).toBe(true);
    t.client.stop();
  });
});

describe('envio', () => {
  it('signal, chat, setState e restart postam com from = peerId e token; restart devolve gen', async () => {
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
    expect(body('signal')).toEqual({ from: 'p1', token: 'tok-p1', to: 'p2', data: { gen: 0, kind: 'offer', sdp: 'v=0' } });
    expect(body('chat')).toEqual({ from: 'p1', token: 'tok-p1', text: 'oi' });
    expect(body('state')).toEqual({ from: 'p1', token: 'tok-p1', audio: true, video: false, sharing: false });
    expect(body('restart')).toEqual({ from: 'p1', token: 'tok-p1' });
    t.client.stop();
  });

  it('setState envia screenSlots quando informado', async () => {
    const t = setup({ join: () => ok(joinBody('p1')), events: () => ok({ events: [], cursor: 5 }), state: () => ok({ ok: true }) });
    await t.client.start();
    await t.client.setState({ audio: true, video: true, sharing: true, screenSlots: 5 });
    expect(JSON.parse(String(t.calls.find((c) => c.route === 'state')!.init.body))).toEqual({
      from: 'p1',
      token: 'tok-p1',
      audio: true,
      video: true,
      sharing: true,
      screenSlots: 5,
    });
    t.client.stop();
  });
});

describe('espera longa (servidor segura a resposta)', () => {
  const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
  const pollsOf = (calls: Array<{ route: string; url: URL; at: number }>) => calls.filter((c) => c.route === 'events');

  it('o poll pede a espera longa: wait=8000', async () => {
    const t = setup({ join: () => ok(joinBody('p1')), events: () => ok({ events: [], cursor: 5 }) });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(pollsOf(t.calls)[0].url.searchParams.get('wait')).toBe('8000');
    t.client.stop();
  });

  it('resposta LENTA vazia (o servidor esperou): o próximo poll sai na hora, sem mais 1 s de espera', async () => {
    const t = setup({
      join: () => ok(joinBody('p1')),
      events: async () => {
        await sleep(8000); // o servidor segurou a resposta até o prazo
        return ok({ events: [], cursor: 5 });
      },
    });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(8000);
    const polls = pollsOf(t.calls);
    expect(polls.length).toBeGreaterThanOrEqual(2);
    const gap = polls[1].at - polls[0].at;
    expect(gap).toBeGreaterThanOrEqual(8000);
    expect(gap).toBeLessThan(8100); // com o piso antigo seria 9000
    t.client.stop();
  });

  it('resposta com EVENTOS: processa e faz o próximo poll na hora, com o cursor novo', async () => {
    const t = setup({
      join: () => ok(joinBody('p1', 5)),
      events: (call) => (call === 1 ? ok({ events: [ev(6), ev(7)], cursor: 7 }) : ok({ events: [], cursor: 7 })),
    });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(20);
    await vi.advanceTimersByTimeAsync(20);
    const polls = pollsOf(t.calls);
    expect(polls.length).toBeGreaterThanOrEqual(2);
    expect(polls[1].at - polls[0].at).toBeLessThan(50); // na hora (o piso seria 1000)
    expect(polls[1].url.searchParams.get('since')).toBe('7');
    expect(t.events.map((e) => e.seq)).toEqual([6, 7]);
    t.client.stop();
  });

  it('resposta RÁPIDA e vazia (servidor antigo que ignora wait): piso de 1 s, nunca um laço quente', async () => {
    const t = setup({ join: () => ok(joinBody('p1')), events: () => ok({ events: [], cursor: 5 }) });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(10_000);
    const polls = pollsOf(t.calls);
    expect(polls.length).toBeLessThanOrEqual(12);
    const gaps = polls.slice(1).map((c, i) => c.at - polls[i].at);
    expect(gaps.every((g) => g >= 1000)).toBe(true);
    t.client.stop();
  });

  it('stop aborta na hora o poll pendurado e não deixa nenhum timer vivo', async () => {
    let signal: AbortSignal | undefined;
    const t = setup({
      join: () => ok(joinBody('p1')),
      events: (_call, _url, init) =>
        new Promise<Response>((_, reject) => {
          signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
    });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(10); // poll pendurado (o servidor está esperando)
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    t.client.stop();
    expect(signal!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(vi.getTimerCount()).toBe(0);
    expect(t.statuses).not.toContain('reconnecting');
    expect(pollsOf(t.calls)).toHaveLength(1);
  });

  it('leave aborta o poll em andamento e isso não conta como falha de rede', async () => {
    let signal: AbortSignal | undefined;
    const t = setup({
      join: () => ok(joinBody('p1')),
      events: (_call, _url, init) =>
        new Promise<Response>((_, reject) => {
          signal = init.signal as AbortSignal;
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }),
      leave: () => ok({ ok: true }),
    });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(10);
    t.client.leave();
    expect(signal!.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.statuses).not.toContain('reconnecting');
    expect(t.calls.some((c) => c.route === 'leave')).toBe(true);
    t.client.stop();
  });
});

describe('envio em lote', () => {
  it('signals posta { from, token, items } em uma única requisição', async () => {
    const t = setup({ join: () => ok(joinBody('p1')), events: () => ok({ events: [], cursor: 5 }), signal: () => ok({ ok: true }) });
    await t.client.start();
    const items = [
      { to: 'p2', data: { gen: 0, kind: 'candidate' as const, sid: 1, candidate: { candidate: 'a' } } },
      { to: 'p3', data: { gen: 0, kind: 'candidate' as const, sid: 2, candidate: { candidate: 'b' } } },
    ];
    await t.client.signals(items);
    const posts = t.calls.filter((c) => c.route === 'signal');
    expect(posts).toHaveLength(1);
    expect(JSON.parse(String(posts[0].init.body))).toEqual({ from: 'p1', token: 'tok-p1', items });
    t.client.stop();
  });

  it('signals sem ter entrado rejeita com "not joined", como o signal', async () => {
    const t = setup({ join: () => new Promise<Response>(() => {}) });
    void t.client.start();
    await expect(t.client.signals([{ to: 'p2', data: { gen: 0, kind: 'reset' } }])).rejects.toThrow('not joined');
    t.client.stop();
  });
});

/** Como `setup`, mas aceitando opções extras (deviceId, observer) e registrando o fim "terminal" (bloqueado/removido). */
function setupWith(extra: Record<string, unknown>, handlers: Record<string, Handler>) {
  const { fn, calls } = makeFetch(handlers);
  const statuses: SignalingStatus[] = [];
  const ended: unknown[] = [];
  const joined: Array<[JoinResult, boolean]> = [];
  const client = createSignalingClient({
    room: 'sala',
    name: 'Ana',
    fetch: fn,
    pollMs: 1000,
    onJoined: (r, isRejoin) => joined.push([r, isRejoin]),
    onEvent: () => {},
    onStatus: (s) => statuses.push(s),
    onEnded: (info: unknown) => ended.push(info),
    ...extra,
  } as Parameters<typeof createSignalingClient>[0]);
  return { client, calls, statuses, ended, joined };
}

describe('identificação do dispositivo e do observador no join', () => {
  it('envia o deviceId no corpo do join e NÃO manda observer quando não é observador', async () => {
    const t = setupWith({ deviceId: '3f197123-2bf8-4730-aadf-6c61db50d59e' }, {
      join: () => ok(joinBody('p1')),
      events: () => ok({ events: [], cursor: 5 }),
    });
    await t.client.start();
    const body = JSON.parse(String(t.calls.find((c) => c.route === 'join')!.init.body));
    expect(body).toEqual({ name: 'Ana', deviceId: '3f197123-2bf8-4730-aadf-6c61db50d59e' });
    t.client.stop();
  });

  it('com observer: true o corpo leva observer: true (o servidor só aceita com sessão de admin)', async () => {
    const t = setupWith({ deviceId: 'd', observer: true }, {
      join: () => ok(joinBody('p1')),
      events: () => ok({ events: [], cursor: 5 }),
    });
    await t.client.start();
    const body = JSON.parse(String(t.calls.find((c) => c.route === 'join')!.init.body));
    expect(body).toMatchObject({ name: 'Ana', observer: true });
    t.client.stop();
  });

  it('sem deviceId o corpo continua só com o nome (compatível)', async () => {
    const t = setupWith({}, { join: () => ok(joinBody('p1')), events: () => ok({ events: [], cursor: 5 }) });
    await t.client.start();
    expect(JSON.parse(String(t.calls.find((c) => c.route === 'join')!.init.body))).toEqual({ name: 'Ana' });
    t.client.stop();
  });
});

describe('join bloqueado (banido, sala encerrada)', () => {
  it('403 banned → status blocked com motivo banned, sem polling e sem novas tentativas', async () => {
    const t = setupWith({}, { join: () => ok({ error: 'banned' }, 403), events: () => ok({ events: [], cursor: 0 }) });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.statuses).toEqual(['connecting', 'blocked']);
    expect(t.ended).toEqual([{ kind: 'blocked', reason: 'banned' }]);
    expect(t.calls.filter((c) => c.route === 'join')).toHaveLength(1);
    expect(t.calls.filter((c) => c.route === 'events')).toHaveLength(0);
  });

  it('403 room_closed leva o motivo do admin em detail', async () => {
    const t = setupWith({}, {
      join: () => ok({ error: 'room_closed', reason: 'Manutenção' }, 403),
      events: () => ok({ events: [], cursor: 0 }),
    });
    await t.client.start();
    expect(t.statuses.at(-1)).toBe('blocked');
    expect(t.ended).toEqual([{ kind: 'blocked', reason: 'closed', detail: 'Manutenção' }]);
  });

  it('403 forbidden (observador sem sessão de admin) vira erro e para', async () => {
    const t = setupWith({ observer: true }, { join: () => ok({ error: 'forbidden' }, 403), events: () => ok({ events: [], cursor: 0 }) });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(t.statuses.at(-1)).toBe('error');
    expect(t.calls.filter((c) => c.route === 'join')).toHaveLength(1);
  });

  it('403 de join com corpo ilegível não trava: vira erro', async () => {
    const t = setupWith({}, { join: () => new Response('<html>', { status: 403 }), events: () => ok({ events: [], cursor: 0 }) });
    await t.client.start();
    expect(t.statuses.at(-1)).toBe('error');
  });
});

describe('removido pelo admin (410 com motivo)', () => {
  for (const reason of ['kicked', 'banned', 'closed'] as const) {
    it(`410 ${reason} no poll → status removed, NUNCA reentra e para de consultar`, async () => {
      const t = setupWith({}, {
        join: () => ok(joinBody('p1')),
        events: () => ok({ error: 'gone', reason }, 410),
      });
      await t.client.start();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(t.statuses.at(-1)).toBe('removed');
      expect(t.ended).toEqual([{ kind: 'removed', reason }]);
      expect(t.calls.filter((c) => c.route === 'join')).toHaveLength(1); // não reentrou
      expect(t.calls.filter((c) => c.route === 'events')).toHaveLength(1); // não consultou de novo
    });
  }

  it('o texto do admin (detail) acompanha o motivo; sem texto não aparece a chave detail', async () => {
    const t = setupWith({}, {
      join: () => ok(joinBody('p1')),
      events: () => ok({ error: 'gone', reason: 'kicked', detail: 'conversa fora do assunto' }, 410),
    });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.ended).toEqual([{ kind: 'removed', reason: 'kicked', detail: 'conversa fora do assunto' }]);

    const u = setupWith({}, {
      join: () => ok(joinBody('p1')),
      events: () => ok({ error: 'gone', reason: 'kicked', detail: 123 }, 410), // lixo não vira texto
    });
    await u.client.start();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(u.ended).toEqual([{ kind: 'removed', reason: 'kicked' }]);
  });

  it('410 com motivo em um POST (chat) também remove e para o polling', async () => {
    const t = setupWith({}, {
      join: () => ok(joinBody('p1')),
      events: () => new Promise<Response>(() => {}), // poll pendurado (espera longa)
      chat: () => ok({ error: 'gone', reason: 'kicked' }, 410),
    });
    await t.client.start();
    await t.client.chat('oi');
    expect(t.statuses.at(-1)).toBe('removed');
    expect(t.ended).toEqual([{ kind: 'removed', reason: 'kicked' }]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(t.calls.filter((c) => c.route === 'join')).toHaveLength(1);
  });

  it('depois de removido, leave() não avisa o servidor (o peer já foi removido)', async () => {
    const t = setupWith({}, {
      join: () => ok(joinBody('p1')),
      events: () => ok({ error: 'gone', reason: 'banned' }, 410),
      leave: () => ok({ ok: true }),
    });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(10); // o primeiro poll acontece e recebe o 410 com motivo
    expect(t.statuses.at(-1)).toBe('removed');
    t.client.leave();
    expect(t.calls.filter((c) => c.route === 'leave')).toHaveLength(0);
  });

  it('410 SEM motivo (ou com motivo desconhecido) continua o fluxo de reentrada de sempre', async () => {
    for (const body of [{ error: 'gone' }, { error: 'gone', reason: 'x' }, { error: 'gone', reason: 5 }]) {
      const t = setupWith({}, {
        join: (call) => ok(joinBody(call === 1 ? 'p1' : 'p2')),
        events: (call, url) => (call === 1 ? ok(body, 410) : ok({ events: [], cursor: Number(url.searchParams.get('since')) })),
      });
      await t.client.start();
      await vi.advanceTimersByTimeAsync(2000);
      expect(t.joined.map(([r, rejoin]) => [r.peerId, rejoin])).toEqual([['p1', false], ['p2', true]]);
      expect(t.ended).toEqual([]);
      t.client.stop();
    }
  });

  it('410 com corpo ilegível também cai na reentrada comum', async () => {
    const t = setupWith({}, {
      join: (call) => ok(joinBody(call === 1 ? 'p1' : 'p2')),
      events: (call, url) =>
        call === 1 ? new Response('nada', { status: 410 }) : ok({ events: [], cursor: Number(url.searchParams.get('since')) }),
    });
    await t.client.start();
    await vi.advanceTimersByTimeAsync(2000);
    expect(t.joined).toHaveLength(2);
    t.client.stop();
  });
});
