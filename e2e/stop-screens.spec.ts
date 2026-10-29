import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/** Parar de compartilhar: com mais de uma tela, a pessoa escolhe QUAL parar (ou todas). */

/** Só para teste: cada chamada devolve uma tela de cor diferente (vermelha, verde, azul), para reconhecer qual é qual. */
const FAKE_COLORED_SCREENS = () => {
  const colors = ['#e11d48', '#16a34a', '#2563eb'];
  let n = 0;
  navigator.mediaDevices.getDisplayMedia = async () => {
    const color = colors[n++ % colors.length];
    const canvas = document.createElement('canvas');
    canvas.width = 320;
    canvas.height = 180;
    const g = canvas.getContext('2d')!;
    setInterval(() => {
      g.fillStyle = color;
      g.fillRect(0, 0, 320, 180);
    }, 50);
    return canvas.captureStream(15);
  };
};

type User = { ctx: BrowserContext; page: Page; errors: string[] };

let seq = 0;
const uniqueRoom = (label: string) => `e2e-stop-${label}-${Date.now()}-${++seq}`;

async function newUser(browser: Browser, colored = false): Promise<User> {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  if (colored) await ctx.addInitScript(FAKE_COLORED_SCREENS);
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
  const ana = await newUser(browser, true);
  const beto = await newUser(browser);
  await enter(ana, room, 'Ana');
  await enter(beto, room, 'Beto');
  await expect(ana.page.getByTestId('participants').locator('li').filter({ hasText: 'Beto' }).locator('.badge')).toHaveText('Conectado');
  return { ana, beto };
}

const shareButton = (p: Page) => p.getByRole('button', { name: 'Tela', exact: true });
const stopButton = (p: Page) => p.getByRole('button', { name: 'Parar compartilhamento', exact: true });
const chooser = (p: Page) => p.getByRole('menu', { name: 'Parar qual tela?' });
const showingScreen = (p: Page) => p.locator('figure[data-testid="tile"][data-showing="screen"]');
const extraTile = (p: Page) => p.locator('figure[data-testid="tile"][data-kind="screen"]');

async function shareN(page: Page, n: number) {
  for (let i = 0; i < n; i++) {
    await shareButton(page).click();
    await expect(stopButton(page)).toBeVisible();
    await expect(showingScreen(page)).toHaveCount(i + 1);
  }
}

/** Cor do centro de um <video> (para saber qual miniatura é qual tela). */
const centerColor = (video: ReturnType<Page['locator']>) =>
  video.evaluate((v: HTMLVideoElement) => {
    const c = document.createElement('canvas');
    c.width = 4;
    c.height = 4;
    const g = c.getContext('2d')!;
    g.drawImage(v, 0, 0, 4, 4);
    const [r, gr, b] = g.getImageData(2, 2, 1, 1).data;
    return [r, gr, b];
  });

test('com UMA tela, "Parar compartilhamento" para direto, sem perguntar', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'uma');
  await shareN(ana.page, 1);
  await stopButton(ana.page).click();
  await expect(chooser(ana.page)).toHaveCount(0);
  await expect(stopButton(ana.page)).toHaveCount(0);
  await expect(showingScreen(ana.page)).toHaveCount(0);
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('com DUAS telas, pergunta qual parar, com miniatura ao vivo de cada uma, e só a escolhida para', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'duas');
  await shareN(ana.page, 2);
  await expect(extraTile(beto.page)).toHaveCount(1);

  await stopButton(ana.page).click();
  const menu = chooser(ana.page);
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Parar tela', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Parar tela 2', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Parar todas as telas', exact: true })).toBeVisible();

  // cada item mostra a miniatura ao vivo da SUA tela: cores diferentes (vermelha e verde)
  const previews = menu.locator('video');
  await expect(previews).toHaveCount(2);
  await expect.poll(async () => (await centerColor(previews.nth(0))).join(',')).not.toBe('0,0,0');
  await expect.poll(async () => (await centerColor(previews.nth(1))).join(',')).not.toBe('0,0,0');
  const [c0, c1] = [await centerColor(previews.nth(0)), await centerColor(previews.nth(1))];
  expect(c0.join(',')).not.toBe(c1.join(','));

  // Esc fecha o menu sem parar nada
  await ana.page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(extraTile(beto.page)).toHaveCount(1);

  // parar só a tela 2: a 1 continua e o botão segue lá
  await stopButton(ana.page).click();
  await menu.getByRole('menuitem', { name: 'Parar tela 2', exact: true }).click();
  await expect(menu).toHaveCount(0);
  await expect(extraTile(beto.page)).toHaveCount(0);
  await expect(extraTile(ana.page)).toHaveCount(0);
  await expect(ana.page.locator('figure[data-testid="tile"][data-kind="person"][data-showing="screen"]')).toHaveCount(1);
  await expect(beto.page.locator('figure[data-testid="tile"][data-kind="person"][data-sharing="true"]')).toHaveCount(1);

  // sobrou uma: agora para direto
  await stopButton(ana.page).click();
  await expect(menu).toHaveCount(0);
  await expect(stopButton(ana.page)).toHaveCount(0);
  await expect(beto.page.locator('figure[data-sharing="true"]')).toHaveCount(0);
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('escolher a tela 1 deixa as outras no ar, e "Parar todas as telas" limpa tudo (3 telas)', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'tres');
  await shareN(ana.page, 3);
  await expect(shareButton(ana.page)).toBeDisabled(); // limite de 3

  await stopButton(ana.page).click();
  await expect(chooser(ana.page).getByRole('menuitem')).toHaveCount(4); // 3 telas + todas
  await chooser(ana.page).getByRole('menuitem', { name: 'Parar tela', exact: true }).click();
  await expect(shareButton(ana.page)).toBeEnabled();
  await expect(showingScreen(ana.page)).toHaveCount(2);
  await expect(extraTile(beto.page)).toHaveCount(1); // as telas 2 e 3 seguem (a 2 assumiu o tile da pessoa)

  await stopButton(ana.page).click();
  await chooser(ana.page).getByRole('menuitem', { name: 'Parar todas as telas', exact: true }).click();
  await expect(stopButton(ana.page)).toHaveCount(0);
  await expect(showingScreen(ana.page)).toHaveCount(0);
  await expect(beto.page.locator('figure[data-sharing="true"]')).toHaveCount(0);

  // clique fora também fecha o menu sem parar nada
  await shareN(ana.page, 2);
  await stopButton(ana.page).click();
  await expect(chooser(ana.page)).toBeVisible();
  await ana.page.locator('.topbar').click({ position: { x: 300, y: 10 } });
  await expect(chooser(ana.page)).toHaveCount(0);
  await expect(showingScreen(ana.page)).toHaveCount(2);
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});
