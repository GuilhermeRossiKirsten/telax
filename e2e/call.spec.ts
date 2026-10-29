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

/** Todos entram mutados: testes que conferem áudio/vídeo reais ligam câmera e microfone antes. */
async function goLive(...users: User[]) {
  for (const u of users) {
    for (const name of ['Microfone', 'Câmera']) {
      const btn = u.page.getByRole('button', { name, exact: true });
      await expect(btn).toHaveAttribute('aria-pressed', 'false');
      await btn.click();
      await expect(btn).toHaveAttribute('aria-pressed', 'true');
    }
  }
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
  await goLive(ana, beto);
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

test('câmera e microfone entram mutados, nos tracks e para os outros participantes', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'mutados');
  await expectConnected(beto.page, 'Ana');

  const mic = ana.page.getByRole('button', { name: 'Microfone', exact: true });
  const cam = ana.page.getByRole('button', { name: 'Câmera', exact: true });
  await expect(mic).toHaveAttribute('aria-pressed', 'false');
  await expect(cam).toHaveAttribute('aria-pressed', 'false');

  // nada sai do navegador de Ana: os tracks capturados estão com enabled=false
  const enabled = await ana.page.evaluate(() =>
    (window as unknown as { __streams: MediaStream[] }).__streams.flatMap((s) => s.getTracks().map((t) => t.enabled)),
  );
  expect(enabled.length).toBeGreaterThan(0);
  expect(enabled.every((e) => e === false)).toBe(true);

  // e Beto já vê Ana sem câmera e com o microfone cortado
  await expect(tileOf(beto.page, 'Ana').locator('.avatar')).toBeVisible();
  await expect(tileOf(beto.page, 'Ana').locator('.tile-flag')).toBeVisible();

  await ana.ctx.close();
  await beto.ctx.close();
});

test('microfone e câmera refletem o estado nos outros participantes', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'estado');
  await expectConnected(beto.page, 'Ana');

  // entram mutados: o primeiro clique liga, o segundo desliga
  await ana.page.getByRole('button', { name: 'Microfone', exact: true }).click();
  await expect(tileOf(beto.page, 'Ana').locator('.tile-flag')).toHaveCount(0);
  await ana.page.getByRole('button', { name: 'Microfone', exact: true }).click();
  await expect(tileOf(beto.page, 'Ana').locator('.tile-flag')).toBeVisible();

  await ana.page.getByRole('button', { name: 'Câmera', exact: true }).click();
  await expectVideoPlaying(tileOf(beto.page, 'Ana'));
  await ana.page.getByRole('button', { name: 'Câmera', exact: true }).click();
  await expect(tileOf(beto.page, 'Ana').locator('.avatar')).toBeVisible();

  await ana.ctx.close();
  await beto.ctx.close();
});

test('compartilhamento de tela aparece para o outro participante', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'tela');
  await expectConnected(beto.page, 'Ana');
  await ana.page.getByRole('button', { name: 'Tela', exact: true }).click();
  const screen = beto.page.locator('figure[data-testid="tile-screen"]', { hasText: 'Tela de Ana' });

  // a tela de outra pessoa chega oculta: Beto escolhe mostrar
  const shelf = beto.page.getByRole('region', { name: 'Telas ocultas' });
  await expect(screen).toBeHidden();
  await shelf.getByRole('button', { name: 'Mostrar Tela de Ana' }).click();
  await expect(screen).toBeVisible();
  await expect(shelf.getByRole('button', { name: 'Mostrar Tela de Ana' })).toHaveCount(0);
  await expect(beto.page.getByTestId('tiles')).toHaveAttribute('data-layout', 'spotlight');
  await expect.poll(() => screen.locator('video').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);

  await ana.page.getByRole('button', { name: 'Tela', exact: true }).click();
  await expect(beto.page.locator('figure[data-testid="tile-screen"]')).toHaveCount(0);
  await ana.ctx.close();
  await beto.ctx.close();
});

