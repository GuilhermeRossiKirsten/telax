import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/** Só para teste: registra as RTCPeerConnection criadas pela página para podermos inspecioná-las. */
const TRACK_PCS = () => {
  const w = window as unknown as { __pcs: RTCPeerConnection[]; RTCPeerConnection: typeof RTCPeerConnection };
  w.__pcs = [];
  const Orig = w.RTCPeerConnection;
  w.RTCPeerConnection = function (this: unknown, ...args: ConstructorParameters<typeof RTCPeerConnection>) {
    const pc = new Orig(...args);
    w.__pcs.push(pc);
    return pc;
  } as unknown as typeof RTCPeerConnection;
  w.RTCPeerConnection.prototype = Orig.prototype;
};

/** Só para teste: guarda cada MediaStream pedido ao getUserMedia para conferir depois se os tracks foram parados. */
const TRACK_MEDIA = () => {
  const w = window as unknown as { __streams: MediaStream[] };
  w.__streams = [];
  const md = navigator.mediaDevices;
  if (!md?.getUserMedia) return;
  const original = md.getUserMedia.bind(md);
  md.getUserMedia = async (constraints) => {
    const stream = await original(constraints);
    w.__streams.push(stream);
    return stream;
  };
};

type User = { ctx: BrowserContext; page: Page; errors: string[] };

let seq = 0;
const uniqueRoom = (label: string) => `e2e-${label}-${Date.now()}-${++seq}`;

async function newUser(browser: Browser): Promise<User> {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(TRACK_PCS);
  await ctx.addInitScript(TRACK_MEDIA);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { ctx, page, errors };
}

async function enter(u: User, room: string, name: string) {
  await u.page.goto('/');
  await u.page.getByLabel('Nome da sala').fill(room);
  await u.page.getByLabel('Seu nome').fill(name);
  await u.page.getByRole('button', { name: 'Entrar na sala' }).click();
  await expect(u.page).toHaveURL(/\/room\//);
}

async function pair(browser: Browser, label: string) {
  const room = uniqueRoom(label);
  const ana = await newUser(browser);
  const beto = await newUser(browser);
  await enter(ana, room, 'Ana');
  await enter(beto, room, 'Beto');
  return { room, ana, beto };
}

const participants = (p: Page) => p.getByTestId('participants').locator('li');
const tileOf = (p: Page, name: string) => p.locator('figure[data-testid="tile-camera"]', { hasText: name });

async function expectConnected(p: Page, other: string) {
  await expect(participants(p).filter({ hasText: other }).locator('.badge')).toHaveText('Conectado');
}

/** O vídeo remoto tem frames reais: o relógio avança E o contador de quadros decodificados cresce. */
async function expectVideoPlaying(tile: ReturnType<Page['locator']>) {
  const video = tile.locator('video');
  const frames = () => video.evaluate((v: HTMLVideoElement) => v.getVideoPlaybackQuality().totalVideoFrames);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  const t1 = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  const f1 = await frames();
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(t1);
  await expect.poll(frames).toBeGreaterThan(f1);
}

const pcCount = (p: Page) => p.evaluate(() => (window as unknown as { __pcs: unknown[] }).__pcs.length);

test('entrada pede só sala e nome, sem cadastro', async ({ browser }) => {
  const u = await newUser(browser);
  await u.page.goto('/');
  await expect(u.page.getByRole('textbox')).toHaveCount(2);
  await expect(u.page.locator('input[type="password"], input[type="email"]')).toHaveCount(0);
  await u.page.getByRole('button', { name: 'Entrar na sala' }).click();
  await expect(u.page.locator('p[role="alert"]')).toBeVisible();
  await enter(u, uniqueRoom('entrada'), 'Ana');
  await expect(u.page.getByRole('navigation', { name: 'Controles da reunião' })).toBeVisible();
  await u.ctx.close();
});

test('dois participantes se conectam P2P direto, com áudio e vídeo', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'p2p');
  await expect(participants(ana.page)).toHaveCount(2);
  await expect(participants(beto.page)).toHaveCount(2);
  await expectConnected(ana.page, 'Beto');
  await expectConnected(beto.page, 'Ana');
  await expectVideoPlaying(tileOf(ana.page, 'Beto'));
  await expectVideoPlaying(tileOf(beto.page, 'Ana'));

  // O par ICE escolhido é host/srflx entre os dois navegadores e há bytes de mídia chegando: nada passa por relay/servidor.
  const stats = await ana.page.evaluate(async () => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs;
    const report = await pcs[0].getStats();
    let pairType = '';
    let audioBytes = 0;
    let videoBytes = 0;
    report.forEach((s) => {
      if (s.type === 'candidate-pair' && s.nominated && s.state === 'succeeded') {
        pairType = report.get(s.remoteCandidateId)?.candidateType ?? '';
      }
      if (s.type === 'inbound-rtp' && s.kind === 'audio') audioBytes += s.bytesReceived ?? 0;
      if (s.type === 'inbound-rtp' && s.kind === 'video') videoBytes += s.bytesReceived ?? 0;
    });
    return { pairType, audioBytes, videoBytes };
  });
  expect(['host', 'srflx', 'prflx']).toContain(stats.pairType);
  expect(stats.audioBytes).toBeGreaterThan(0);
  expect(stats.videoBytes).toBeGreaterThan(0);

  expect(ana.errors).toEqual([]);
  expect(beto.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('microfone e câmera refletem o estado nos outros participantes', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'estado');
  await expectConnected(beto.page, 'Ana');

  await ana.page.getByRole('button', { name: 'Microfone', exact: true }).click();
  await expect(tileOf(beto.page, 'Ana').locator('.tile-flag')).toBeVisible();
  await ana.page.getByRole('button', { name: 'Microfone', exact: true }).click();
  await expect(tileOf(beto.page, 'Ana').locator('.tile-flag')).toHaveCount(0);

  await ana.page.getByRole('button', { name: 'Câmera', exact: true }).click();
  await expect(tileOf(beto.page, 'Ana').locator('.avatar')).toBeVisible();
  await ana.page.getByRole('button', { name: 'Câmera', exact: true }).click();
  await expectVideoPlaying(tileOf(beto.page, 'Ana'));

  await ana.ctx.close();
  await beto.ctx.close();
});

