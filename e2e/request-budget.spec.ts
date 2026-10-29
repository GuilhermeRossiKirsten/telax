import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Orçamento de requisições à API (cada uma é uma invocação de função na Vercel, e o plano gratuito tem 1 milhão
 * por mês). Mede uma sala parada e a rajada de uma entrada, para que o consumo não volte a crescer sem ninguém ver.
 */

type User = { ctx: BrowserContext; page: Page; calls: Record<string, number> };

let seq = 0;
const uniqueRoom = (label: string) => `e2e-budget-${label}-${Date.now()}-${++seq}`;

async function newUser(browser: Browser): Promise<User> {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  const page = await ctx.newPage();
  const calls: Record<string, number> = {};
  page.on('request', (r) => {
    const u = new URL(r.url());
    if (!u.pathname.includes('/api/rooms/')) return;
    const kind = u.pathname.split('/').slice(-1)[0];
    calls[kind] = (calls[kind] ?? 0) + 1;
  });
  return { ctx, page, calls };
}

async function enter(u: User, room: string, name: string) {
  await u.page.goto('/');
  await u.page.getByLabel('Nome da sala').fill(room);
  await u.page.getByLabel('Seu nome').fill(name);
  await u.page.getByRole('button', { name: 'Entrar na sala' }).click();
  await expect(u.page).toHaveURL(/\/room\//);
}

const total = (c: Record<string, number>) => Object.values(c).reduce((a, b) => a + b, 0);
const reset = (c: Record<string, number>) => {
  for (const k of Object.keys(c)) delete c[k];
};

test('sala parada com 2 pessoas: no máximo ~1 consulta a cada 5 s por pessoa (antes: 1 por segundo)', async ({ browser }) => {
  const room = uniqueRoom('parada');
  const ana = await newUser(browser);
  const beto = await newUser(browser);
  await enter(ana, room, 'Ana');
  await enter(beto, room, 'Beto');
  await expect(ana.page.getByTestId('participants').locator('li').filter({ hasText: 'Beto' }).locator('.badge')).toHaveText('Conectado');

  // espera a negociação assentar e mede 30 s sem ninguém fazer nada
  await ana.page.waitForTimeout(4000);
  reset(ana.calls);
  reset(beto.calls);
  await ana.page.waitForTimeout(30_000);

  // 30 s a 1 consulta/s seriam ~30 por pessoa; com espera longa no servidor deve cair para poucas
  expect(ana.calls.events ?? 0).toBeLessThanOrEqual(8);
  expect(beto.calls.events ?? 0).toBeLessThanOrEqual(8);
  expect(total(ana.calls) + total(beto.calls)).toBeLessThanOrEqual(20);

  // e a sala continua viva: ninguém foi expulso por falta de batimento
  await expect(ana.page.getByTestId('participants').locator('li')).toHaveCount(2);
  await expect(beto.page.getByTestId('participants').locator('li')).toHaveCount(2);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('a entrada de duas pessoas não dispara uma requisição por candidato ICE', async ({ browser }) => {
  const room = uniqueRoom('rajada');
  const ana = await newUser(browser);
  const beto = await newUser(browser);
  await enter(ana, room, 'Ana');
  await enter(beto, room, 'Beto');
  await expect(ana.page.getByTestId('participants').locator('li').filter({ hasText: 'Beto' }).locator('.badge')).toHaveText('Conectado');
  await ana.page.waitForTimeout(3000);

  // 1 par: offer + answer + candidatos. Antes, cada candidato era um POST (dezenas); em lote, poucos
  const signals = (ana.calls.signal ?? 0) + (beto.calls.signal ?? 0);
  expect(signals).toBeLessThanOrEqual(10);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('entrar e conversar continua rápido: o chat chega em até ~3 s mesmo com espera longa', async ({ browser }) => {
  const room = uniqueRoom('chat');
  const ana = await newUser(browser);
  const beto = await newUser(browser);
  await enter(ana, room, 'Ana');
  await enter(beto, room, 'Beto');
  await expect(ana.page.getByTestId('participants').locator('li').filter({ hasText: 'Beto' }).locator('.badge')).toHaveText('Conectado');
  await ana.page.getByRole('tab', { name: /Chat/ }).click();
  await beto.page.getByRole('tab', { name: /Chat/ }).click();
  await ana.page.getByLabel('Mensagem', { exact: true }).fill('rapidinho');
  await ana.page.getByLabel('Mensagem', { exact: true }).press('Enter');
  await expect(beto.page.getByTestId('messages')).toContainText('rapidinho', { timeout: 3000 });
  await ana.ctx.close();
  await beto.ctx.close();
});