/** Só para teste: o "compartilhar tela" entrega um vídeo animado e um tom de 440 Hz, como uma aba tocando som. */
const FAKE_TAB_WITH_AUDIO = () => {
  // como o navegador de verdade: só entrega áudio se o app o pediu
  navigator.mediaDevices.getDisplayMedia = async (options) => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const g = canvas.getContext('2d')!;
    let n = 0;
    setInterval(() => {
      g.fillStyle = `hsl(${(n += 7) % 360} 80% 50%)`;
      g.fillRect(0, 0, 640, 360);
    }, 50);
    const ac = new AudioContext();
    void ac.resume();
    const osc = ac.createOscillator();
    osc.frequency.value = 440;
    const dest = ac.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const audio = options?.audio ? dest.stream.getAudioTracks() : [];
    return new MediaStream([...canvas.captureStream(15).getVideoTracks(), ...audio]);
  };
};

test('compartilhar o som da aba: chega como faixa separada, começa silenciado e toca ao ativar', async ({ browser }) => {
  const room = uniqueRoom('somdaaba');
  const ana = await newUser(browser);
  const beto = await newUser(browser);
  await ana.ctx.addInitScript(FAKE_TAB_WITH_AUDIO);
  await enter(ana, room, 'Ana');
  await enter(beto, room, 'Beto');
  await expectConnected(beto.page, 'Ana');

  await ana.page.getByRole('button', { name: 'Tela', exact: true }).click();
  await expect(ana.page.getByRole('button', { name: 'Tela', exact: true })).toHaveAttribute('title', /som da aba está sendo enviado/);

  const screen = beto.page.locator('figure[data-testid="tile-screen"]', { hasText: 'Tela de Ana' });
  await beto.page.getByRole('region', { name: 'Telas ocultas' }).getByRole('button', { name: 'Mostrar Tela de Ana' }).click();
  await expect(screen).toBeVisible();
  const video = screen.locator('video');
  // a tela de outra pessoa entra silenciada; o vídeo remoto carrega uma faixa de áudio própria (não é o microfone)
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);
  await expect
    .poll(() => video.evaluate((v: HTMLVideoElement) => (v.srcObject as MediaStream).getAudioTracks().length))
    .toBe(1);
  await expect(screen.locator('.tile-flag-local')).toBeVisible();

  await screen.getByRole('button', { name: 'Ativar som de Tela de Ana' }).click();
  expect(await video.evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);

  // o som que chega é o tom de verdade, não silêncio
  const peak = await video.evaluate(async (v: HTMLVideoElement) => {
    const ac = new AudioContext();
    await ac.resume();
    const src = ac.createMediaStreamSource(new MediaStream((v.srcObject as MediaStream).getAudioTracks()));
    const analyser = ac.createAnalyser();
    src.connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    let max = 0;
    const end = performance.now() + 4000;
    while (performance.now() < end && max < 0.02) {
      analyser.getFloatTimeDomainData(buf);
      for (const x of buf) max = Math.max(max, Math.abs(x));
      await new Promise((r) => setTimeout(r, 100));
    }
    return max;
  });
  expect(peak).toBeGreaterThan(0.02);

  await ana.page.getByRole('button', { name: 'Tela', exact: true }).click();
  await expect(beto.page.locator('figure[data-testid="tile-screen"]')).toHaveCount(0);
  expect(ana.errors).toEqual([]);
  expect(beto.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

const playing = (tile: ReturnType<Page['locator']>) =>
  tile.locator('video').evaluate((v: HTMLVideoElement) => !v.paused && v.readyState >= 2);

test('ocultar tira a tela da grade, mantém o áudio tocando e "Mostrar" traz de volta', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'ocultar');
  await expectConnected(ana.page, 'Beto');
  const tile = tileOf(ana.page, 'Beto');
  await expect(tile).toBeVisible();

  await tile.getByRole('button', { name: 'Ocultar Beto' }).click();
  await expect(tile).toBeHidden();
  // oculto não é desligado: o vídeo segue tocando (e com som, se não foi silenciado)
  await expect.poll(() => playing(tile)).toBe(true);
  expect(await tile.locator('video').evaluate((v: HTMLVideoElement) => v.muted)).toBe(false);

  await ana.page.getByRole('region', { name: 'Telas ocultas' }).getByRole('button', { name: 'Mostrar Beto' }).click();
  await expect(tile).toBeVisible();
  await expect(ana.page.getByRole('region', { name: 'Telas ocultas' })).toHaveCount(0);
  await expect.poll(() => playing(tile)).toBe(true);

  // nada mudou para o Beto: ele continua vendo a Ana
  await expect(tileOf(beto.page, 'Ana')).toBeVisible();
  await ana.ctx.close();
  await beto.ctx.close();
});

