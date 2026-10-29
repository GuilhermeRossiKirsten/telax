import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * Várias telas por pessoa (até 3, em slots fixos) e controle de volume no painel Participantes.
 * Contrato: seção "Várias telas por pessoa" de docs/superpowers/specs/2026-10-28-telas-e-dispositivos-design.md.
 */

/** Só para teste: registra as RTCPeerConnection criadas pela página para inspecionar os senders. */
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

/**
 * Só para teste: cada chamada a getDisplayMedia entrega uma tela DIFERENTE (cor fixa e tom próprios):
 * 1ª vermelha/440 Hz, 2ª verde/660 Hz, 3ª azul/880 Hz. Como o navegador de verdade, só entrega áudio se o app o pediu.
 * Um quadrado branco se move para o vídeo ter quadros novos o tempo todo.
 */
const FAKE_SCREENS = () => {
  let calls = 0;
  const COLORS = ['#e02020', '#20c040', '#2060e0'];
  const TONES = [440, 660, 880];
  navigator.mediaDevices.getDisplayMedia = async (options) => {
    const n = calls++ % 3;
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const g = canvas.getContext('2d')!;
    let x = 0;
    setInterval(() => {
      g.fillStyle = COLORS[n];
      g.fillRect(0, 0, 640, 360);
      g.fillStyle = '#fff';
      g.fillRect((x = (x + 9) % 600), 10, 24, 24);
    }, 50);
    const ac = new AudioContext();
    void ac.resume();
    const osc = ac.createOscillator();
    osc.frequency.value = TONES[n];
    const dest = ac.createMediaStreamDestination();
    osc.connect(dest);
    osc.start();
    const audio = options?.audio ? dest.stream.getAudioTracks() : [];
    return new MediaStream([...canvas.captureStream(15).getVideoTracks(), ...audio]);
  };
};

type User = { ctx: BrowserContext; page: Page; errors: string[] };

let seq = 0;
const uniqueRoom = (label: string) => `e2e-multi-${label}-${Date.now()}-${++seq}`;