test('compartilhamento de tela aparece para o outro participante', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'tela');
  await expectConnected(beto.page, 'Ana');
  await ana.page.getByRole('button', { name: 'Tela', exact: true }).click();
  const screen = beto.page.locator('figure[data-testid="tile-screen"]', { hasText: 'Tela de Ana' });
  await expect(screen).toBeVisible();
  await expect.poll(() => screen.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);

  await ana.page.getByRole('button', { name: 'Tela', exact: true }).click();
  await expect(beto.page.locator('figure[data-testid="tile-screen"]')).toHaveCount(0);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('chat chega nos dois sentidos com o nome certo', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'chat');
  await expectConnected(ana.page, 'Beto');
  await ana.page.getByRole('tab', { name: /Chat/ }).click();
  await beto.page.getByRole('tab', { name: /Chat/ }).click();

  await ana.page.getByLabel('Mensagem', { exact: true }).fill('oi, Beto!');
  await ana.page.getByLabel('Mensagem', { exact: true }).press('Enter');
  await expect(beto.page.getByTestId('messages')).toContainText('Ana');
  await expect(beto.page.getByTestId('messages')).toContainText('oi, Beto!');
  await expect(ana.page.getByTestId('messages')).toContainText('oi, Beto!');

  await beto.page.getByLabel('Mensagem', { exact: true }).fill('olá, Ana');
  await beto.page.getByLabel('Mensagem', { exact: true }).press('Enter');
  await expect(ana.page.getByTestId('messages')).toContainText('olá, Ana');
  await ana.ctx.close();
  await beto.ctx.close();
});