test('silenciar corta só o áudio daquela pessoa, neste navegador', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'silenciar');
  await expectConnected(ana.page, 'Beto');
  const tile = tileOf(ana.page, 'Beto');
  const muted = () => tile.locator('video').evaluate((v: HTMLVideoElement) => v.muted);

  expect(await muted()).toBe(false);
  await tile.getByRole('button', { name: 'Silenciar Beto' }).click();
  await expect.poll(muted).toBe(true);
  await expect(tile.getByRole('button', { name: 'Ativar som de Beto' })).toBeVisible();
  // a própria câmera não oferece "silenciar"
  await expect(tileOf(ana.page, 'Ana').getByRole('button', { name: /Silenciar/ })).toHaveCount(0);

  await tile.getByRole('button', { name: 'Ativar som de Beto' }).click();
  await expect.poll(muted).toBe(false);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('clicar na tela maximiza; Esc restaura; se a pessoa maximizada sai, a grade volta', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'maximizar');
  await expectConnected(ana.page, 'Beto');
  const tile = tileOf(ana.page, 'Beto');
  const mine = tileOf(ana.page, 'Ana');

  await tile.click({ position: { x: 24, y: 24 } });
  await expect(tile).toHaveAttribute('data-maximized', 'true');
  await expect(mine).toBeHidden();
  await expect.poll(() => playing(tile)).toBe(true);

  await ana.page.keyboard.press('Escape');
  await expect(tile).not.toHaveAttribute('data-maximized', 'true');
  await expect(mine).toBeVisible();

  await tile.getByRole('button', { name: 'Maximizar Beto' }).click();
  await expect(tile).toHaveAttribute('data-maximized', 'true');
  await tile.getByRole('button', { name: 'Restaurar Beto' }).click();
  await expect(mine).toBeVisible();

  await tile.getByRole('button', { name: 'Maximizar Beto' }).click();
  await beto.page.close({ runBeforeUnload: true });
  await expect(tile).toHaveCount(0, { timeout: 25_000 });
  await expect(mine).toBeVisible(); // nada de tela maximizada vazia
  await ana.ctx.close();
  await beto.ctx.close();
});

test('aba Telas: reordena, muda o layout e as colunas, e lembra a escolha ao recarregar', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'painel');
  await expectConnected(ana.page, 'Beto');
  await ana.page.getByRole('tab', { name: 'Telas' }).click();
  const list = ana.page.getByTestId('tile-list');
  const cams = ana.page.locator('[data-testid="tiles"] figure[data-testid="tile-camera"]');
  await expect(cams.first()).toContainText('Ana');

  await list.getByRole('button', { name: 'Subir Beto' }).click();
  await expect(cams.first()).toContainText('Beto');
  await expect(list.locator('li').first()).toContainText('Beto');

  const tiles = ana.page.getByTestId('tiles');
  await ana.page.getByLabel('Layout').selectOption('sidebar');
  await expect(tiles).toHaveAttribute('data-layout', 'sidebar');
  await ana.page.getByLabel('Layout').selectOption('grid');
  await ana.page.getByLabel('Colunas').selectOption('2');
  await expect(tiles).toHaveAttribute('data-columns', '2');

  // ocultar e silenciar também pelo painel
  await list.getByRole('button', { name: 'Ocultar Beto' }).click();
  await expect(tileOf(ana.page, 'Beto')).toBeHidden();
  await list.getByRole('button', { name: 'Mostrar Beto' }).click();
  await expect(tileOf(ana.page, 'Beto')).toBeVisible();

  await ana.page.getByLabel('Layout').selectOption('spotlight');
  await ana.page.reload();
  await ana.page.getByRole('tab', { name: 'Telas' }).click();
  await expect(ana.page.getByLabel('Layout')).toHaveValue('spotlight');
  await ana.page.getByRole('tab', { name: /Participantes/ }).click();
  await expectConnected(ana.page, 'Beto');
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
  await goLive(ana, beto);
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
  // depois de recarregar, Beto volta mutado: liga a câmera para haver vídeo
  await beto.page.getByRole('button', { name: 'Câmera', exact: true }).click();
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
