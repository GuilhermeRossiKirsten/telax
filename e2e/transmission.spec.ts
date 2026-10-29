import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/** Configurações de transmissão (qualidade, fps, taxa de bits, prioridade): valem para o que a pessoa ENVIA. */

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

type User = { ctx: BrowserContext; page: Page; errors: string[] };

let seq = 0;
const uniqueRoom = (label: string) => `e2e-tx-${label}-${Date.now()}-${++seq}`;

async function newUser(browser: Browser): Promise<User> {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(TRACK_PCS);
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
  await expect(ana.page.getByTestId('participants').locator('li').filter({ hasText: 'Beto' }).locator('.badge')).toHaveText('Conectado');
  return { ana, beto };
}

const dialog = (p: Page) => p.getByRole('dialog', { name: 'Configurações' });
const field = (p: Page, label: string) => dialog(p).getByLabel(label, { exact: true });

async function openSettings(p: Page) {
  await p.getByRole('button', { name: 'Configurações' }).click();
  await expect(dialog(p)).toBeVisible();
}
async function closeSettings(p: Page) {
  await dialog(p).getByRole('button', { name: 'Fechar' }).click();
  await expect(dialog(p)).toHaveCount(0);
}

type Sent = { kind: string; hint: string; maxBitrate?: number; maxFramerate?: number };
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
        return {
          kind: 'video',
          hint: (s.track as MediaStreamTrack & { contentHint?: string }).contentHint ?? '',
          maxBitrate: enc.maxBitrate,
          maxFramerate: enc.maxFramerate,
        };
      });
  });

test('a seção Transmissão está nas Configurações, tudo no automático por padrão', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'secao');
  await openSettings(ana.page);
  await expect(dialog(ana.page).getByRole('heading', { name: 'Transmissão' })).toBeVisible();
  for (const label of ['Resolução da câmera', 'FPS da câmera', 'Taxa de bits máxima da câmera', 'Resolução da tela', 'FPS da tela', 'Taxa de bits máxima da tela', 'Prioridade da tela']) {
    await expect(field(ana.page, label)).toBeVisible();
  }
  await expect(field(ana.page, 'Resolução da câmera')).toHaveValue('auto');
  await expect(field(ana.page, 'FPS da câmera')).toHaveValue('0');
  await expect(ana.page.getByTestId('upload-estimate')).toContainText('Sem limite');
  await expect(dialog(ana.page).getByRole('button', { name: 'Restaurar automático' })).toBeDisabled();
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('a resolução da câmera muda de verdade a captura e a janela mostra o que ficou em uso', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'camera-res');
  await openSettings(ana.page);
  const inUse = ana.page.getByTestId('in-use-camera');
  const width = async () => Number(/^(\d+)×/.exec((await inUse.textContent())?.replace('Em uso agora: ', '') ?? '')?.[1] ?? 0);

  await field(ana.page, 'Resolução da câmera').selectOption('720p');
  await expect.poll(width).toBeGreaterThanOrEqual(1280);
  const hd = await width();
  await field(ana.page, 'Resolução da câmera').selectOption('360p');
  await expect.poll(width).toBeLessThan(hd);
  const small = await width();
  // pedir mais do que o dispositivo tem não quebra: a captura entrega o que o dispositivo suporta e a janela mostra isso
  await field(ana.page, 'Resolução da câmera').selectOption('1080p');
  await expect.poll(width).toBeGreaterThan(small);
  expect(await width()).toBeLessThanOrEqual(1920);

  await closeSettings(ana.page);
  await expect(ana.page.getByTestId('participants').locator('li').filter({ hasText: 'Beto' }).locator('.badge')).toHaveText('Conectado');
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('taxa de bits e fps da câmera viram limites reais no sender, e "Restaurar automático" tira os limites', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'camera-tx');
  await openSettings(ana.page);
  await field(ana.page, 'Taxa de bits máxima da câmera').selectOption('800');
  await field(ana.page, 'FPS da câmera').selectOption('15');
  await expect(ana.page.getByTestId('upload-estimate')).toContainText('800 kbps'); // 2 pessoas: 1 outro fluxo
  await expect.poll(async () => (await sentVideo(ana.page))[0]).toMatchObject({ maxBitrate: 800_000, maxFramerate: 15 });

  await dialog(ana.page).getByRole('button', { name: 'Restaurar automático' }).click();
  await expect(field(ana.page, 'FPS da câmera')).toHaveValue('0');
  await expect.poll(async () => (await sentVideo(ana.page))[0]).toMatchObject({ maxBitrate: undefined, maxFramerate: undefined });
  await expect(dialog(ana.page).getByRole('button', { name: 'Restaurar automático' })).toBeDisabled();
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('as escolhas são lembradas ao recarregar e valem de novo na conexão nova', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'lembra');
  await openSettings(ana.page);
  await field(ana.page, 'Taxa de bits máxima da câmera').selectOption('300');
  await field(ana.page, 'Resolução da câmera').selectOption('480p');
  await closeSettings(ana.page);

  await ana.page.reload();
  await expect(ana.page.getByRole('navigation', { name: 'Controles da reunião' })).toBeVisible();
  await openSettings(ana.page);
  await expect(field(ana.page, 'Taxa de bits máxima da câmera')).toHaveValue('300');
  await expect(field(ana.page, 'Resolução da câmera')).toHaveValue('480p');
  await closeSettings(ana.page);
  // reconectou com o Beto: o limite vale também no sender da conexão recriada
  await expect(ana.page.getByTestId('participants').locator('li').filter({ hasText: 'Beto' }).locator('.badge')).toHaveText('Conectado');
  await expect.poll(async () => (await sentVideo(ana.page))[0]).toMatchObject({ maxBitrate: 300_000 });
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('tela: prioridade vira contentHint e taxa/fps viram limites do sender da tela', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'tela');
  await openSettings(ana.page);
  await field(ana.page, 'Prioridade da tela').selectOption('detail');
  await field(ana.page, 'Taxa de bits máxima da tela').selectOption('1000');
  await field(ana.page, 'FPS da tela').selectOption('15');
  await closeSettings(ana.page);

  await ana.page.getByRole('button', { name: 'Tela', exact: true }).click();
  await expect
    .poll(async () => (await sentVideo(ana.page)).find((s) => s.hint === 'detail'))
    .toMatchObject({ hint: 'detail', maxBitrate: 1_000_000, maxFramerate: 15 });

  // a janela diz o que a captura da tela entrega de fato, e a câmera segue sem limite
  await openSettings(ana.page);
  await expect(ana.page.getByTestId('in-use-screen')).toContainText('×');
  const camera = (await sentVideo(ana.page)).find((s) => s.hint !== 'detail');
  expect(camera?.maxBitrate).toBeUndefined();
  await closeSettings(ana.page);

  // mudar com a tela aberta vale na hora
  await openSettings(ana.page);
  await field(ana.page, 'Prioridade da tela').selectOption('motion');
  await expect.poll(async () => (await sentVideo(ana.page)).some((s) => s.hint === 'motion')).toBe(true);
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});
