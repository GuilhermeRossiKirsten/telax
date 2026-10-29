import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

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
const tileOf = (p: Page, name: string) => p.locator('figure[data-testid="tile"]', { hasText: name });

/**
 * Menu do tile (botão direito ou "Mais opções"): `role="menu"` num portal em document.body, por isso fica FORA do
 * locator do tile. Todo controle de áudio (voz e som da transmissão) mora aqui, nunca no overlay de hover.
 */
const menuOf = (p: Page, label: string) => p.getByRole('menu', { name: `Menu de ${label}` });
/** Abre o menu com o botão direito num ponto livre do tile (longe do overlay do topo e do botão "Ver tela"). */
async function openMenu(p: Page, tile: Locator, label: string) {
  await tile.click({ button: 'right', position: { x: 12, y: 80 } });
  const menu = menuOf(p, label);
  await expect(menu).toBeVisible();
  return menu;
}
async function closeMenu(p: Page, label: string) {
  await p.keyboard.press('Escape');
  await expect(menuOf(p, label)).toHaveCount(0);
}

async function expectConnected(p: Page, other: string) {
  await expect(participants(p).filter({ hasText: other }).locator('.badge')).toHaveText('Conectado');
}

/** O vídeo remoto tem frames reais: o relógio avança E o contador de quadros decodificados cresce. */
async function expectVideoPlaying(tile: ReturnType<Page['locator']>) {
  const video = tile.locator('video:not(.tile-inset)'); // o principal: o inset é a câmera pequena sobre a tela
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

const tilesOf = (p: Page) => p.locator('figure[data-testid="tile"]');
const shareButton = (p: Page) => p.getByRole('button', { name: 'Tela', exact: true });
/** `Tela` só ADICIONA uma tela (até 3); este botão, que aparece enquanto há alguma, para TODAS. */
const stopSharingButton = (p: Page) => p.getByRole('button', { name: 'Parar compartilhamento', exact: true });

test('compartilhar tela: a tela entra no MESMO tile da pessoa, no lugar do avatar (um tile só)', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'tela');
  await expectConnected(beto.page, 'Ana');
  await shareButton(ana.page).click();
  const tile = tileOf(beto.page, 'Ana');

  // a tela de outra pessoa chega fechada: o tile continua mostrando o avatar e oferece "Ver tela"
  await expect(tile).toHaveAttribute('data-sharing', 'true');
  await expect(tile).toHaveAttribute('data-showing', 'camera');
  await expect(tile.locator('.avatar')).toBeVisible();
  const open = tile.getByRole('button', { name: 'Ver tela de Ana' });
  await expect(open).toBeVisible();
  await expect(tilesOf(beto.page)).toHaveCount(2); // nenhum tile novo só para a tela

  await open.click();
  await expect(tile).toHaveAttribute('data-showing', 'screen');
  await expect(tile.locator('.avatar')).toBeHidden(); // a tela ocupa o lugar do ícone
  await expect(tile.getByRole('button', { name: 'Ver tela de Ana' })).toHaveCount(0);
  await expect(tilesOf(beto.page)).toHaveCount(2);
  await expect(tileOf(beto.page, 'Ana')).toHaveCount(1); // só UM tile da Ana
  await expect(beto.page.getByTestId('tiles')).toHaveAttribute('data-layout', 'spotlight');
  await expect.poll(() => tile.locator('video:not(.tile-inset)').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);

  await stopSharingButton(ana.page).click();
  await expect(tile).not.toHaveAttribute('data-sharing', 'true');
  await expect(tile).toHaveAttribute('data-showing', 'camera');
  await expect(tilesOf(beto.page)).toHaveCount(2);
  await expect(beto.page.getByTestId('tiles')).toHaveAttribute('data-layout', 'grid');
  await ana.ctx.close();
  await beto.ctx.close();
});

