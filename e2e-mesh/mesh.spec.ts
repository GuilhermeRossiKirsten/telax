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

type User = { name: string; ctx: BrowserContext; page: Page; errors: string[] };

let seq = 0;
const uniqueRoom = (label: string) => `mesh-${label}-${Date.now()}-${++seq}`;
const opened: User[] = [];

const participants = (p: Page) => p.getByTestId('participants').locator('li');
const tileOf = (p: Page, name: string) => p.locator('figure[data-testid="tile-camera"]', { hasText: name });
const showParticipants = (p: Page) => p.getByRole('tab', { name: /Participantes/ }).click();
const showChat = (p: Page) => p.getByRole('tab', { name: /Chat/ }).click();
const pcCount = (p: Page) => p.evaluate(() => (window as unknown as { __pcs: unknown[] }).__pcs.length);

/** Estado das RTCPeerConnection de uma página, para diagnóstico em caso de falha. */
const pcStates = (p: Page) =>
  p.evaluate(() =>
    (window as unknown as { __pcs: RTCPeerConnection[] }).__pcs.map((pc) => `${pc.connectionState}/${pc.iceConnectionState}/${pc.signalingState}`),
  );

test.afterEach(async ({}, info) => {
  while (opened.length) {
    const u = opened.pop()!;
    if (info.status !== info.expectedStatus && !u.page.isClosed()) {
      const states = await pcStates(u.page).catch((e) => [`erro: ${e}`]);
      const list = await participants(u.page).allInnerTexts().catch(() => []);
      console.log(`[diag ${info.title}] ${u.name}: PCs=${JSON.stringify(states)} lista=${JSON.stringify(list)} pageerrors=${JSON.stringify(u.errors)}`);
    }
    await u.ctx.close().catch(() => {});
  }
});

async function newUser(browser: Browser, name: string): Promise<User> {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  await ctx.addInitScript(TRACK_PCS);
  const page = await ctx.newPage();
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const u = { name, ctx, page, errors };
  opened.push(u);
  return u;
}

async function enter(u: User, room: string) {
  await u.page.goto('/');
  await u.page.getByLabel('Nome da sala').fill(room);
  await u.page.getByLabel('Seu nome').fill(u.name);
  await u.page.getByRole('button', { name: 'Entrar na sala' }).click();
  await expect(u.page).toHaveURL(/\/room\//);
}

async function expectConnected(p: Page, other: string) {
  await expect(participants(p).filter({ hasText: other }).locator('.badge')).toHaveText('Conectado');
}

/** O vídeo remoto tem frames reais e o relógio de reprodução avança. */
async function expectVideoPlaying(tile: Locator) {
  const video = tile.locator('video');
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.videoWidth)).toBeGreaterThan(0);
  const t1 = await video.evaluate((v: HTMLVideoElement) => v.currentTime);
  await expect.poll(() => video.evaluate((v: HTMLVideoElement) => v.currentTime)).toBeGreaterThan(t1);
}

/** Cada participante vê todos os outros como "Conectado" (6 arestas dirigidas). */
async function expectMesh(users: User[]) {
  for (const u of users) {
    for (const other of users) {
      if (other !== u) await expectConnected(u.page, other.name);
    }
  }
}

/** Cada participante recebe vídeo real de todos os outros. */
async function expectVideoMesh(users: User[]) {
  for (const u of users) {
    for (const other of users) {
      if (other !== u) await expectVideoPlaying(tileOf(u.page, other.name));
    }
  }
}

/** Entram um por vez; ao final cada um vê 3 participantes e as 3 conexões do mesh estão "Conectado". */
async function trio(browser: Browser, label: string) {
  const room = uniqueRoom(label);
  const ana = await newUser(browser, 'Ana');
  const beto = await newUser(browser, 'Beto');
  const cris = await newUser(browser, 'Cris');
  await enter(ana, room);
  await expect(participants(ana.page)).toHaveCount(1);
  await enter(beto, room);
  await expect(participants(beto.page)).toHaveCount(2);
  await enter(cris, room);
  const all = [ana, beto, cris];
  for (const u of all) await expect(participants(u.page)).toHaveCount(3);
  await expectMesh(all);
  return { room, ana, beto, cris, all };
}

test('três participantes formam a malha completa, todos conectados e com vídeo real', async ({ browser }) => {
  const { all } = await trio(browser, 'malha');
  await expectVideoMesh(all);
  for (const u of all) expect(u.errors, `pageerror de ${u.name}`).toEqual([]);
});