test('arquivo enviado por um participante chega íntegro no outro', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'arquivo');
  await expectConnected(ana.page, 'Beto');
  await expectConnected(beto.page, 'Ana');
  await ana.page.getByRole('tab', { name: 'Arquivos' }).click();
  await beto.page.getByRole('tab', { name: 'Arquivos' }).click();

  const bytes = Buffer.from(Array.from({ length: 70_000 }, (_, i) => i % 251));
  await ana.page.getByTestId('file-input').setInputFiles({ name: 'dados.bin', mimeType: 'application/octet-stream', buffer: bytes });

  const link = beto.page.getByTestId('files').getByRole('link', { name: 'dados.bin' });
  await expect(link).toBeVisible();
  const received = await link.evaluate(async (a: HTMLAnchorElement) => {
    const buf = new Uint8Array(await (await fetch(a.href)).arrayBuffer());
    return { size: buf.length, first: Array.from(buf.slice(0, 5)), last: buf[buf.length - 1] };
  });
  expect(received.size).toBe(70_000);
  expect(received.first).toEqual([0, 1, 2, 3, 4]);
  expect(received.last).toBe(bytes[bytes.length - 1]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('reiniciar conexões renegocia sem ninguém sair da sala', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'reinicio');
  await expectConnected(ana.page, 'Beto');
  await expectConnected(beto.page, 'Ana');
  await expectVideoPlaying(tileOf(beto.page, 'Ana'));
  const before = { ana: await pcCount(ana.page), beto: await pcCount(beto.page) };

  await ana.page.getByRole('button', { name: 'Reiniciar conexões' }).click();

  // novas RTCPeerConnection foram criadas nos dois lados: houve renegociação de verdade
  await expect.poll(() => pcCount(ana.page)).toBeGreaterThan(before.ana);
  await expect.poll(() => pcCount(beto.page)).toBeGreaterThan(before.beto);
  // e ninguém foi expulso
  await expect(participants(ana.page)).toHaveCount(2);
  await expect(participants(beto.page)).toHaveCount(2);
  await expectConnected(ana.page, 'Beto');
  await expectConnected(beto.page, 'Ana');
  await expectVideoPlaying(tileOf(ana.page, 'Beto'));
  await expectVideoPlaying(tileOf(beto.page, 'Ana'));
  await expect(participants(ana.page)).toHaveCount(2);
  expect(ana.errors).toEqual([]);
  expect(beto.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('quem fecha a aba some da lista e o outro continua sem erros', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'saida');
  await expectConnected(ana.page, 'Beto');
  await beto.page.close({ runBeforeUnload: true });
  await expect(participants(ana.page)).toHaveCount(1, { timeout: 25_000 });
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('recarregar a aba reconecta sem deixar participante duplicado', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'reload');
  await expectConnected(ana.page, 'Beto');
  await beto.page.reload();
  await expect(participants(beto.page)).toHaveCount(2);
  await expectConnected(beto.page, 'Ana');
  await expectConnected(ana.page, 'Beto');
  await expect(participants(ana.page)).toHaveCount(2, { timeout: 25_000 });
  await expectVideoPlaying(tileOf(ana.page, 'Beto'));
  await ana.ctx.close();
  await beto.ctx.close();
});

test('o 9º participante vê "Sala cheia"', async ({ browser, request }) => {
  const room = uniqueRoom('cheia');
  for (let i = 0; i < 8; i++) {
    const res = await request.post(`/api/rooms/${room}/join`, { data: { name: `bot${i}` } });
    expect(res.status()).toBe(200);
  }
  const u = await newUser(browser);
  await enter(u, room, 'Nono');
  await expect(u.page.locator('p[role="alert"]')).toContainText('Sala cheia');
  // sem chamada, a câmera/microfone não podem ficar abertos (luz da câmera acesa)
  await expect
    .poll(() =>
      u.page.evaluate(() => {
        const streams = (window as unknown as { __streams: MediaStream[] }).__streams;
        return streams.length > 0 && streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'));
      }),
    )
    .toBe(true);
  await u.ctx.close();
});

test('servidor que esquece o participante: para de reentrar, explica e solta a câmera', async ({ browser }) => {
  const room = uniqueRoom('esquece');
  const u = await newUser(browser);
  let joins = 0;
  u.page.on('request', (r) => {
    if (r.method() === 'POST' && r.url().endsWith('/join')) joins++;
  });
  // simula várias instâncias sem memória compartilhada (ex.: Vercel): o poll nunca reconhece o peerId
  await u.page.route('**/api/rooms/*/events*', (route) =>
    route.fulfill({ status: 410, contentType: 'application/json', body: '{"error":"gone"}' }),
  );
  await enter(u, room, 'Ana');
  const alert = u.page.locator('p[role="alert"]');
  await expect(alert).toContainText('Não foi possível manter a sala');
  await expect(u.page.getByRole('button', { name: 'Tentar novamente' })).toBeVisible();
  const settled = joins;
  await u.page.waitForTimeout(3000);
  expect(joins).toBe(settled); // parou de reentrar
  expect(joins).toBeLessThanOrEqual(4); // join inicial + 3 re-joins
  await expect
    .poll(() =>
      u.page.evaluate(() => {
        const streams = (window as unknown as { __streams: MediaStream[] }).__streams;
        return streams.length > 0 && streams.every((s) => s.getTracks().every((t) => t.readyState === 'ended'));
      }),
    )
    .toBe(true);
  await u.ctx.close();
});

test('sala com acento e espaço mostra o nome certo e conecta os dois', async ({ browser }) => {
  const room = `Reunião Ótima ${Date.now()}`;
  const ana = await newUser(browser);
  const beto = await newUser(browser);
  await enter(ana, room, 'Ana');
  await enter(beto, room, 'Beto');
  await expect(ana.page.locator('.room-name')).toHaveText(room);
  await expectConnected(ana.page, 'Beto');
  await expectConnected(beto.page, 'Ana');
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});