test('quem compartilha vê a própria tela no próprio tile, sem avatar nem "Ver tela"; ainda 2 tiles nas duas páginas', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'propria');
  await expectConnected(ana.page, 'Beto');
  await shareButton(ana.page).click();
  const mine = tileOf(ana.page, 'Ana');

  await expect(mine).toHaveAttribute('data-showing', 'screen');
  await expect(mine.locator('.avatar')).toBeHidden();
  await expect(mine.getByRole('button', { name: /Ver tela/ })).toHaveCount(0);
  await expect.poll(() => mine.locator('video:not(.tile-inset)').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  await expect(ana.page.getByTestId('tiles')).toHaveAttribute('data-layout', 'spotlight'); // a própria tela também destaca
  // um tile por participante, dos dois lados, mesmo durante o compartilhamento
  await expect(tilesOf(ana.page)).toHaveCount(2);
  await expect(tilesOf(beto.page)).toHaveCount(2);

  await stopSharingButton(ana.page).click();
  await expect(mine).toHaveAttribute('data-showing', 'camera');
  await expect(tilesOf(ana.page)).toHaveCount(2);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('tela aberta com a câmera ligada: a câmera vira um quadro pequeno no mesmo tile; desligada, não sobra nem avatar', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'inset');
  await expectConnected(beto.page, 'Ana');
  await ana.page.getByRole('button', { name: 'Câmera', exact: true }).click();
  await expect(ana.page.getByRole('button', { name: 'Câmera', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await shareButton(ana.page).click();
  const tile = tileOf(beto.page, 'Ana');
  await tile.getByRole('button', { name: 'Ver tela de Ana' }).click();
  await expect(tile).toHaveAttribute('data-showing', 'screen');

  await expect(tile.locator('video.tile-inset')).toBeVisible();
  await expect(tilesOf(beto.page)).toHaveCount(2);
  await expect.poll(() => tile.locator('video:not(.tile-inset)').evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);

  await ana.page.getByRole('button', { name: 'Câmera', exact: true }).click(); // desliga
  await expect(tile.locator('video.tile-inset')).toHaveCount(0);
  await expect(tile.locator('.avatar')).toBeHidden();
  await expect(tile).toHaveAttribute('data-showing', 'screen');
  await ana.ctx.close();
  await beto.ctx.close();
});

test('"Fechar tela" volta à câmera/avatar no mesmo tile, mantém o tile e para o som da aba', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'fechartela');
  await expectConnected(beto.page, 'Ana');
  await shareButton(ana.page).click();
  const tile = tileOf(beto.page, 'Ana');
  await tile.getByRole('button', { name: 'Ver tela de Ana' }).click();
  await expect(tile).toHaveAttribute('data-showing', 'screen');
  const sound = beto.page.locator('[data-testid^="audio-screen:"]');
  await expect(sound).toHaveCount(1);

  await tile.hover();
  await tile.getByRole('button', { name: 'Fechar tela de Ana' }).click();
  await expect(tile).toHaveAttribute('data-showing', 'camera');
  await expect(tile).toHaveAttribute('data-sharing', 'true'); // ela segue compartilhando; só deixei de ver
  await expect(tile.locator('.avatar')).toBeVisible();
  await expect(tile.getByRole('button', { name: 'Ver tela de Ana' })).toBeVisible();
  await expect(tilesOf(beto.page)).toHaveCount(2);
  await expect.poll(() => sound.evaluate((a: HTMLAudioElement) => a.srcObject === null)).toBe(true); // o som da aba parou
  await expect(beto.page.getByRole('region', { name: 'Telas fechadas' })).toHaveCount(0); // fechar a tela não esconde o tile
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

  await shareButton(ana.page).click();
  await expect(shareButton(ana.page)).toHaveAttribute('aria-pressed', 'true'); // compartilhando
  await expect(stopSharingButton(ana.page)).toBeVisible();

  const tile = tileOf(beto.page, 'Ana');
  await tile.getByRole('button', { name: 'Ver tela de Ana' }).click();
  await expect(tile).toHaveAttribute('data-showing', 'screen');
  // o som da tela toca num <audio> próprio (o da voz é outro): começa silenciado
  const sound = audioOf(beto.page, 'screen');
  await expect.poll(() => sound.evaluate((a: HTMLAudioElement) => a.muted)).toBe(true);
  // e esse <audio> não é o do microfone da Ana: a voz tem o seu
  await expect(audioOf(beto.page, 'camera')).toHaveCount(1);
  // o controle do som da aba mora no menu (botão direito), no grupo "Som da transmissão", separado da "Voz"
  const menu = await openMenu(beto.page, tile, 'Ana');
  const transmission = menu.getByRole('group', { name: 'Som da transmissão de Ana' });
  await expect(transmission.getByRole('button', { name: 'Ativar som da aba de Ana' })).toBeVisible();

  await transmission.getByRole('button', { name: 'Ativar som da aba de Ana' }).click();
  await expect.poll(() => sound.evaluate((a: HTMLAudioElement) => !a.muted && !a.paused)).toBe(true);
  await expect(menu).toBeVisible(); // silenciar/ativar não fecha o menu
  await closeMenu(beto.page, 'Ana');

  // o som que chega é o tom de verdade, não silêncio
  const peak = await sound.evaluate(async (a: HTMLAudioElement) => {
    const ac = new AudioContext();
    await ac.resume();
    const src = ac.createMediaStreamSource(new MediaStream((a.srcObject as MediaStream).getAudioTracks()));
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

  await stopSharingButton(ana.page).click();
  await expect(tile).not.toHaveAttribute('data-sharing', 'true');
  await expect(sound).toHaveCount(0); // sem compartilhamento não há <audio> de tela
  expect(ana.errors).toEqual([]);
  expect(beto.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

const playing = (tile: ReturnType<Page['locator']>) =>
  tile.locator('video:not(.tile-inset)').evaluate((v: HTMLVideoElement) => !v.paused && v.readyState >= 2);

/** O som de cada tile remoto mora num <audio> fixo; testes abaixo o marcam para provar que nada o recria. */
const audioOf = (p: Page, kind: 'camera' | 'screen') => p.locator(`[data-testid^="audio-${kind}:"]`);
const markAudio = (a: ReturnType<Page['locator']>) =>
  a.evaluate((el: HTMLAudioElement) => {
    el.dataset.mark = 'mesmo-elemento';
  });
/** É o mesmo elemento de antes (nunca recriado), está tocando e com som. */
const sameAudioStillPlaying = (a: ReturnType<Page['locator']>) =>
  a.evaluate((el: HTMLAudioElement) => el.dataset.mark === 'mesmo-elemento' && !el.paused && !el.muted);

test('fechar tira a tela da grade, mantém o áudio tocando e "Mostrar" traz de volta', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'ocultar');
  await expectConnected(ana.page, 'Beto');
  const tile = tileOf(ana.page, 'Beto');
  const sound = audioOf(ana.page, 'camera');
  await expect(tile).toBeVisible();
  await expect.poll(() => sound.evaluate((a: HTMLAudioElement) => !a.paused)).toBe(true);
  await markAudio(sound);

  await tile.getByRole('button', { name: 'Fechar Beto' }).click();
  await expect(tile).toBeHidden();
  // fechar só tira a imagem: é o MESMO <audio>, ainda tocando e com som, e a imagem segue chegando
  expect(await sameAudioStillPlaying(sound)).toBe(true);
  await expect.poll(() => playing(tile)).toBe(true);

  await ana.page.getByRole('region', { name: 'Telas fechadas' }).getByRole('button', { name: 'Mostrar Beto' }).click();
  await expect(tile).toBeVisible();
  await expect(ana.page.getByRole('region', { name: 'Telas fechadas' })).toHaveCount(0);
  await expect.poll(() => playing(tile)).toBe(true);
  expect(await sameAudioStillPlaying(sound)).toBe(true);

  // nada mudou para o Beto: ele continua vendo a Ana
  await expect(tileOf(beto.page, 'Ana')).toBeVisible();
  await ana.ctx.close();
  await beto.ctx.close();
});

test('silenciar corta só o áudio daquela pessoa, neste navegador', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'silenciar');
  await expectConnected(ana.page, 'Beto');
  const tile = tileOf(ana.page, 'Beto');
  // o som é do <audio> do tile; o <video> da imagem é sempre mudo
  const sound = audioOf(ana.page, 'camera');
  const muted = () => sound.evaluate((a: HTMLAudioElement) => a.muted);

  await expect.poll(muted).toBe(false);
  expect(await tile.locator('video').evaluate((v: HTMLVideoElement) => v.muted)).toBe(true);

  // o controle da voz mora no menu (botão direito), no grupo "Voz de Beto"
  const menu = await openMenu(ana.page, tile, 'Beto');
  const vozDeBeto = menu.getByRole('group', { name: 'Voz de Beto' });
  await vozDeBeto.getByRole('button', { name: 'Silenciar Beto' }).click();
  await expect.poll(muted).toBe(true);
  await expect(vozDeBeto.getByRole('button', { name: 'Ativar som de Beto' })).toBeVisible();
  await expect(menu).toBeVisible(); // silenciar não fecha o menu
  // o selo no tile diz que VOCÊ silenciou a pessoa (diferente do selo do microfone dela e do chip da aba)
  await expect(tile.locator('[title="Você silenciou esta pessoa"]')).toBeVisible();

  await vozDeBeto.getByRole('button', { name: 'Ativar som de Beto' }).click();
  await expect.poll(muted).toBe(false);
  await expect(tile.locator('[title="Você silenciou esta pessoa"]')).toHaveCount(0);
  await closeMenu(ana.page, 'Beto');

  // a própria câmera não oferece "silenciar": o menu dela não tem grupo de voz nem botão de silenciar
  const own = await openMenu(ana.page, tileOf(ana.page, 'Ana'), 'Ana (você)');
  await expect(own.getByRole('group')).toHaveCount(0);
  await expect(own.getByRole('button', { name: /Silenciar|Ativar som/ })).toHaveCount(0);
  await closeMenu(ana.page, 'Ana (você)');
  await ana.ctx.close();
  await beto.ctx.close();
});

test('clicar numa tela a seleciona: fica grande e os outros ficam embaixo; Esc solta; quem sai não deixa seleção vazia', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'selecionar');
  await expectConnected(ana.page, 'Beto');
  const tile = tileOf(ana.page, 'Beto');
  const mine = tileOf(ana.page, 'Ana');
  const tiles = ana.page.getByTestId('tiles');
  const sound = audioOf(ana.page, 'camera');
  await expect.poll(() => sound.evaluate((a: HTMLAudioElement) => !a.paused)).toBe(true);
  await markAudio(sound);
  await expect(tiles).toHaveAttribute('data-layout', 'grid');

  await tile.click({ position: { x: 24, y: 80 } });
  await expect(tile).toHaveAttribute('data-selected', 'true');
  await expect(tiles).toHaveAttribute('data-layout', 'spotlight');
  // o selecionado é o grande e a própria câmera continua visível, na faixa de baixo
  await expect(ana.page.locator('.tiles-primary').locator('figure[data-testid="tile"]', { hasText: 'Beto' })).toBeVisible();
  await expect(ana.page.locator('.tiles-rest').locator('figure[data-testid="tile"]', { hasText: 'Ana' })).toBeVisible();
  await expect.poll(() => playing(tile)).toBe(true);
  expect(await sameAudioStillPlaying(sound)).toBe(true);

  await ana.page.keyboard.press('Escape');
  await expect(tile).not.toHaveAttribute('data-selected', 'true');
  await expect(tiles).toHaveAttribute('data-layout', 'grid');

  // sem botão de pin no overlay: a seleção também sai pelo item do menu de botão direito
  await tile.hover();
  await expect(tile.getByRole('button', { name: /Destacar|Soltar/ })).toHaveCount(0);
  let menu = await openMenu(ana.page, tile, 'Beto');
  await menu.getByRole('menuitem', { name: 'Destacar Beto', exact: true }).click();
  await expect(tile).toHaveAttribute('data-selected', 'true');
  menu = await openMenu(ana.page, tile, 'Beto');
  await menu.getByRole('menuitem', { name: 'Soltar Beto', exact: true }).click();
  await expect(tile).not.toHaveAttribute('data-selected', 'true');
  await expect(tiles).toHaveAttribute('data-layout', 'grid');
  expect(await sameAudioStillPlaying(sound)).toBe(true); // nem selecionar nem soltar recriam o som

  menu = await openMenu(ana.page, tile, 'Beto');
  await menu.getByRole('menuitem', { name: 'Destacar Beto', exact: true }).click();
  await expect(tile).toHaveAttribute('data-selected', 'true');
  await beto.page.close({ runBeforeUnload: true });
  await expect(tile).toHaveCount(0, { timeout: 25_000 });
  await expect(mine).toBeVisible(); // nada de destaque vazio
  await expect(tiles).toHaveAttribute('data-layout', 'grid');
  await ana.ctx.close();
  await beto.ctx.close();
});

