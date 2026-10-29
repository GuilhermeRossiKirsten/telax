import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/** Sons baixos de entrar (587 → 880 Hz) e sair (740 → 494 Hz) da sala. */

const JOIN = [587, 880];
const LEAVE = [740, 494];

/** Só para teste: registra a frequência de cada oscilador que a página inicia (os toques são sintetizados). */
const TRACK_TONES = () => {
  const w = window as unknown as { __tones: number[] };
  w.__tones = [];
  const start = OscillatorNode.prototype.start;
  OscillatorNode.prototype.start = function (this: OscillatorNode, ...args: [when?: number]) {
    w.__tones.push(Math.round(this.frequency.value));
    return start.apply(this, args);
  };
};

type User = { ctx: BrowserContext; page: Page; errors: string[] };

let seq = 0;
const uniqueRoom = (label: string) => `e2e-som-${label}-${Date.now()}-${++seq}`;

async function newUser(browser: Browser): Promise<User> {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(TRACK_TONES);
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

const tones = (p: Page) => p.evaluate(() => (window as unknown as { __tones: number[] }).__tones.slice());
const clearTones = (p: Page) => p.evaluate(() => ((window as unknown as { __tones: number[] }).__tones.length = 0));
const names = (p: Page) => p.getByTestId('participants').locator('li');
const soundsBox = (p: Page) => p.getByRole('dialog', { name: 'Configurações' }).getByLabel('Tocar um som baixo quando alguém entrar ou sair da sala');

async function openSettings(p: Page) {
  await p.getByRole('button', { name: 'Configurações' }).click();
  await expect(p.getByRole('dialog', { name: 'Configurações' })).toBeVisible();
}
async function closeSettings(p: Page) {
  await p.getByRole('dialog', { name: 'Configurações' }).getByRole('button', { name: 'Fechar' }).click();
  await expect(p.getByRole('dialog', { name: 'Configurações' })).toHaveCount(0);
}

test('ao entrar, o próprio cliente toca o toque de entrar (587 e 880 Hz, nessa ordem)', async ({ browser }) => {
  const ana = await newUser(browser);
  await enter(ana, uniqueRoom('proprio'), 'Ana');
  await expect.poll(() => tones(ana.page)).toEqual(JOIN);
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
});

test('quando OUTRA pessoa entra toca o de entrar; quando ela sai (fecha a aba) toca o de sair', async ({ browser }) => {
  const room = uniqueRoom('outra');
  const ana = await newUser(browser);
  const beto = await newUser(browser);
  await enter(ana, room, 'Ana');
  await expect.poll(() => tones(ana.page)).toEqual(JOIN);
  await clearTones(ana.page);

  await enter(beto, room, 'Beto');
  await expect(names(ana.page).filter({ hasText: 'Beto' })).toHaveCount(1);
  await expect.poll(() => tones(ana.page)).toEqual(JOIN);

  await clearTones(ana.page);
  await beto.page.close({ runBeforeUnload: true });
  await expect(names(ana.page)).toHaveCount(1, { timeout: 25_000 });
  await expect.poll(() => tones(ana.page)).toEqual(LEAVE);
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('quem acabou de entrar NÃO toca um toque por pessoa que já estava lá: só o seu próprio', async ({ browser }) => {
  const room = uniqueRoom('ja-estavam');
  const ana = await newUser(browser);
  const beto = await newUser(browser);
  const cris = await newUser(browser);
  await enter(ana, room, 'Ana');
  await enter(beto, room, 'Beto');
  await expect(names(ana.page)).toHaveCount(2);
  await enter(cris, room, 'Cris');
  await expect(names(cris.page)).toHaveCount(3);
  // espera o estado se assentar nas três páginas antes de concluir que não houve toques a mais
  await expect(names(ana.page)).toHaveCount(3);
  await expect(names(beto.page)).toHaveCount(3);
  await expect.poll(() => tones(cris.page)).toEqual(JOIN);
  await expect.poll(() => tones(cris.page).then((t) => t.length)).toBe(2);
  expect(cris.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
  await cris.ctx.close();
});

test('desmarcar a caixa nas Configurações silencia entradas e saídas, e a escolha é lembrada ao recarregar', async ({ browser }) => {
  const room = uniqueRoom('mudo');
  const ana = await newUser(browser);
  const beto = await newUser(browser);
  await enter(ana, room, 'Ana');
  await expect.poll(() => tones(ana.page)).toEqual(JOIN);

  await openSettings(ana.page);
  await expect(soundsBox(ana.page)).toBeChecked(); // ligado por padrão
  await soundsBox(ana.page).uncheck();
  await closeSettings(ana.page);
  await clearTones(ana.page);

  await enter(beto, room, 'Beto');
  await expect(names(ana.page).filter({ hasText: 'Beto' })).toHaveCount(1);
  await beto.page.close({ runBeforeUnload: true });
  await expect(names(ana.page)).toHaveCount(1, { timeout: 25_000 });
  expect(await tones(ana.page)).toEqual([]);

  // lembrada: depois de recarregar a caixa segue desmarcada e a própria entrada também é silenciosa
  await ana.page.reload();
  await expect(ana.page.getByRole('navigation', { name: 'Controles da reunião' })).toBeVisible();
  await expect(names(ana.page)).toHaveCount(1);
  await openSettings(ana.page);
  await expect(soundsBox(ana.page)).not.toBeChecked();
  await closeSettings(ana.page);
  expect(await tones(ana.page)).toEqual([]);

  // e religar volta a tocar
  await openSettings(ana.page);
  await soundsBox(ana.page).check();
  await closeSettings(ana.page);
  const beto2 = await newUser(browser);
  await enter(beto2, room, 'Beto');
  await expect.poll(() => tones(ana.page)).toEqual(JOIN);
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
  await beto2.ctx.close();
});

test('clicar em "Sair" toca o toque de sair antes de navegar', async ({ browser }) => {
  const ana = await newUser(browser);
  await enter(ana, uniqueRoom('sair'), 'Ana');
  await expect.poll(() => tones(ana.page)).toEqual(JOIN);
  await clearTones(ana.page);

  await ana.page.getByRole('button', { name: 'Sair', exact: true }).click();
  await expect(ana.page).toHaveURL(/\/$|\/\?/);
  await expect.poll(() => tones(ana.page)).toEqual(LEAVE);
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
});