test('chat de Ana chega para Beto e Cris', async ({ browser }) => {
  const { ana, beto, cris, all } = await trio(browser, 'chat');
  for (const u of all) await showChat(u.page);

  const box = ana.page.getByLabel('Mensagem', { exact: true });
  await box.fill('oi, pessoal!');
  await box.press('Enter');
  for (const u of [beto, cris]) {
    await expect(u.page.getByTestId('messages')).toContainText('Ana'); // remetente identificado pelo nome
    await expect(u.page.getByTestId('messages')).toContainText('oi, pessoal!');
  }
  // para quem enviou, o app mostra "Você"
  await expect(ana.page.getByTestId('messages')).toContainText('Você');
  await expect(ana.page.getByTestId('messages')).toContainText('oi, pessoal!');
  // exatamente uma cópia da mensagem em cada um (sem duplicar pelo mesh)
  for (const u of [beto, cris]) {
    await expect(u.page.getByTestId('messages').getByText('oi, pessoal!')).toHaveCount(1);
  }
  for (const u of all) expect(u.errors, `pageerror de ${u.name}`).toEqual([]);
});

test('reinício global por Cris renegocia as 3 conexões sem ninguém sair', async ({ browser }) => {
  const { cris, all } = await trio(browser, 'reinicio');
  await expectVideoMesh(all);
  const before = new Map<User, number>();
  for (const u of all) before.set(u, await pcCount(u.page));

  await cris.page.getByRole('button', { name: 'Reiniciar conexões' }).click();

  // novas RTCPeerConnection em todos: houve renegociação de verdade, inclusive entre Ana e Beto
  for (const u of all) {
    await expect.poll(() => pcCount(u.page), { message: `PCs de ${u.name}` }).toBeGreaterThan(before.get(u)!);
  }
  for (const u of all) await expect(participants(u.page)).toHaveCount(3);
  await expectMesh(all);
  await expectVideoMesh(all);
  for (const u of all) await expect(participants(u.page)).toHaveCount(3);
  for (const u of all) expect(u.errors, `pageerror de ${u.name}`).toEqual([]);
});

test('dois reinícios quase simultâneos (Ana e Beto) não derrubam ninguém', async ({ browser }) => {
  const { ana, beto, all } = await trio(browser, 'duplo');
  await expectVideoMesh(all);
  const before = new Map<User, number>();
  for (const u of all) before.set(u, await pcCount(u.page));

  await Promise.all([
    ana.page.getByRole('button', { name: 'Reiniciar conexões' }).click(),
    beto.page.getByRole('button', { name: 'Reiniciar conexões' }).click(),
  ]);

  for (const u of all) {
    await expect.poll(() => pcCount(u.page), { message: `PCs de ${u.name}` }).toBeGreaterThan(before.get(u)!);
  }
  for (const u of all) await expect(participants(u.page)).toHaveCount(3);
  await expectMesh(all);
  await expectVideoMesh(all);
  for (const u of all) await expect(participants(u.page)).toHaveCount(3);
  for (const u of all) expect(u.errors, `pageerror de ${u.name}`).toEqual([]);
});

test('Beto fecha a aba: Ana e Cris veem 2 participantes e seguem conectados com vídeo', async ({ browser }) => {
  const { ana, beto, cris } = await trio(browser, 'saida');
  await expectVideoPlaying(tileOf(ana.page, 'Cris'));
  await expectVideoPlaying(tileOf(cris.page, 'Ana'));

  await beto.page.close({ runBeforeUnload: true });

  for (const u of [ana, cris]) {
    await showParticipants(u.page);
    await expect(participants(u.page)).toHaveCount(2, { timeout: 25_000 });
    await expect(participants(u.page).filter({ hasText: 'Beto' })).toHaveCount(0);
    await expect(tileOf(u.page, 'Beto')).toHaveCount(0);
  }
  await expectConnected(ana.page, 'Cris');
  await expectConnected(cris.page, 'Ana');
  await expectVideoPlaying(tileOf(ana.page, 'Cris'));
  await expectVideoPlaying(tileOf(cris.page, 'Ana'));
  // e continua assim (ninguém reaparece nem cai depois)
  for (const u of [ana, cris]) await expect(participants(u.page)).toHaveCount(2);
  for (const u of [ana, cris]) expect(u.errors, `pageerror de ${u.name}`).toEqual([]);
});
