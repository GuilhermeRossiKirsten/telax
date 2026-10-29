import { expect, test, type Browser, type BrowserContext, type Locator, type Page } from '@playwright/test';

/**
 * Seleção MÚLTIPLA em grade: clicar no corpo do tile alterna a seleção só dele (sem botão de pin); os selecionados
 * formam uma grade na área principal e os demais ficam na faixa de baixo. O destaque é só o contorno.
 */

/** Só para teste: cada chamada devolve uma tela de cor diferente (vermelha, verde, azul), como em stop-screens.spec.ts. */
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

type User = { name: string; ctx: BrowserContext; page: Page; errors: string[] };

let seq = 0;
const uniqueRoom = (label: string) => `e2e-sel-${label}-${Date.now()}-${++seq}`;

async function newUser(browser: Browser, name: string, colored = false): Promise<User> {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  if (colored) await ctx.addInitScript(FAKE_COLORED_SCREENS);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  return { name, ctx, page, errors };
}

async function enter(u: User, room: string) {
  await u.page.goto('/');
  await u.page.getByLabel('Nome da sala').fill(room);
  await u.page.getByLabel('Seu nome').fill(u.name);
  await u.page.getByRole('button', { name: 'Entrar na sala' }).click();
  await expect(u.page).toHaveURL(/\/room\//);
}

/** Sala com Ana (quem observa), Beto, Cris e Duda; `sharer` recebe o stub de telas coloridas. */
async function room4(browser: Browser, label: string, sharer?: 'Beto') {
  const room = uniqueRoom(label);
  const names = ['Ana', 'Beto', 'Cris', 'Duda'];
  const users: User[] = [];
  for (const name of names) users.push(await newUser(browser, name, name === sharer));
  for (const u of users) await enter(u, room);
  const [ana, beto, cris, duda] = users;
  await expect(ana.page.locator('figure[data-testid="tile"][data-kind="person"]')).toHaveCount(4);
  return { ana, beto, cris, duda, users };
}
async function closeAll(users: User[]) {
  for (const u of users) await u.ctx.close();
}

const tileOf = (p: Page, name: string) => p.locator('figure[data-testid="tile"][data-kind="person"]', { hasText: name });
const extraTile = (p: Page) => p.locator('figure[data-testid="tile"][data-kind="screen"]');
const tilesEl = (p: Page) => p.getByTestId('tiles');
const primary = (p: Page) => p.locator('.tiles-primary');
const rest = (p: Page) => p.locator('.tiles-rest');
const selected = (p: Page) => p.locator('figure[data-testid="tile"][data-selected="true"]');
const menuOf = (p: Page, label: string) => p.getByRole('menu', { name: `Menu de ${label}` });

/** Seleciona/solta clicando no CORPO do tile (longe do overlay do topo e do botão "Ver tela"). */
const pick = (tile: Locator) => tile.click({ position: { x: 24, y: 70 } });

async function openMenu(p: Page, tile: Locator, label: string) {
  await tile.click({ button: 'right', position: { x: 24, y: 70 } });
  const menu = menuOf(p, label);
  await expect(menu).toBeVisible();
  return menu;
}

const rect = (loc: Locator) =>
  loc.evaluate((el: HTMLElement) => {
    const r = el.getBoundingClientRect();
    return { left: Math.round(r.left), top: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) };
  });

test('o overlay não tem botão de pin nem "Destacar": a seleção é o clique no tile', async ({ browser }) => {
  const { ana, beto, users } = await room4(browser, 'sem-pin');
  const tile = tileOf(ana.page, 'Beto');
  await tile.hover();
  await expect(tile.getByRole('button', { name: 'Mais opções de Beto' })).toBeVisible(); // o overlay existe
  await expect(tile.getByRole('button', { name: /Destacar|Soltar/ })).toHaveCount(0);
  await expect(tile.locator('.tile-actions button[aria-pressed]')).toHaveCount(0);

  // e clicar no corpo seleciona (com contorno, sem botão)
  await pick(tile);
  await expect(tile).toHaveAttribute('data-selected', 'true');
  await tile.hover();
  await expect(tile.getByRole('button', { name: /Destacar|Soltar/ })).toHaveCount(0);
  expect(beto.errors).toEqual([]);
  await closeAll(users);
});