async function newUser(browser: Browser, sharer = false): Promise<User> {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(TRACK_PCS);
  if (sharer) await ctx.addInitScript(FAKE_SCREENS);
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

/** Ana (a que compartilha, com o stub de telas) e Beto, já conectados. */
async function pair(browser: Browser, label: string) {
  const room = uniqueRoom(label);
  const ana = await newUser(browser, true);
  const beto = await newUser(browser);
  await enter(ana, room, 'Ana');
  await enter(beto, room, 'Beto');
  await expect(participants(beto).filter({ hasText: 'Ana' }).locator('.badge')).toHaveText('Conectado');
  await expect(participants(ana).filter({ hasText: 'Beto' }).locator('.badge')).toHaveText('Conectado');
  return { ana, beto };
}

const participants = (p: Page | User) => ('page' in p ? p.page : p).getByTestId('participants').locator('li');
const tilesOf = (p: Page) => p.locator('figure[data-testid="tile"]');
/** O tile da PESSOA (o que tem avatar/câmera); a tela de menor slot ativo ocupa o lugar do avatar neste tile. */
const personTile = (p: Page, name: string) => p.locator('figure[data-testid="tile"][data-kind="person"]', { hasText: name });
/** Tile EXTRA de uma tela adicional (slot 1 ou 2). */
const screenTile = (p: Page, slot: number) => p.locator(`figure[data-testid="tile"][data-kind="screen"][data-slot="${slot}"]`);
const extraTiles = (p: Page) => p.locator('figure[data-testid="tile"][data-kind="screen"]');
/** O <audio> do som da aba de uma tela remota (slot 0 = tela do tile da pessoa). */
const tabSound = (p: Page, slot: number) => p.locator(`[data-testid^="audio-screen:"][data-testid$="#${slot}"]`);
const voice = (p: Page) => p.locator('[data-testid^="audio-camera:"]');

const shareButton = (p: Page) => p.getByRole('button', { name: 'Tela', exact: true });
const stopAllButton = (p: Page) => p.getByRole('button', { name: 'Parar compartilhamento', exact: true });

/**
 * Clica em `Tela` n vezes, esperando cada tela aparecer: com Ana e Beto, i telas = i + 1 tiles (pessoa + extras + Beto).
 * `already` = quantas telas ela já compartilhava antes desta chamada.
 */
async function shareScreens(u: User, n: number, already = 0) {
  for (let i = already + 1; i <= already + n; i++) {
    await shareButton(u.page).click();
    await expect(tilesOf(u.page)).toHaveCount(i + 1);
  }
}

/** Cor dominante ('r' | 'g' | 'b') do vídeo principal do tile, por amostragem num canvas. */
const dominantColor = (tile: Locator) =>
  tile.locator('video:not(.tile-inset)').evaluate((v: HTMLVideoElement) => {
    if (!v.videoWidth) return 'sem-video';
    const c = document.createElement('canvas');
    c.width = 32;
    c.height = 18;
    const g = c.getContext('2d')!;
    g.drawImage(v, 0, 0, 32, 18);
    const d = g.getImageData(0, 0, 32, 18).data;
    let r = 0;
    let gr = 0;
    let b = 0;
    for (let i = 0; i < d.length; i += 4) {
      r += d[i];
      gr += d[i + 1];
      b += d[i + 2];
    }
    return r > gr && r > b ? 'r' : gr > r && gr > b ? 'g' : 'b';
  });

/** Frequência dominante (Hz) do áudio de um elemento, medida nas faixas dele (não depende de estar mudo no elemento). */
const peakHz = (audio: Locator) =>
  audio.evaluate(async (a: HTMLAudioElement) => {
    const ac = new AudioContext();
    await ac.resume();
    const src = ac.createMediaStreamSource(new MediaStream((a.srcObject as MediaStream).getAudioTracks()));
    const an = ac.createAnalyser();
    an.fftSize = 4096;
    src.connect(an);
    const bins = new Float32Array(an.frequencyBinCount);
    const end = performance.now() + 5000;
    while (performance.now() < end) {
      an.getFloatFrequencyData(bins);
      let idx = 0;
      for (let i = 1; i < bins.length; i++) if (bins[i] > bins[idx]) idx = i;
      if (bins[idx] > -60) return (idx * ac.sampleRate) / an.fftSize;
      await new Promise((r) => setTimeout(r, 100));
    }
    return 0;
  });

type Sent = { hint: string; maxBitrate?: number; maxFramerate?: number };
/** O que o navegador realmente aplicou em cada sender de VÍDEO com faixa, na conexão mais recente. */
const sentVideo = (p: Page) =>
  p.evaluate<Sent[]>(() => {
    const pcs = (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs;
    const pc = pcs[pcs.length - 1];
    return pc
      .getSenders()
      .filter((s) => s.track?.kind === 'video')
      .map((s) => {
        const enc = s.getParameters().encodings?.[0] ?? {};
        return { hint: (s.track as MediaStreamTrack & { contentHint?: string }).contentHint ?? '', maxBitrate: enc.maxBitrate, maxFramerate: enc.maxFramerate };
      });
  });

test('Ana compartilha 2 telas: Beto vê o tile da pessoa + um tile extra, ambos com a tela fechada', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'duas');
  await shareScreens(ana, 2);

  // Ana pessoa + "Tela 2 de Ana" + Beto
  await expect(tilesOf(beto.page)).toHaveCount(3);
  await expect(beto.page.locator('figure[data-testid="tile"][data-kind="person"]', { hasText: 'Ana' })).toHaveCount(1);
  await expect(extraTiles(beto.page)).toHaveCount(1);

  const person = personTile(beto.page, 'Ana');
  const extra = screenTile(beto.page, 1);
  await expect(person).toHaveAttribute('data-sharing', 'true');
  await expect(person).toHaveAttribute('data-slot', '0');
  // as duas começam FECHADAS, cada uma com o seu convite
  await expect(person).toHaveAttribute('data-showing', 'camera');
  await expect(person.locator('.avatar')).toBeVisible();
  await expect(person.getByRole('button', { name: 'Ver tela de Ana' })).toBeVisible();
  await expect(extra.getByRole('button', { name: 'Ver tela 2 de Ana' })).toBeVisible();
  await expect(tabSound(beto.page, 0)).toHaveCount(1);
  await expect(tabSound(beto.page, 1)).toHaveCount(1);

  // abrir uma por uma
  await person.getByRole('button', { name: 'Ver tela de Ana' }).click();
  await expect(person).toHaveAttribute('data-showing', 'screen');
  await expect(person.locator('.avatar')).toBeHidden();
  await expect(extra.getByRole('button', { name: 'Ver tela 2 de Ana' })).toBeVisible(); // a outra segue fechada
  await extra.getByRole('button', { name: 'Ver tela 2 de Ana' }).click();
  await expect(extra).toHaveAttribute('data-showing', 'screen');
  await expect(extra.getByRole('button', { name: 'Ver tela 2 de Ana' })).toHaveCount(0);
  await expect(tilesOf(beto.page)).toHaveCount(3); // abrir não cria tile nenhum
  await expect(beto.page.getByTestId('tiles')).toHaveAttribute('data-layout', 'spotlight');
  expect(ana.errors).toEqual([]);
  expect(beto.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('as duas telas são de fato diferentes: cor do vídeo e tom do som de cada uma', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'distintas');
  await shareScreens(ana, 2);
  const person = personTile(beto.page, 'Ana');
  const extra = screenTile(beto.page, 1);
  await person.getByRole('button', { name: 'Ver tela de Ana' }).click();
  await extra.getByRole('button', { name: 'Ver tela 2 de Ana' }).click();

  // 1ª tela = vermelha, 2ª = verde (ordem das chamadas ao seletor do navegador)
  await expect.poll(() => dominantColor(person)).toBe('r');
  await expect.poll(() => dominantColor(extra)).toBe('g');

  // o som de cada aba é o do seu tom (440 Hz e 660 Hz), cada um no seu <audio>
  const hz0 = await peakHz(tabSound(beto.page, 0));
  const hz1 = await peakHz(tabSound(beto.page, 1));
  expect(Math.abs(hz0 - 440)).toBeLessThan(40);
  expect(Math.abs(hz1 - 660)).toBeLessThan(40);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('o som de cada aba é independente: começam mutados e mutar/volume de uma não mexe na outra nem na voz', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'sons');
  await shareScreens(ana, 2);
  const person = personTile(beto.page, 'Ana');
  const extra = screenTile(beto.page, 1);
  await person.getByRole('button', { name: 'Ver tela de Ana' }).click();
  await extra.getByRole('button', { name: 'Ver tela 2 de Ana' }).click();

  const muted = (slot: number) => tabSound(beto.page, slot).evaluate((a: HTMLAudioElement) => a.muted);
  const volume = (slot: number) => tabSound(beto.page, slot).evaluate((a: HTMLAudioElement) => a.volume);
  const voiceMuted = () => voice(beto.page).evaluate((a: HTMLAudioElement) => a.muted);

  // as duas abas começam mutadas; a voz da Ana não
  await expect.poll(() => muted(0)).toBe(true);
  await expect.poll(() => muted(1)).toBe(true);
  await expect.poll(voiceMuted).toBe(false);

  // ativar o som da tela 2 não ativa o da tela 1
  await extra.hover();
  await extra.getByRole('button', { name: 'Ativar som da aba 2 de Ana' }).click();
  await expect.poll(() => muted(1)).toBe(false);
  expect(await muted(0)).toBe(true);

  // volume de uma não altera a outra (nem a voz)
  await extra.hover();
  await extra.getByRole('slider', { name: 'Volume da aba 2 de Ana' }).fill('30');
  await expect.poll(() => volume(1)).toBeCloseTo(0.3, 2);
  expect(await volume(0)).toBe(1);
  expect(await voice(beto.page).evaluate((a: HTMLAudioElement) => a.volume)).toBe(1);

  await person.hover();
  await person.getByRole('button', { name: 'Ativar som da aba de Ana' }).click();
  await expect.poll(() => muted(0)).toBe(false);
  await person.getByRole('slider', { name: 'Volume da aba de Ana' }).fill('60');
  await expect.poll(() => volume(0)).toBeCloseTo(0.6, 2);
  expect(await volume(1)).toBeCloseTo(0.3, 2); // a da tela 2 continua como estava
  expect(await muted(1)).toBe(false);
  expect(await voiceMuted()).toBe(false);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('parar só a tela do slot 0: a tela 2 assume o tile da pessoa e, se estava aberta, continua aberta', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'parar-uma');
  await shareScreens(ana, 2);
  const person = personTile(beto.page, 'Ana');
  // Beto abre só a tela 2 (a do tile extra); a tela 1 fica fechada
  await screenTile(beto.page, 1).getByRole('button', { name: 'Ver tela 2 de Ana' }).click();
  await expect(screenTile(beto.page, 1)).toHaveAttribute('data-showing', 'screen');
  await expect(person).toHaveAttribute('data-showing', 'camera');

  // Ana para só a primeira, pelo overlay do próprio tile
  const mine = personTile(ana.page, 'Ana');
  await mine.hover();
  await mine.getByRole('button', { name: 'Parar de compartilhar tela', exact: true }).click();

  // a de menor slot ativo (a 2ª) passa a ocupar o tile da pessoa; o tile extra some
  await expect(extraTiles(beto.page)).toHaveCount(0);
  await expect(tilesOf(beto.page)).toHaveCount(2);
  await expect(person).toHaveAttribute('data-sharing', 'true');
  await expect(person).toHaveAttribute('data-slot', '1');
  await expect(person).toHaveAttribute('data-showing', 'screen'); // não voltou a ficar fechada
  await expect(person.getByRole('button', { name: /Ver tela/ })).toHaveCount(0);
  await expect.poll(() => dominantColor(person)).toBe('g'); // e é mesmo a tela verde (a 2ª)
  await expect(tabSound(beto.page, 0)).toHaveCount(0);
  await expect(tabSound(beto.page, 1)).toHaveCount(1);

  // do lado da Ana: o próprio tile agora mostra a tela 2, com o botão dela
  await expect(extraTiles(ana.page)).toHaveCount(0);
  await expect(mine).toHaveAttribute('data-slot', '1');
  await mine.hover();
  await expect(mine.getByRole('button', { name: 'Parar de compartilhar tela 2', exact: true })).toBeVisible();
  expect(ana.errors).toEqual([]);
  expect(beto.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('limite de 3 telas: "Tela" desabilita; "Parar compartilhamento" para todas e os tiles extras somem', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'limite');
  await shareScreens(ana, 3);
  await expect(tilesOf(beto.page)).toHaveCount(4); // Ana + 2 extras + Beto
  await expect(extraTiles(beto.page)).toHaveCount(2);
  await expect(shareButton(ana.page)).toBeDisabled();
  await expect(shareButton(ana.page)).toHaveAttribute('title', /3|três|máximo|limite/i);
  await expect(shareButton(ana.page)).toHaveAttribute('aria-pressed', 'true');

  await stopAllButton(ana.page).click();
  for (const page of [ana.page, beto.page]) {
    await expect(extraTiles(page)).toHaveCount(0);
    await expect(tilesOf(page)).toHaveCount(2);
    await expect(page.locator('figure[data-testid="tile"][data-sharing="true"]')).toHaveCount(0);
    await expect(page.locator('[data-testid^="audio-screen:"]')).toHaveCount(0);
  }
  await expect(shareButton(ana.page)).toBeEnabled();
  await expect(stopAllButton(ana.page)).toHaveCount(0);
  expect(ana.errors).toEqual([]);
  expect(beto.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('quem compartilha 2 telas e fecha a aba some inteira: sem tiles, sem som e sem estado órfão', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'sair');
  await shareScreens(ana, 2);
  await openBothScreens(beto);
  await expect(tilesOf(beto.page)).toHaveCount(3);

  await ana.page.close({ runBeforeUnload: true });
  await expect(participants(beto.page)).toHaveCount(1, { timeout: 25_000 });
  await expect(tilesOf(beto.page)).toHaveCount(1); // só o próprio
  await expect(extraTiles(beto.page)).toHaveCount(0);
  await expect(beto.page.locator('[data-testid^="audio-screen:"], [data-testid^="audio-camera:"]')).toHaveCount(0);
  await expect(beto.page.getByRole('region', { name: 'Telas fechadas' })).toHaveCount(0);
  await expect(beto.page.getByTestId('tiles')).toHaveAttribute('data-layout', 'grid');
  expect(beto.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

/** Beto abre as duas telas da Ana. */
async function openBothScreens(beto: User) {
  await personTile(beto.page, 'Ana').getByRole('button', { name: 'Ver tela de Ana' }).click();
  await screenTile(beto.page, 1).getByRole('button', { name: 'Ver tela 2 de Ana' }).click();
  await expect(screenTile(beto.page, 1)).toHaveAttribute('data-showing', 'screen');
}

test('painel Participantes: a linha mostra quantas telas a pessoa compartilha (só quando > 1)', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'contagem');
  const row = participants(beto).filter({ hasText: 'Ana' });

  const person = personTile(beto.page, 'Ana');

  await shareScreens(ana, 1);
  await expect(person).toHaveAttribute('data-sharing', 'true'); // já chegou: agora a ausência do número vale
  await expect(row.locator('.screen-count')).toBeVisible();
  await expect(row.locator('.screen-count span')).toHaveCount(0); // com 1 tela só o ícone, sem número
  await shareScreens(ana, 1, 1);
  // suposição: o número aparece como texto na linha, junto do ícone de tela
  await expect(row.locator('.screen-count span')).toHaveText('2');
  await shareScreens(ana, 1, 2);
  await expect(row.locator('.screen-count span')).toHaveText('3');

  await stopAllButton(ana.page).click();
  await expect(person).not.toHaveAttribute('data-sharing', 'true');
  await expect(row.locator('.screen-count')).toHaveCount(0); // parou tudo: sem ícone nem número
  await ana.ctx.close();
  await beto.ctx.close();
});

test('painel Participantes: o volume e o silenciar da linha são os MESMOS do overlay do tile', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'volume-painel');
  const row = participants(beto).filter({ hasText: 'Ana' });
  const tile = personTile(beto.page, 'Ana');
  const sound = voice(beto.page);
  const volume = () => sound.evaluate((a: HTMLAudioElement) => a.volume);
  const muted = () => sound.evaluate((a: HTMLAudioElement) => a.muted);
  await expect.poll(() => sound.evaluate((a: HTMLAudioElement) => !a.paused)).toBe(true);

  // só as OUTRAS pessoas têm controle de voz; a linha do próprio Beto não
  await expect(participants(beto).filter({ hasText: 'Beto' }).getByRole('slider')).toHaveCount(0);
  await expect(row.getByRole('slider', { name: 'Volume de Ana' })).toBeVisible();

  // painel -> áudio e tile
  await row.getByRole('slider', { name: 'Volume de Ana' }).fill('40');
  await expect.poll(volume).toBeCloseTo(0.4, 2);
  await tile.hover();
  await expect(tile.getByRole('slider', { name: 'Volume de Ana' })).toHaveValue('40');

  // tile -> painel
  await tile.getByRole('slider', { name: 'Volume de Ana' }).fill('70');
  await expect.poll(volume).toBeCloseTo(0.7, 2);
  await expect(row.getByRole('slider', { name: 'Volume de Ana' })).toHaveValue('70');

  // silenciar pelo painel aparece no tile (e no áudio) e vice-versa
  await row.getByRole('button', { name: 'Silenciar Ana' }).click();
  await expect.poll(muted).toBe(true);
  await tile.hover();
  await expect(tile.getByRole('button', { name: 'Ativar som de Ana' })).toBeVisible();
  await tile.getByRole('button', { name: 'Ativar som de Ana' }).click();
  await expect.poll(muted).toBe(false);
  await expect(row.getByRole('button', { name: 'Silenciar Ana' })).toBeVisible();

  // é só deste navegador: o áudio do Beto na página da Ana não mudou
  await expect(voice(ana.page)).toHaveCount(1);
  expect(await voice(ana.page).evaluate((a: HTMLAudioElement) => a.volume)).toBe(1);
  expect(ana.errors).toEqual([]);
  expect(beto.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('o limite de taxa da tela vale para TODOS os senders de tela (e não para a câmera)', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'qualidade');
  await ana.page.getByRole('button', { name: 'Configurações' }).click();
  const dialog = ana.page.getByRole('dialog', { name: 'Configurações' });
  await dialog.getByLabel('Taxa de bits máxima da tela', { exact: true }).selectOption('1000');
  await dialog.getByLabel('FPS da tela', { exact: true }).selectOption('15');
  await dialog.getByRole('button', { name: 'Fechar' }).click();

  await shareScreens(ana, 2);
  // câmera + 2 telas = 3 senders de vídeo com faixa; só as 2 telas levam o teto
  await expect
    .poll(async () => {
      const sent = await sentVideo(ana.page);
      return { total: sent.length, capped: sent.filter((s) => s.maxBitrate === 1_000_000 && s.maxFramerate === 15).length, free: sent.filter((s) => s.maxBitrate === undefined).length };
    })
    .toEqual({ total: 3, capped: 2, free: 1 });
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});
