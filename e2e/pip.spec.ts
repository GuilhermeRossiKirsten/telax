import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';

/**
 * Picture-in-Picture da tela compartilhada: um botão no tile da tela leva a imagem a uma janela flutuante.
 * O Chromium sem interface não oferece PiP de verdade, então a API do navegador é simulada aqui (como o getDisplayMedia):
 * `document.pictureInPictureElement`, `requestPictureInPicture` e `exitPictureInPicture`, com os mesmos eventos
 * (`enterpictureinpicture` / `leavepictureinpicture` no vídeo) e a regra de UMA janela por vez.
 */

const FAKE_SCREENS = () => {
  navigator.mediaDevices.getDisplayMedia = async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 640;
    canvas.height = 360;
    const g = canvas.getContext('2d')!;
    let x = 0;
    setInterval(() => {
      g.fillStyle = '#2060e0';
      g.fillRect(0, 0, 640, 360);
      g.fillStyle = '#fff';
      g.fillRect((x = (x + 9) % 600), 10, 24, 24);
    }, 50);
    return new MediaStream(canvas.captureStream(15).getVideoTracks());
  };
};

const FAKE_PIP = () => {
  let current: HTMLVideoElement | null = null;
  const w = window as unknown as { __pipRequests: number };
  w.__pipRequests = 0;
  Object.defineProperty(document, 'pictureInPictureEnabled', { value: true, configurable: true });
  Object.defineProperty(document, 'pictureInPictureElement', { get: () => current, configurable: true });
  HTMLVideoElement.prototype.requestPictureInPicture = async function (this: HTMLVideoElement) {
    w.__pipRequests++;
    if (this.readyState === 0) throw new DOMException('sem quadros ainda', 'InvalidStateError');
    const previous = current;
    current = this;
    if (previous && previous !== this) previous.dispatchEvent(new Event('leavepictureinpicture'));
    this.dispatchEvent(new Event('enterpictureinpicture'));
    return {} as PictureInPictureWindow;
  };
  document.exitPictureInPicture = async () => {
    const el = current;
    current = null;
    el?.dispatchEvent(new Event('leavepictureinpicture'));
  };
};

/** Navegador sem PiP (Firefox desktop, por exemplo). */
const NO_PIP = () => {
  Object.defineProperty(document, 'pictureInPictureEnabled', { value: false, configurable: true });
};

type User = { ctx: BrowserContext; page: Page; errors: string[] };

let seq = 0;
const uniqueRoom = (label: string) => `e2e-pip-${label}-${Date.now()}-${++seq}`;

async function newUser(browser: Browser, opts: { sharer?: boolean; pip?: boolean } = {}): Promise<User> {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  if (opts.sharer) await ctx.addInitScript(FAKE_SCREENS);
  await ctx.addInitScript(opts.pip === false ? NO_PIP : FAKE_PIP);
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

const participants = (p: Page) => p.getByTestId('participants').locator('li');
const personTile = (p: Page, name: string) => p.locator('figure[data-testid="tile"][data-kind="person"]', { hasText: name });
const screenTile = (p: Page, slot: number) => p.locator(`figure[data-testid="tile"][data-kind="screen"][data-slot="${slot}"]`);
const shareButton = (p: Page) => p.getByRole('button', { name: 'Tela', exact: true });
/** O elemento que está na janela flutuante: a tag e o tile dono dele. */
const pipOwner = (p: Page) =>
  p.evaluate(() => {
    const el = document.pictureInPictureElement as HTMLElement | null;
    const tile = el?.closest('figure');
    return el ? { tag: el.tagName, slot: tile?.getAttribute('data-slot') ?? null, kind: tile?.getAttribute('data-kind') ?? null } : null;
  });

async function pair(browser: Browser, label: string, viewerPip = true) {
  const room = uniqueRoom(label);
  const ana = await newUser(browser, { sharer: true });
  const beto = await newUser(browser, { pip: viewerPip });
  await enter(ana, room, 'Ana');
  await enter(beto, room, 'Beto');
  await expect(participants(beto.page).filter({ hasText: 'Ana' }).locator('.badge')).toHaveText('Conectado');
  await expect(participants(ana.page).filter({ hasText: 'Beto' }).locator('.badge')).toHaveText('Conectado');
  return { ana, beto };
}

test('quem vê a tela de outra pessoa pode mandá-la para a janela flutuante e trazê-la de volta', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'ver');
  await shareButton(ana.page).click();

  const tile = personTile(beto.page, 'Ana');
  const pip = tile.getByRole('button', { name: 'Picture-in-Picture de Tela de Ana' });
  // antes de abrir a tela (só a oferta "Ver tela") e sem câmera de Ana no tile, não há o que flutuar
  await expect(tile.getByRole('button', { name: 'Ver tela de Ana' })).toBeVisible();
  await expect(pip).toHaveCount(0);

  await tile.getByRole('button', { name: 'Ver tela de Ana' }).click();
  await expect(tile).toHaveAttribute('data-showing', 'screen');
  await tile.hover();
  await expect(pip).toBeVisible();
  await expect(pip).toHaveAttribute('aria-pressed', 'false');

  await pip.click();
  await expect(pip).toHaveAttribute('aria-pressed', 'true');
  expect(await pipOwner(beto.page)).toEqual({ tag: 'VIDEO', slot: '0', kind: 'person' });

  await pip.click();
  await expect(pip).toHaveAttribute('aria-pressed', 'false');
  expect(await pipOwner(beto.page)).toBeNull();
  expect(beto.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('fechar a janela flutuante pelo próprio navegador (voltar para a aba) desmarca o botão', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'voltar');
  await shareButton(ana.page).click();
  const tile = personTile(beto.page, 'Ana');
  await tile.getByRole('button', { name: 'Ver tela de Ana' }).click();
  await tile.hover();
  const pip = tile.getByRole('button', { name: 'Picture-in-Picture de Tela de Ana' });
  await pip.click();
  await expect(pip).toHaveAttribute('aria-pressed', 'true');

  await beto.page.evaluate(() => document.exitPictureInPicture()); // o botão "voltar" da janela do navegador
  await expect(pip).toHaveAttribute('aria-pressed', 'false');
  await ana.ctx.close();
  await beto.ctx.close();
});

