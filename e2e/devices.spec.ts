import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Configurações de dispositivos (microfone e saída de áudio).
 * O Chromium do projeto roda com --use-fake-device-for-media-stream, que expõe dispositivos de áudio falsos.
 */

/** Só para teste: guarda cada MediaStream pedido ao getUserMedia para inspecionar os tracks capturados. */
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
const uniqueRoom = (label: string) => `e2e-dev-${label}-${Date.now()}-${++seq}`;

async function newUser(browser: Browser): Promise<User> {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
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
  await expect(
    ana.page.getByTestId('participants').locator('li').filter({ hasText: 'Beto' }).locator('.badge'),
  ).toHaveText('Conectado');
  return { ana, beto };
}

const tileOf = (p: Page, name: string) => p.locator('figure[data-testid="tile"]', { hasText: name });
const micButton = (p: Page) => p.getByRole('button', { name: 'Microfone', exact: true });

const dialog = (p: Page) => p.getByRole('dialog', { name: 'Configurações' });
const micSelect = (p: Page) => dialog(p).getByLabel('Microfone', { exact: true });
const outputSelect = (p: Page) => dialog(p).getByLabel('Saída de áudio (fone ou alto-falante)', { exact: true });

async function openSettings(p: Page) {
  await p.getByRole('button', { name: 'Configurações' }).click();
  await expect(dialog(p)).toBeVisible();
}

const optionValues = (select: ReturnType<typeof micSelect>) =>
  select.locator('option').evaluateAll((els) => els.map((o) => (o as HTMLOptionElement).value).filter(Boolean));

/** Estado do track de áudio capturado mais recentemente (o que está em uso depois de uma troca). */
const latestAudio = (p: Page) =>
  p.evaluate(() => {
    const streams = (window as unknown as { __streams: MediaStream[] }).__streams.filter((s) => s.getAudioTracks().length > 0);
    const track = streams[streams.length - 1]?.getAudioTracks()[0];
    return track
      ? { captures: streams.length, enabled: track.enabled, live: track.readyState === 'live', deviceId: track.getSettings().deviceId ?? '', label: track.label }
      : null;
  });

/**
 * Espera a captura de áudio assentar antes de tomar a medida de referência: uma escolha salva pode ser
 * reaplicada logo na entrada, e uma captura tardia faria "captures > before" passar antes da troca do teste.
 */
async function settledAudio(p: Page) {
  let last = (await latestAudio(p))?.captures;
  await expect
    .poll(async () => {
      await p.waitForTimeout(300);
      const now = (await latestAudio(p))?.captures;
      const stable = now === last;
      last = now;
      return stable;
    })
    .toBe(true);
  return latestAudio(p);
}

/** Escolhe, entre as opções do select, uma diferente da atual; devolve o id escolhido ou null se não houver. */
async function pickOtherMic(p: Page): Promise<string | null> {
  const current = await micSelect(p).inputValue();
  const other = (await optionValues(micSelect(p))).find((v) => v !== current);
  if (!other) return null;
  await micSelect(p).selectOption(other);
  return other;
}