test('clicar em dois tiles seleciona os DOIS: lado a lado na área principal, o resto na faixa', async ({ browser }) => {
  const { ana, users } = await room4(browser, 'dois');
  await pick(tileOf(ana.page, 'Beto'));
  await pick(tileOf(ana.page, 'Cris')); // não tira a seleção do Beto
  await expect(selected(ana.page)).toHaveCount(2);
  await expect(tileOf(ana.page, 'Beto')).toHaveAttribute('data-selected', 'true');
  await expect(tileOf(ana.page, 'Cris')).toHaveAttribute('data-selected', 'true');

  await expect(tilesEl(ana.page)).toHaveAttribute('data-layout', 'spotlight');
  await expect(primary(ana.page)).toHaveAttribute('data-count', '2');
  await expect(primary(ana.page).locator('figure[data-testid="tile"]')).toHaveCount(2);
  await expect(primary(ana.page).locator('figure[data-testid="tile"]', { hasText: 'Beto' })).toHaveCount(1);
  await expect(primary(ana.page).locator('figure[data-testid="tile"]', { hasText: 'Cris' })).toHaveCount(1);
  // os não selecionados ficam na faixa de baixo
  await expect(rest(ana.page).locator('figure[data-testid="tile"]')).toHaveCount(2);
  await expect(rest(ana.page).locator('figure[data-testid="tile"]', { hasText: 'Ana' })).toHaveCount(1);
  await expect(rest(ana.page).locator('figure[data-testid="tile"]', { hasText: 'Duda' })).toHaveCount(1);

  // lado a lado: mesmo topo (aproximado) e lefts diferentes
  await expect
    .poll(async () => {
      const [b, c] = [await rect(tileOf(ana.page, 'Beto')), await rect(tileOf(ana.page, 'Cris'))];
      return Math.abs(b.top - c.top) <= 3 && Math.abs(b.left - c.left) > Math.min(b.width, c.width) / 2;
    })
    .toBe(true);
  // e acima da faixa
  const [pb, rd] = [await rect(tileOf(ana.page, 'Beto')), await rect(rest(ana.page).locator('figure[data-testid="tile"]', { hasText: 'Duda' }))];
  expect(pb.top).toBeLessThan(rd.top);
  await closeAll(users);
});

test('3 de 4 selecionados: grade de 2 colunas (dois na 1ª linha, um na 2ª); clicar de novo tira só um', async ({ browser }) => {
  const { ana, users } = await room4(browser, 'tres');
  for (const name of ['Beto', 'Cris', 'Duda']) await pick(tileOf(ana.page, name));
  await expect(selected(ana.page)).toHaveCount(3);
  const main = primary(ana.page);
  await expect(main).toHaveAttribute('data-count', '3');
  await expect.poll(() => main.evaluate((el: HTMLElement) => el.style.getPropertyValue('--cols').trim())).toBe('2');
  await expect.poll(() => main.evaluate((el: HTMLElement) => getComputedStyle(el).display)).toBe('grid');
  await expect(rest(ana.page).locator('figure[data-testid="tile"]')).toHaveCount(1);
  await expect(rest(ana.page).locator('figure[data-testid="tile"]', { hasText: 'Ana' })).toHaveCount(1);

  // 2 colunas: dois tiles na primeira linha (mesmo topo) e um na segunda (mais abaixo, alinhado à 1ª coluna)
  await expect
    .poll(async () => {
      const r = await Promise.all(['Beto', 'Cris', 'Duda'].map((n) => rect(tileOf(ana.page, n))));
      const byTop = [...r].sort((a, b) => a.top - b.top || a.left - b.left);
      const firstRow = Math.abs(byTop[0].top - byTop[1].top) <= 3;
      const secondRowBelow = byTop[2].top > byTop[1].top + byTop[1].height / 2;
      const alignedFirstCol = Math.abs(byTop[2].left - Math.min(byTop[0].left, byTop[1].left)) <= 3;
      return firstRow && secondRowBelow && alignedFirstCol;
    })
    .toBe(true);

  // clicar de novo em um selecionado tira SÓ ele
  await pick(tileOf(ana.page, 'Cris'));
  await expect(tileOf(ana.page, 'Cris')).not.toHaveAttribute('data-selected', 'true');
  await expect(tileOf(ana.page, 'Beto')).toHaveAttribute('data-selected', 'true');
  await expect(tileOf(ana.page, 'Duda')).toHaveAttribute('data-selected', 'true');
  await expect(main).toHaveAttribute('data-count', '2');
  await expect(rest(ana.page).locator('figure[data-testid="tile"]', { hasText: 'Cris' })).toHaveCount(1);
  await closeAll(users);
});