test('o botão de maximizar põe o tile em tela cheia de verdade e dá para sair', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'telacheia');
  await expectConnected(ana.page, 'Beto');
  const tile = tileOf(ana.page, 'Beto');
  const sound = audioOf(ana.page, 'camera');
  await expect.poll(() => sound.evaluate((a: HTMLAudioElement) => !a.paused)).toBe(true);
  await markAudio(sound);
  const full = () => ana.page.evaluate(() => (document.fullscreenElement as HTMLElement | null)?.dataset.testid ?? null);

  expect(await full()).toBeNull();
  await tile.hover();
  await tile.getByRole('button', { name: 'Tela cheia Beto' }).click();
  // é o PRÓPRIO tile (e não a página) que está em tela cheia, ocupando a janela toda
  await expect.poll(full).toBe('tile');
  const box = await tile.evaluate((el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height), iw: window.innerWidth, ih: window.innerHeight };
  });
  expect(box.w).toBe(box.iw);
  expect(box.h).toBe(box.ih);
  await expect.poll(() => tile.locator('video').evaluate((v: HTMLVideoElement) => !v.paused)).toBe(true);
  // em tela cheia os controles continuam ali (agora para sair) e o som segue o mesmo
  expect(await sameAudioStillPlaying(sound)).toBe(true);
  // maximizar não mexe na seleção: quem seleciona é o clique no tile ou o item "Destacar" do menu
  await expect(tile).not.toHaveAttribute('data-selected', 'true');

  await tile.hover();
  await tile.getByRole('button', { name: 'Sair da tela cheia Beto' }).click();
  await expect.poll(full).toBeNull();
  await expect(tile).toBeVisible();
  expect(await sameAudioStillPlaying(sound)).toBe(true);
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('o painel não tem a aba Telas; o overlay NÃO tem áudio e o menu (botão direito) controla volume e silenciar', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'overlay');
  await expectConnected(ana.page, 'Beto');
  await expect(ana.page.getByRole('tab', { name: 'Telas' })).toHaveCount(0);
  await expect(ana.page.getByRole('tab')).toHaveCount(3); // Participantes, Chat, Arquivos

  const tile = tileOf(ana.page, 'Beto');
  const sound = audioOf(ana.page, 'camera');
  const volume = () => sound.evaluate((a: HTMLAudioElement) => a.volume);
  await expect.poll(() => sound.evaluate((a: HTMLAudioElement) => !a.paused)).toBe(true);
  await markAudio(sound);

  // (a) o overlay de hover só tem as ações do tile: nenhum slider e nenhum botão de som (o menu é um portal, fora do tile)
  await tile.hover();
  await expect(tile.getByRole('button', { name: /Destacar|Soltar/ })).toHaveCount(0); // sem botão de pin: a seleção é o clique no tile
  await expect(tile.getByRole('button', { name: 'Tela cheia Beto' })).toBeVisible();
  await expect(tile.getByRole('button', { name: 'Fechar Beto' })).toBeVisible();
  await expect(tile.getByRole('button', { name: 'Mais opções de Beto' })).toBeVisible();
  await expect(tile.getByRole('slider')).toHaveCount(0);
  await expect(tile.getByRole('button', { name: /Silenciar|Ativar som/ })).toHaveCount(0);

  // o volume e o silenciar vivem no menu, no grupo "Voz de Beto"
  const menu = await openMenu(ana.page, tile, 'Beto');
  const voz = menu.getByRole('group', { name: 'Voz de Beto' });
  const slider = voz.getByRole('slider', { name: 'Volume de Beto' });
  await slider.fill('30');
  await expect.poll(volume).toBeCloseTo(0.3, 2);
  await expect(menu).toBeVisible(); // ajustar o volume não fecha o menu

  // silenciar e voltar a mexer no volume volta a ouvir
  await voz.getByRole('button', { name: 'Silenciar Beto' }).click();
  await expect.poll(() => sound.evaluate((a: HTMLAudioElement) => a.muted)).toBe(true);
  await expect(slider).toHaveValue('0');
  await slider.fill('60');
  await expect.poll(() => sound.evaluate((a: HTMLAudioElement) => a.muted)).toBe(false);
  await expect.poll(volume).toBeCloseTo(0.6, 2);
  await closeMenu(ana.page, 'Beto');

  // o menu não dispara a seleção, e o volume é só deste navegador
  await expect(tile).not.toHaveAttribute('data-selected', 'true');
  expect(await beto.page.locator('[data-testid^="audio-camera:"]').evaluate((a: HTMLAudioElement) => a.volume)).toBe(1);

  // fechar = parar de visualizar; o som continua o mesmo até quem fechou decidir silenciar
  await tile.getByRole('button', { name: 'Fechar Beto' }).click();
  await expect(tile).toBeHidden();
  await expect(ana.page.getByRole('region', { name: 'Telas fechadas' }).getByRole('button', { name: 'Mostrar Beto' })).toBeVisible();
  expect(await sameAudioStillPlaying(sound)).toBe(true);
  expect(await volume()).toBeCloseTo(0.6, 2);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('botão direito abre o menu certo de cada tipo de tile (voz, som da transmissão, próprio tile)', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'menu-tipos');
  await expectConnected(ana.page, 'Beto');

  // tile de câmera de outra pessoa: só a voz; nenhum grupo de transmissão
  const betoTile = tileOf(ana.page, 'Beto');
  let menu = await openMenu(ana.page, betoTile, 'Beto');
  await expect(menu.getByRole('group', { name: 'Voz de Beto' })).toBeVisible();
  await expect(menu.getByRole('group', { name: /Som da transmissão/ })).toHaveCount(0);
  for (const item of ['Destacar Beto', 'Tela cheia Beto', 'Fechar Beto']) {
    await expect(menu.getByRole('menuitem', { name: item, exact: true })).toBeVisible();
  }
  await expect(menu.getByRole('menuitem', { name: /Ver tela|Fechar tela/ })).toHaveCount(0);
  await closeMenu(ana.page, 'Beto');

  // o próprio tile: nenhum grupo de áudio (não se ouve a si mesmo), só as ações
  menu = await openMenu(ana.page, tileOf(ana.page, 'Ana'), 'Ana (você)');
  await expect(menu.getByRole('group')).toHaveCount(0);
  for (const item of ['Destacar Ana (você)', 'Tela cheia Ana (você)', 'Fechar Ana (você)']) {
    await expect(menu.getByRole('menuitem', { name: item, exact: true })).toBeVisible();
  }
  await closeMenu(ana.page, 'Ana (você)');

  // Beto passa a compartilhar: no tile dele, na página da Ana, aparecem os DOIS grupos, distintos
  await shareButton(beto.page).click();
  await expect(betoTile).toHaveAttribute('data-sharing', 'true');
  menu = await openMenu(ana.page, betoTile, 'Beto');
  await expect(menu.getByRole('group', { name: 'Voz de Beto' })).toBeVisible();
  const transmission = menu.getByRole('group', { name: 'Som da transmissão de Beto' });
  await expect(transmission).toBeVisible();
  await expect(menu.getByRole('group', { name: 'Voz de Beto' }).getByText('Voz de Beto')).toBeVisible();
  await expect(transmission.getByText('Som da transmissão')).toBeVisible();
  await expect(transmission.getByText('Abra a tela para ouvir')).toBeVisible(); // a tela começa fechada
  // os controles existem e funcionam mesmo com a tela fechada
  await expect(transmission.getByRole('button', { name: 'Ativar som da aba de Beto' })).toBeVisible();
  await expect(transmission.getByRole('slider', { name: 'Volume da aba de Beto' })).toBeVisible();
  // e o item de ação oferece abrir a tela
  await expect(menu.getByRole('menuitem', { name: 'Fechar tela de Beto', exact: true })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Ver tela de Beto', exact: true }).click();
  await expect(menuOf(ana.page, 'Beto')).toHaveCount(0); // acionar um item de ação fecha o menu
  await expect(betoTile).toHaveAttribute('data-showing', 'screen');

  // com a tela aberta: sem a nota, e o item vira "Fechar tela"
  menu = await openMenu(ana.page, betoTile, 'Beto');
  await expect(menu.getByText('Abra a tela para ouvir')).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Ver tela de Beto', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Fechar tela de Beto', exact: true })).toBeVisible();
  await closeMenu(ana.page, 'Beto');

  // quem compartilha vê, no próprio tile, "Parar de compartilhar" e nenhum grupo de áudio
  menu = await openMenu(beto.page, tileOf(beto.page, 'Beto'), 'Beto (você)');
  await expect(menu.getByRole('group')).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Parar de compartilhar tela', exact: true })).toBeVisible();
  await closeMenu(beto.page, 'Beto (você)');

  expect(ana.errors).toEqual([]);
  expect(beto.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('o botão "Mais opções" do overlay abre o MESMO menu do botão direito', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'menu-mais');
  await expectConnected(ana.page, 'Beto');
  const tile = tileOf(ana.page, 'Beto');

  await tile.hover();
  await tile.getByRole('button', { name: 'Mais opções de Beto' }).click();
  const menu = menuOf(ana.page, 'Beto');
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('group', { name: 'Voz de Beto' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Destacar Beto', exact: true })).toBeVisible();
  const viaButton = await menu.getByRole('menuitem').allInnerTexts();
  expect(viaButton.length).toBeGreaterThanOrEqual(3); // destacar, tela cheia, fechar
  await closeMenu(ana.page, 'Beto');

  // o mesmo conteúdo que o botão direito mostra
  const viaRightClick = await openMenu(ana.page, tile, 'Beto');
  await expect(viaRightClick.getByRole('group', { name: 'Voz de Beto' })).toBeVisible();
  expect(await viaRightClick.getByRole('menuitem').allInnerTexts()).toEqual(viaButton);
  await closeMenu(ana.page, 'Beto');
  await ana.ctx.close();
  await beto.ctx.close();
});

test('menu: Esc e clique fora fecham, ajustar volume não fecha, e só mexe na fonte do tile escolhido', async ({ browser }) => {
  const room = uniqueRoom('menu-fecha');
  const ana = await newUser(browser);
  const beto = await newUser(browser);
  const cris = await newUser(browser);
  await enter(ana, room, 'Ana');
  await enter(beto, room, 'Beto');
  await enter(cris, room, 'Cris');
  await expectConnected(ana.page, 'Beto');
  await expectConnected(ana.page, 'Cris');
  const voices = audioOf(ana.page, 'camera');
  await expect(voices).toHaveCount(2);
  const volumes = () => voices.evaluateAll((els) => (els as HTMLAudioElement[]).map((a) => Math.round(a.volume * 100)).sort((x, y) => x - y));
  const betoTile = tileOf(ana.page, 'Beto');

  // ajustar o volume NÃO fecha o menu e só mexe na voz do Beto (a da Cris continua em 100)
  const menu = await openMenu(ana.page, betoTile, 'Beto');
  await menu.getByRole('slider', { name: 'Volume de Beto' }).fill('30');
  await expect.poll(volumes).toEqual([30, 100]);
  await expect(menu).toBeVisible();

  // Esc fecha
  await closeMenu(ana.page, 'Beto');
  await expect.poll(volumes).toEqual([30, 100]); // fechar não desfaz nada

  // clique fora fecha
  const again = await openMenu(ana.page, betoTile, 'Beto');
  await ana.page.locator('.topbar').click({ position: { x: 5, y: 5 } });
  await expect(again).toHaveCount(0);

  // acionar um item de ação fecha o menu e age (aqui: destacar)
  const third = await openMenu(ana.page, betoTile, 'Beto');
  await third.getByRole('menuitem', { name: 'Destacar Beto', exact: true }).click();
  await expect(menuOf(ana.page, 'Beto')).toHaveCount(0);
  await expect(betoTile).toHaveAttribute('data-selected', 'true');

  // é só deste navegador: nas páginas dos outros nada mudou
  for (const other of [beto, cris]) {
    const vols = await audioOf(other.page, 'camera').evaluateAll((els) => (els as HTMLAudioElement[]).map((a) => Math.round(a.volume * 100)));
    expect(vols.every((v) => v === 100)).toBe(true);
  }
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
  await cris.ctx.close();
});

test('"Fechar tela de ..." no menu fecha a tela, mantém o tile e para o som da aba', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'menu-fechartela');
  await expectConnected(beto.page, 'Ana');
  await shareButton(ana.page).click();
  const tile = tileOf(beto.page, 'Ana');
  await tile.getByRole('button', { name: 'Ver tela de Ana' }).click();
  await expect(tile).toHaveAttribute('data-showing', 'screen');
  const sound = beto.page.locator('[data-testid^="audio-screen:"]');
  await expect(sound).toHaveCount(1);
  await expect.poll(() => sound.evaluate((a: HTMLAudioElement) => a.srcObject !== null)).toBe(true);

  const menu = await openMenu(beto.page, tile, 'Ana');
  await menu.getByRole('menuitem', { name: 'Fechar tela de Ana', exact: true }).click();
  await expect(menuOf(beto.page, 'Ana')).toHaveCount(0); // item de ação fecha o menu
  await expect(tile).toHaveAttribute('data-showing', 'camera');
  await expect(tile).toHaveAttribute('data-sharing', 'true'); // ela segue compartilhando; só deixei de ver
  await expect(tile.locator('.avatar')).toBeVisible();
  await expect(tile.getByRole('button', { name: 'Ver tela de Ana' })).toBeVisible();
  await expect(tilesOf(beto.page)).toHaveCount(2);
  await expect.poll(() => sound.evaluate((a: HTMLAudioElement) => a.srcObject === null)).toBe(true); // o som da aba parou
  await expect(beto.page.getByRole('region', { name: 'Telas fechadas' })).toHaveCount(0);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('distinção visual: o selo da voz silenciada e o chip "aba sem som" são independentes', async ({ browser }) => {
  const room = uniqueRoom('selos');
  const ana = await newUser(browser);
  const beto = await newUser(browser);
  await ana.ctx.addInitScript(FAKE_TAB_WITH_AUDIO);
  await enter(ana, room, 'Ana');
  await enter(beto, room, 'Beto');
  await expectConnected(beto.page, 'Ana');
  await shareButton(ana.page).click();
  const tile = tileOf(beto.page, 'Ana');
  await tile.getByRole('button', { name: 'Ver tela de Ana' }).click();
  await expect(tile).toHaveAttribute('data-showing', 'screen');

  const chip = tile.locator('.tile-flag-tab');
  const vozSilenciada = tile.locator('[title="Você silenciou esta pessoa"]');
  // a tela de outra pessoa abre com o som da aba silenciado: o chip diz isso em TEXTO; a voz não está silenciada
  await expect(chip).toHaveText('aba sem som');
  await expect(chip).toHaveClass(/tile-flag-local/);
  await expect(vozSilenciada).toHaveCount(0);

  const menu = await openMenu(beto.page, tile, 'Ana');
  const transmission = menu.getByRole('group', { name: 'Som da transmissão de Ana' });
  const voz = menu.getByRole('group', { name: 'Voz de Ana' });

  // ativar o som da transmissão tira o chip e NÃO mexe no selo de voz
  await transmission.getByRole('button', { name: 'Ativar som da aba de Ana' }).click();
  await expect(chip).toHaveCount(0);
  await expect(vozSilenciada).toHaveCount(0);

  // silenciar a voz mostra o selo de voz e NÃO traz o chip de volta
  await voz.getByRole('button', { name: 'Silenciar Ana' }).click();
  await expect(vozSilenciada).toBeVisible();
  await expect(chip).toHaveCount(0);

  // e silenciar a transmissão de novo mostra o chip, com o selo de voz ainda lá: os dois coexistem, distintos
  await transmission.getByRole('button', { name: 'Silenciar som da aba de Ana' }).click();
  await expect(chip).toHaveText('aba sem som');
  await expect(vozSilenciada).toBeVisible();
  await expect(vozSilenciada).not.toHaveText('aba sem som'); // o selo de voz é ícone, não o chip de texto

  // ativar a voz tira só o selo de voz
  await voz.getByRole('button', { name: 'Ativar som de Ana' }).click();
  await expect(vozSilenciada).toHaveCount(0);
  await expect(chip).toHaveText('aba sem som');
  await closeMenu(beto.page, 'Ana');
  expect(beto.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('painel Participantes: nome longo fica em UMA linha (nunca letra por letra) e o volume vai para a segunda linha', async ({ browser }) => {
  const room = uniqueRoom('nome-longo');
  const ana = await newUser(browser);
  const longo = await newUser(browser);
  const nome = 'Cristiano Ronaldo dos Santos Aveiro'; // 35 letras: bem maior que o espaço da coluna do nome
  await enter(ana, room, 'Ana');
  await enter(longo, room, nome);
  await expectConnected(ana.page, 'Cristiano');

  const row = participants(ana.page).filter({ hasText: 'Cristiano' });
  const name = row.locator('.grow').first();
  const m = await name.evaluate((el: HTMLElement) => {
    const cs = getComputedStyle(el);
    return { height: el.getBoundingClientRect().height, fontSize: parseFloat(cs.fontSize), whiteSpace: cs.whiteSpace, textOverflow: cs.textOverflow };
  });
  // uma linha: menos que o dobro do tamanho da fonte (escrito na vertical daria várias linhas)
  expect(m.height).toBeLessThan(m.fontSize * 2);
  expect(m.whiteSpace).toBe('nowrap');
  expect(m.textOverflow).toBe('ellipsis');
  // o nome continua inteiro no DOM (a reticência é só visual)
  await expect(name).toContainText(nome);

  // o controle de volume fica numa segunda linha: começa abaixo do nome, não ao lado dele
  const volume = row.locator('.row-volume');
  await expect(volume.getByRole('slider', { name: `Volume de ${nome}` })).toBeVisible();
  const nameBox = (await name.boundingBox())!;
  const volumeBox = (await volume.boundingBox())!;
  expect(volumeBox.y).toBeGreaterThanOrEqual(nameBox.y + nameBox.height - 1);

  // um nome curto na mesma lista também fica em uma linha
  const curta = participants(ana.page).filter({ hasText: 'Ana' }).locator('.grow').first();
  expect(await curta.evaluate((el: HTMLElement) => el.getBoundingClientRect().height < parseFloat(getComputedStyle(el).fontSize) * 2)).toBe(true);
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await longo.ctx.close();
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

test('não há limite de pessoas por sala: do 9º em diante todos entram, sem "Sala cheia"', async ({ browser, request }) => {
  const room = uniqueRoom('semlimite');
  for (let i = 0; i < 9; i++) {
    const res = await request.post(`/api/rooms/${room}/join`, { data: { name: `bot${i}` } });
    expect(res.status()).toBe(200);
  }
  // e um navegador de verdade entra por último (10º): vê os controles da reunião, não a tela de sala cheia
  const u = await newUser(browser);
  await enter(u, room, 'Nono');
  await expect(u.page.getByRole('navigation', { name: 'Controles da reunião' })).toBeVisible();
  await expect(u.page.locator('p[role="alert"]')).toHaveCount(0);
  await expect(u.page.getByText('Sala cheia')).toHaveCount(0);
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