test('parar de ver a tela fecha a janela flutuante junto', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'fechar');
  await shareButton(ana.page).click();
  const tile = personTile(beto.page, 'Ana');
  await tile.getByRole('button', { name: 'Ver tela de Ana' }).click();
  await tile.hover();
  await tile.getByRole('button', { name: 'Picture-in-Picture de Tela de Ana' }).click();
  await expect.poll(() => pipOwner(beto.page)).not.toBeNull();

  await tile.getByRole('button', { name: 'Fechar tela de Ana' }).click();
  await expect.poll(() => pipOwner(beto.page)).toBeNull();
  await ana.ctx.close();
  await beto.ctx.close();
});

test('quando Ana para de compartilhar, a janela flutuante dela some no navegador de Beto', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'parou');
  await shareButton(ana.page).click();
  const tile = personTile(beto.page, 'Ana');
  await tile.getByRole('button', { name: 'Ver tela de Ana' }).click();
  await tile.hover();
  await tile.getByRole('button', { name: 'Picture-in-Picture de Tela de Ana' }).click();
  await expect.poll(() => pipOwner(beto.page)).not.toBeNull();

  await ana.page.getByRole('button', { name: 'Parar compartilhamento', exact: true }).click();
  await expect.poll(() => pipOwner(beto.page)).toBeNull();
  await ana.ctx.close();
  await beto.ctx.close();
});

test('quem compartilha também pode deixar a própria tela flutuando', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'propria');
  await shareButton(ana.page).click();
  const tile = personTile(ana.page, 'Ana');
  await expect(tile).toHaveAttribute('data-showing', 'screen');
  await tile.hover();
  const pip = tile.getByRole('button', { name: 'Picture-in-Picture de Tela de Ana' });
  await pip.click();
  await expect(pip).toHaveAttribute('aria-pressed', 'true');
  expect(await pipOwner(ana.page)).toEqual({ tag: 'VIDEO', slot: '0', kind: 'person' });
  await ana.ctx.close();
  await beto.ctx.close();
});

test('só uma janela por vez: levar outra tela para o PiP desmarca a anterior', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'duas');
  await shareButton(ana.page).click();
  await expect(personTile(ana.page, 'Ana')).toHaveAttribute('data-showing', 'screen');
  await shareButton(ana.page).click();
  await expect(screenTile(ana.page, 1)).toHaveCount(1);

  const first = personTile(beto.page, 'Ana');
  const second = screenTile(beto.page, 1);
  await first.getByRole('button', { name: 'Ver tela de Ana' }).click();
  await second.getByRole('button', { name: 'Ver tela 2 de Ana' }).click();

  await first.hover();
  const pip1 = first.getByRole('button', { name: 'Picture-in-Picture de Tela de Ana' });
  await pip1.click();
  await expect(pip1).toHaveAttribute('aria-pressed', 'true');

  await second.hover();
  const pip2 = second.getByRole('button', { name: 'Picture-in-Picture de Tela 2 de Ana' });
  await pip2.click();
  await expect(pip2).toHaveAttribute('aria-pressed', 'true');
  await expect(pip1).toHaveAttribute('aria-pressed', 'false');
  expect(await pipOwner(beto.page)).toEqual({ tag: 'VIDEO', slot: '1', kind: 'screen' });
  await ana.ctx.close();
  await beto.ctx.close();
});

test('o tile de uma pessoa sem tela (só avatar/câmera) não tem botão de Picture-in-Picture', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'sem-tela');
  const tile = personTile(beto.page, 'Ana');
  await tile.hover();
  await expect(tile.getByRole('button', { name: /Picture-in-Picture/ })).toHaveCount(0);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('navegador sem Picture-in-Picture: o botão nem aparece, e a tela continua funcionando', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'sem-suporte', false);
  await shareButton(ana.page).click();
  const tile = personTile(beto.page, 'Ana');
  await tile.getByRole('button', { name: 'Ver tela de Ana' }).click();
  await expect(tile).toHaveAttribute('data-showing', 'screen');
  await tile.hover();
  await expect(tile.getByRole('button', { name: 'Tela cheia Ana' })).toBeVisible(); // os outros botões seguem lá
  await expect(tile.getByRole('button', { name: /Picture-in-Picture/ })).toHaveCount(0);
  expect(beto.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('o clique no botão não seleciona o tile (a seleção é só o clique no corpo)', async ({ browser }) => {
  const { ana, beto } = await pair(browser, 'selecao');
  await shareButton(ana.page).click();
  const tile = personTile(beto.page, 'Ana');
  await tile.getByRole('button', { name: 'Ver tela de Ana' }).click();
  await tile.hover();
  await tile.getByRole('button', { name: 'Picture-in-Picture de Tela de Ana' }).click();
  await expect(tile).not.toHaveAttribute('data-selected', 'true');
  await ana.ctx.close();
  await beto.ctx.close();
});