test('Esc limpa TODA a seleção e volta à grade normal', async ({ browser }) => {
  const { ana, users } = await room4(browser, 'esc');
  await pick(tileOf(ana.page, 'Beto'));
  await pick(tileOf(ana.page, 'Cris'));
  await expect(selected(ana.page)).toHaveCount(2);
  await expect(tilesEl(ana.page)).toHaveAttribute('data-layout', 'spotlight');

  await ana.page.keyboard.press('Escape');
  await expect(selected(ana.page)).toHaveCount(0);
  await expect(tilesEl(ana.page)).toHaveAttribute('data-layout', 'grid');
  await expect(primary(ana.page)).toHaveCount(0);
  await expect(rest(ana.page)).toHaveCount(0);
  await closeAll(users);
});

test('todos os tiles selecionados: vira a grade normal (sem faixa), todos com contorno', async ({ browser }) => {
  const { ana, users } = await room4(browser, 'todos');
  for (const name of ['Ana', 'Beto', 'Cris', 'Duda']) await pick(tileOf(ana.page, name));
  await expect(selected(ana.page)).toHaveCount(4);
  await expect(tilesEl(ana.page)).toHaveAttribute('data-layout', 'grid');
  await expect(primary(ana.page)).toHaveCount(0);
  await expect(rest(ana.page)).toHaveCount(0);

  // soltar um traz de volta o destaque com os 3 restantes
  await pick(tileOf(ana.page, 'Ana'));
  await expect(tilesEl(ana.page)).toHaveAttribute('data-layout', 'spotlight');
  await expect(primary(ana.page)).toHaveAttribute('data-count', '3');
  await closeAll(users);
});

test('duas telas abertas, sem seleção: as duas formam a grade principal', async ({ browser }) => {
  const { ana, beto, users } = await room4(browser, 'telas', 'Beto');
  for (let i = 1; i <= 2; i++) {
    await beto.page.getByRole('button', { name: 'Tela', exact: true }).click();
    await expect(beto.page.locator('figure[data-testid="tile"][data-showing="screen"]')).toHaveCount(i);
  }
  await expect(extraTile(ana.page)).toHaveCount(1); // "Tela 2 de Beto"
  await expect(tilesEl(ana.page)).toHaveAttribute('data-layout', 'grid'); // telas fechadas, nada selecionado

  await tileOf(ana.page, 'Beto').getByRole('button', { name: 'Ver tela de Beto' }).click();
  await extraTile(ana.page).getByRole('button', { name: 'Ver tela 2 de Beto' }).click();
  const showing = ana.page.locator('figure[data-testid="tile"][data-showing="screen"]');
  await expect(showing).toHaveCount(2);

  await expect(selected(ana.page)).toHaveCount(0);
  await expect(tilesEl(ana.page)).toHaveAttribute('data-layout', 'spotlight');
  await expect(primary(ana.page)).toHaveAttribute('data-count', '2');
  await expect(primary(ana.page).locator('figure[data-showing="screen"]')).toHaveCount(2);
  // as câmeras (Ana, Cris, Duda) ficam na faixa
  await expect(rest(ana.page).locator('figure[data-testid="tile"]')).toHaveCount(3);
  await expect
    .poll(async () => {
      const r = await Promise.all([0, 1].map((i) => rect(primary(ana.page).locator('figure[data-testid="tile"]').nth(i))));
      return Math.abs(r[0].top - r[1].top) <= 3 && Math.abs(r[0].left - r[1].left) > Math.min(r[0].width, r[1].width) / 2;
    })
    .toBe(true);
  expect(ana.errors).toEqual([]);
  await closeAll(users);
});