test('Configurações lista os microfones e a saída de áudio, e fecha por botão, Esc e clique no fundo', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'abrir');
  await openSettings(ana.page);

  expect((await optionValues(micSelect(ana.page))).length).toBeGreaterThan(0);
  await expect(outputSelect(ana.page)).toBeVisible();
  await expect(micSelect(ana.page)).toBeFocused();

  await dialog(ana.page).getByRole('button', { name: 'Fechar' }).click();
  await expect(dialog(ana.page)).toHaveCount(0);

  await openSettings(ana.page);
  await ana.page.keyboard.press('Escape');
  await expect(dialog(ana.page)).toHaveCount(0);

  await openSettings(ana.page);
  await ana.page.mouse.click(5, 5); // fora do cartão, no fundo escuro
  await expect(dialog(ana.page)).toHaveCount(0);

  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('trocar o microfone com ele mutado NÃO desmuta e a chamada continua conectada', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'troca-mutado');
  await expect(micButton(ana.page)).toHaveAttribute('aria-pressed', 'false');
  const before = await settledAudio(ana.page);
  expect(before).not.toBeNull();

  await openSettings(ana.page);
  const chosen = await pickOtherMic(ana.page);
  expect(chosen, 'o Chromium de teste deveria expor 2+ microfones falsos; sem isso a troca não é testada').not.toBeNull();

  await expect.poll(async () => (await latestAudio(ana.page))?.captures).toBeGreaterThan(before!.captures);
  const after = await latestAudio(ana.page);
  expect(after).toMatchObject({ enabled: false, live: true, deviceId: chosen });

  await dialog(ana.page).getByRole('button', { name: 'Fechar' }).click();
  await expect(micButton(ana.page)).toHaveAttribute('aria-pressed', 'false');
  await expect(
    ana.page.getByTestId('participants').locator('li').filter({ hasText: 'Beto' }).locator('.badge'),
  ).toHaveText('Conectado');
  await expect(tileOf(beto.page, 'Ana').locator('.tile-flag')).toBeVisible(); // para o Beto, a Ana segue com o mic cortado
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('trocar o microfone com ele ligado mantém ligado, para a própria Ana e para o Beto', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'troca-ligado');
  await micButton(ana.page).click();
  await expect(micButton(ana.page)).toHaveAttribute('aria-pressed', 'true');
  await expect(tileOf(beto.page, 'Ana').locator('.tile-flag')).toHaveCount(0);
  const before = await settledAudio(ana.page);

  await openSettings(ana.page);
  const chosen = await pickOtherMic(ana.page);
  expect(chosen, 'o Chromium de teste deveria expor 2+ microfones falsos; sem isso a troca não é testada').not.toBeNull();

  await expect.poll(async () => (await latestAudio(ana.page))?.captures).toBeGreaterThan(before!.captures);
  expect(await latestAudio(ana.page)).toMatchObject({ enabled: true, live: true, deviceId: chosen });

  await dialog(ana.page).getByRole('button', { name: 'Fechar' }).click();
  await expect(micButton(ana.page)).toHaveAttribute('aria-pressed', 'true');
  await expect(tileOf(beto.page, 'Ana').locator('.tile-flag')).toHaveCount(0);
  await expect(
    beto.page.getByTestId('participants').locator('li').filter({ hasText: 'Ana' }).locator('.badge'),
  ).toHaveText('Conectado');
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('recarregar a página mantém o microfone escolhido (e volta a usá-lo)', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'lembra');
  await openSettings(ana.page);
  const chosen = await pickOtherMic(ana.page);
  expect(chosen, 'o Chromium de teste deveria expor 2+ microfones falsos; sem isso a troca não é testada').not.toBeNull();
  const chosenLabel = (await micSelect(ana.page).locator('option:checked').textContent())!.trim();

  await ana.page.reload();
  await expect(ana.page.getByRole('navigation', { name: 'Controles da reunião' })).toBeVisible();
  await openSettings(ana.page);
  // o Chromium gera ids novos a cada carregamento: o que se mantém é o nome do dispositivo
  await expect(micSelect(ana.page).locator('option:checked')).toHaveText(chosenLabel);
  // e o app abre esse dispositivo de fato, não só mostra no seletor
  await expect.poll(async () => (await latestAudio(ana.page))?.label).toBe(chosenLabel);
  await expect(micButton(ana.page)).toHaveAttribute('aria-pressed', 'false'); // continua entrando mutado
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('escolher outra saída de áudio vale para o som remoto e é lembrada', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'saida');
  await openSettings(ana.page);
  await expect(outputSelect(ana.page)).toBeEnabled(); // Chromium suporta setSinkId
  const current = await outputSelect(ana.page).inputValue();
  const other = (await optionValues(outputSelect(ana.page))).find((v) => v !== current);
  expect(other, 'o Chromium de teste deveria expor 2+ saídas de áudio falsas; sem isso a troca não é testada').toBeTruthy();

  await outputSelect(ana.page).selectOption(other!);
  const chosenLabel = (await outputSelect(ana.page).locator('option:checked').textContent())!.trim();
  await dialog(ana.page).getByRole('button', { name: 'Fechar' }).click();
  await expect
    .poll(() => ana.page.locator('[data-testid^="audio-camera:"]').evaluate((a: HTMLAudioElement & { sinkId?: string }) => a.sinkId))
    .toBe(other);

  await ana.page.reload();
  await openSettings(ana.page);
  await expect(outputSelect(ana.page).locator('option:checked')).toHaveText(chosenLabel);
  // e a saída escolhida vale de fato para o som remoto (o <audio> do Beto) depois de recarregar (os ids são novos, o sinkId acompanha a opção marcada)
  const selectedId = await outputSelect(ana.page).inputValue();
  await dialog(ana.page).getByRole('button', { name: 'Fechar' }).click();
  await expect
    .poll(() => ana.page.locator('[data-testid^="audio-camera:"]').evaluate((a: HTMLAudioElement & { sinkId?: string }) => a.sinkId))
    .toBe(selectedId);
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('Configurações em janela baixa: título e "Fechar" ficam à vista e só o miolo rola, com barra fina', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'scroll');
  await ana.page.setViewportSize({ width: 1100, height: 560 });
  await openSettings(ana.page);

  const body = dialog(ana.page).locator('.sd-body');
  await expect(body).toBeVisible();
  const m = await body.evaluate((el: HTMLElement) => ({
    scrolls: el.scrollHeight > el.clientHeight,
    thin: getComputedStyle(el).scrollbarWidth,
    overflowY: getComputedStyle(el).overflowY,
  }));
  expect(m.scrolls).toBe(true); // há mais conteúdo que o espaço: o miolo rola
  expect(m.overflowY).toBe('auto');
  expect(m.thin).toBe('thin');
  // o cartão em si não rola (isso faria título, cantos e botão irem embora junto)
  const card = await dialog(ana.page).evaluate((el: HTMLElement) => ({ scroll: el.scrollHeight, client: el.clientHeight, overflow: getComputedStyle(el).overflowY }));
  expect(card.scroll).toBeLessThanOrEqual(card.client + 1);
  expect(card.overflow).toBe('hidden');

  // no fim da rolagem, o título e o botão continuam na janela
  await body.evaluate((el: HTMLElement) => el.scrollTo(0, el.scrollHeight));
  const inView = (loc: ReturnType<typeof dialog>) =>
    loc.evaluate((el: HTMLElement) => {
      const r = el.getBoundingClientRect();
      return r.top >= 0 && r.bottom <= window.innerHeight;
    });
  expect(await inView(dialog(ana.page).getByRole('heading', { name: 'Configurações', level: 2 }))).toBe(true);
  expect(await inView(dialog(ana.page).getByRole('button', { name: 'Fechar' }))).toBe(true);
  // o último campo da seção Transmissão é alcançável rolando
  await expect(dialog(ana.page).getByRole('button', { name: 'Restaurar automático' })).toBeVisible();

  await dialog(ana.page).getByRole('button', { name: 'Fechar' }).click();
  await expect(dialog(ana.page)).toHaveCount(0);
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});
