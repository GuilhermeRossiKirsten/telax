import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/** A tela compartilhada aparece inteira, no formato original da transmissão: sem esticar nem cortar. */

type User = { ctx: BrowserContext; page: Page; errors: string[] };

let seq = 0;
const uniqueRoom = (label: string) => `e2e-aspect-${label}-${Date.now()}-${++seq}`;

async function newUser(browser: Browser): Promise<User> {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
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

const tileOf = (p: Page, name: string) => p.locator('figure[data-testid="tile"][data-kind="person"]', { hasText: name });
const fit = (tile: ReturnType<typeof tileOf>) =>
  tile.locator('video:not(.tile-inset)').evaluate((v: HTMLVideoElement) => getComputedStyle(v).objectFit);

test('a tela aberta e o tile selecionado mostram a imagem inteira (contain); a câmera na grade preenche (cover)', async ({ browser }) => {
  const room = uniqueRoom('fit');
  const ana = await newUser(browser);
  const beto = await newUser(browser);
  await enter(ana, room, 'Ana');
  await enter(beto, room, 'Beto');
  await expect(ana.page.getByTestId('participants').locator('li').filter({ hasText: 'Beto' }).locator('.badge')).toHaveText('Conectado');

  // câmera de Beto na grade, sem seleção: preenche o tile
  await beto.page.getByRole('button', { name: 'Câmera', exact: true }).click();
  const camOfBeto = tileOf(ana.page, 'Beto');
  await expect.poll(() => fit(camOfBeto)).toBe('cover');

  // selecionar: a imagem inteira, no formato original (sem cortes)
  await camOfBeto.click({ position: { x: 24, y: 120 } });
  await expect(camOfBeto).toHaveAttribute('data-selected', 'true');
  await expect.poll(() => fit(camOfBeto)).toBe('contain');
  await ana.page.keyboard.press('Escape');
  await expect.poll(() => fit(camOfBeto)).toBe('cover');

  // a tela compartilhada de Ana, vista por Beto, é sempre mostrada inteira
  await ana.page.getByRole('button', { name: 'Tela', exact: true }).click();
  const anaOnBeto = tileOf(beto.page, 'Ana');
  await anaOnBeto.getByRole('button', { name: 'Ver tela de Ana' }).click();
  await expect(anaOnBeto).toHaveAttribute('data-showing', 'screen');
  await expect.poll(() => fit(anaOnBeto)).toBe('contain');
  // e a própria Ana vê a própria tela inteira também
  await expect.poll(() => fit(tileOf(ana.page, 'Ana'))).toBe('contain');
  // o vídeo chegou com dimensões reais e é exibido com contain: mantém a proporção da fonte, não deforma
  const video = anaOnBeto.locator('video:not(.tile-inset)');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  const source = await video.evaluate((v: HTMLVideoElement) => v.videoWidth / v.videoHeight);
  expect(source).toBeGreaterThan(0.2);

  expect(ana.errors).toEqual([]);
  expect(beto.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});