test('o contorno: o tile selecionado tem um visual próprio, diferente dos demais', async ({ browser }) => {
  const { ana, users } = await room4(browser, 'contorno');
  const look = (tile: Locator) =>
    tile.evaluate((el: HTMLElement) => {
      const s = getComputedStyle(el);
      return { shadow: s.boxShadow, outline: `${s.outlineStyle} ${s.outlineWidth}`, border: s.borderTopColor, borderWidth: s.borderTopWidth };
    });
  await ana.page.mouse.move(2, 2); // longe dos tiles: o hover não entra na comparação
  const before = await look(tileOf(ana.page, 'Beto'));

  await pick(tileOf(ana.page, 'Beto'));
  await ana.page.mouse.move(2, 2);
  await expect(tileOf(ana.page, 'Beto')).toHaveAttribute('data-selected', 'true');
  const sel = await look(tileOf(ana.page, 'Beto'));
  const other = await look(tileOf(ana.page, 'Cris'));

  // contorno = borda, sombra ou outline próprios; o tile selecionado difere de si mesmo antes e dos não selecionados
  expect(JSON.stringify(sel)).not.toBe(JSON.stringify(before));
  expect(JSON.stringify(sel)).not.toBe(JSON.stringify(other));
  const hasContour = sel.shadow !== 'none' || !sel.outline.startsWith('none') || sel.border !== other.border;
  expect(hasContour).toBe(true);
  await closeAll(users);
});

test('esconder (Fechar) um selecionado o tira da seleção; se ele sai da sala, também', async ({ browser }) => {
  const { ana, duda, users } = await room4(browser, 'esconder');
  const beto = tileOf(ana.page, 'Beto');
  await pick(beto);
  await pick(tileOf(ana.page, 'Duda'));
  await expect(selected(ana.page)).toHaveCount(2);

  await beto.hover();
  await beto.getByRole('button', { name: 'Fechar Beto' }).click();
  await expect(beto).toBeHidden();
  await expect(selected(ana.page)).toHaveCount(1); // só a Duda segue selecionada
  await expect(primary(ana.page)).toHaveAttribute('data-count', '1');

  // mostrar de volta: volta sem seleção
  await ana.page.getByRole('region', { name: 'Telas fechadas' }).getByRole('button', { name: 'Mostrar Beto' }).click();
  await expect(beto).toBeVisible();
  await expect(beto).not.toHaveAttribute('data-selected', 'true');

  // a Duda (selecionada) sai da sala: a seleção some e a grade volta ao normal
  await duda.page.close({ runBeforeUnload: true });
  await expect(tileOf(ana.page, 'Duda')).toHaveCount(0, { timeout: 25_000 });
  await expect(selected(ana.page)).toHaveCount(0);
  await expect(tilesEl(ana.page)).toHaveAttribute('data-layout', 'grid');
  expect(ana.errors).toEqual([]);
  await closeAll(users);
});

test('"Destacar"/"Soltar" do menu de botão direito alternam só a seleção daquele tile', async ({ browser }) => {
  const { ana, users } = await room4(browser, 'menu');
  const beto = tileOf(ana.page, 'Beto');
  const cris = tileOf(ana.page, 'Cris');

  let menu = await openMenu(ana.page, beto, 'Beto');
  await menu.getByRole('menuitem', { name: 'Destacar Beto', exact: true }).click();
  await expect(menuOf(ana.page, 'Beto')).toHaveCount(0);
  await expect(beto).toHaveAttribute('data-selected', 'true');

  menu = await openMenu(ana.page, cris, 'Cris');
  await menu.getByRole('menuitem', { name: 'Destacar Cris', exact: true }).click();
  await expect(selected(ana.page)).toHaveCount(2); // a seleção do Beto continua

  // o item do Beto agora é "Soltar": solta só ele
  menu = await openMenu(ana.page, beto, 'Beto');
  await expect(menu.getByRole('menuitem', { name: 'Destacar Beto', exact: true })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Soltar Beto', exact: true }).click();
  await expect(beto).not.toHaveAttribute('data-selected', 'true');
  await expect(cris).toHaveAttribute('data-selected', 'true');
  await expect(primary(ana.page)).toHaveAttribute('data-count', '1');

  // abrir o menu (botão direito) não seleciona nada por si só
  menu = await openMenu(ana.page, tileOf(ana.page, 'Duda'), 'Duda');
  await ana.page.keyboard.press('Escape');
  await expect(menuOf(ana.page, 'Duda')).toHaveCount(0);
  await expect(selected(ana.page)).toHaveCount(1);
  expect(ana.errors).toEqual([]);
  await closeAll(users);
});
