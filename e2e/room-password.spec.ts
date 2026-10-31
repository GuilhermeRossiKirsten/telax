import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ADMIN_TEST_ENV } from '../playwright.config';
import { SESSION_COOKIE, signAdminSession } from '../src/server/admin-auth';

/** Senha da sala: ligada e desligada de dentro da sala pelo anfitrião (a pessoa mais antiga). */

const SENHA = 'segredo-forte-123';
const adminCookie = `${SESSION_COOKIE}=${signAdminSession({ login: ADMIN_TEST_ENV.ADMIN_GITHUB_USER, id: 1, exp: Date.now() + 3_600_000 }, ADMIN_TEST_ENV.ADMIN_SESSION_SECRET)}`;

type User = { ctx: BrowserContext; page: Page; errors: string[] };

let seq = 0;
const uniqueRoom = (label: string) => `e2e-pw-${label}-${Date.now()}-${++seq}`;

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

const participants = (p: Page) => p.getByTestId('participants').locator('li');
const dialog = (p: Page) => p.getByRole('dialog', { name: 'Configurações' });
const inRoom = (p: Page) => p.getByRole('navigation', { name: 'Controles da reunião' });

async function openSettings(p: Page) {
  await p.getByRole('button', { name: 'Configurações' }).click();
  await expect(dialog(p)).toBeVisible();
}
async function closeSettings(p: Page) {
  await dialog(p).getByRole('button', { name: 'Fechar' }).click();
  await expect(dialog(p)).toHaveCount(0);
}

/** O anfitrião liga a senha pela interface. */
async function protect(host: User, password = SENHA) {
  await openSettings(host.page);
  await dialog(host.page).getByLabel('Proteger esta sala com senha').check();
  await dialog(host.page).getByTestId('room-password-new').fill(password);
  await dialog(host.page).getByRole('button', { name: 'Ativar senha' }).click();
  await expect(dialog(host.page).getByText('A sala está protegida por senha.')).toBeVisible();
  await closeSettings(host.page);
}

const join = (request: APIRequestContext, room: string, data: Record<string, unknown>, headers: Record<string, string> = {}) =>
  request.post(`/api/rooms/${encodeURIComponent(room)}/join`, { data, headers });

// ---------------------------------------------------------------------------------------------------------------
// Pela interface
// ---------------------------------------------------------------------------------------------------------------

test('o anfitrião liga a senha: quem já estava dentro continua e é avisado; quem chega precisa da senha', async ({ browser }) => {
  const room = uniqueRoom('liga');
  const ana = await newUser(browser);
  const beto = await newUser(browser);
  await enter(ana, room, 'Ana');
  await enter(beto, room, 'Beto');
  await expect(participants(ana.page).filter({ hasText: 'Beto' }).locator('.badge')).toHaveText('Conectado');

  await protect(ana);
  await expect(beto.page.getByText('A sala agora tem senha')).toBeVisible({ timeout: 20_000 });
  await expect(participants(ana.page)).toHaveCount(2); // ninguém foi expulso

  // quem chega pelo link, sem a senha, vê a tela de senha (e não entra)
  const cris = await newUser(browser);
  await cris.page.goto(`/room/${encodeURIComponent(room)}?name=Cris`);
  await expect(cris.page.getByText('Esta sala é protegida por senha')).toBeVisible({ timeout: 20_000 });
  await expect(inRoom(cris.page)).toHaveCount(0);
  await expect(participants(ana.page)).toHaveCount(2);

  // senha errada não entra e diz isso
  await cris.page.getByLabel('Senha da sala').fill('senha-errada');
  await cris.page.getByRole('button', { name: 'Entrar' }).click();
  await expect(cris.page.getByText('Senha incorreta.')).toBeVisible({ timeout: 20_000 });
  await expect(inRoom(cris.page)).toHaveCount(0);

  // a certa entra, na própria tela, sem recarregar
  await cris.page.getByLabel('Senha da sala').fill(SENHA);
  await cris.page.getByRole('button', { name: 'Entrar' }).click();
  await expect(inRoom(cris.page)).toBeVisible({ timeout: 20_000 });
  await expect(participants(ana.page)).toHaveCount(3, { timeout: 20_000 });
  expect(ana.errors).toEqual([]);
  for (const u of [ana, beto, cris]) await u.ctx.close();
});

test('a tela inicial avisa que a sala tem senha e pede a senha antes de entrar', async ({ browser }) => {
  const room = uniqueRoom('inicial');
  const ana = await newUser(browser);
  await enter(ana, room, 'Ana');
  await protect(ana);

  const novo = await newUser(browser);
  await novo.page.goto('/');
  await novo.page.getByLabel('Nome da sala').fill(room);
  await expect(novo.page.getByTestId('room-preview')).toHaveText(/Esta sala já existe: 1 pessoa na sala agora\. Ela é protegida por senha\./);
  await novo.page.getByLabel('Seu nome').fill('Novo');
  await novo.page.getByLabel('Senha da sala').fill(SENHA);
  await novo.page.getByRole('button', { name: 'Entrar na sala' }).click();
  await expect(inRoom(novo.page)).toBeVisible({ timeout: 20_000 });
  // a senha nunca vai na URL
  expect(novo.page.url()).not.toContain(SENHA);
  await expect(participants(ana.page)).toHaveCount(2, { timeout: 20_000 });
  await ana.ctx.close();
  await novo.ctx.close();
});

test('só o anfitrião (a pessoa mais antiga) controla a senha; ao sair, o título passa à seguinte', async ({ browser }) => {
  const room = uniqueRoom('anfitriao');
  const ana = await newUser(browser);
  const beto = await newUser(browser);
  await enter(ana, room, 'Ana');
  await enter(beto, room, 'Beto');
  await expect(participants(beto.page)).toHaveCount(2);

  await openSettings(beto.page);
  await expect(dialog(beto.page).getByText(/Só a pessoa mais antiga na sala pode/)).toBeVisible();
  await expect(dialog(beto.page).getByLabel('Proteger esta sala com senha')).toHaveCount(0);
  await closeSettings(beto.page);

  await openSettings(ana.page);
  await expect(dialog(ana.page).getByLabel('Proteger esta sala com senha')).toBeVisible();
  await closeSettings(ana.page);

  await ana.page.getByRole('button', { name: 'Sair' }).click();
  await expect(participants(beto.page)).toHaveCount(1, { timeout: 25_000 });
  await openSettings(beto.page);
  await expect(dialog(beto.page).getByLabel('Proteger esta sala com senha')).toBeVisible({ timeout: 15_000 });
  await closeSettings(beto.page);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('o anfitrião altera e remove a senha; remover libera a entrada de novo', async ({ browser }) => {
  const room = uniqueRoom('remove');
  const ana = await newUser(browser);
  await enter(ana, room, 'Ana');
  await protect(ana);

  // alterar: a antiga deixa de valer e a nova passa a valer
  await openSettings(ana.page);
  await dialog(ana.page).getByRole('button', { name: 'Alterar senha' }).click();
  await dialog(ana.page).getByTestId('room-password-new').fill('outra-senha-456');
  await dialog(ana.page).getByRole('button', { name: /Ativar senha|Salvar/ }).click();
  await closeSettings(ana.page);
  const r = ana.ctx.request;
  expect((await join(r, room, { name: 'X', password: SENHA })).status()).toBe(403);
  const ok = await join(r, room, { name: 'Y', password: 'outra-senha-456' });
  expect(ok.status()).toBe(200);

  // remover
  await openSettings(ana.page);
  await dialog(ana.page).getByRole('button', { name: 'Remover senha' }).click();
  await expect(dialog(ana.page).getByLabel('Proteger esta sala com senha')).not.toBeChecked({ timeout: 15_000 });
  await closeSettings(ana.page);

  const livre = await newUser(browser);
  await enter(livre, room, 'Livre');
  await expect(inRoom(livre.page)).toBeVisible({ timeout: 20_000 });
  await ana.ctx.close();
  await livre.ctx.close();
});

test('recarregar a página do anfitrião reentra sozinho, sem pedir a senha de novo', async ({ browser }) => {
  const room = uniqueRoom('recarrega');
  const ana = await newUser(browser);
  await enter(ana, room, 'Ana');
  await protect(ana);
  await ana.page.reload();
  await expect(inRoom(ana.page)).toBeVisible({ timeout: 25_000 });
  await expect(ana.page.getByText('Esta sala é protegida por senha')).toHaveCount(0);
  await ana.ctx.close();
});

// ---------------------------------------------------------------------------------------------------------------
// Pela API: segurança
// ---------------------------------------------------------------------------------------------------------------

test.describe('segurança da senha (API)', () => {
  async function protectedRoom(request: APIRequestContext, label: string) {
    const room = uniqueRoom(label);
    const host = await (await join(request, room, { name: 'Host' })).json();
    const set = await request.post(`/api/rooms/${encodeURIComponent(room)}/password`, {
      data: { peerId: host.peerId, token: host.token, action: 'set', password: SENHA },
    });
    expect(set.status()).toBe(200);
    expect((await set.json()).protected).toBe(true);
    return { room, host };
  }

  test('sem senha 403, errada 403, certa 200; o resultado diz que a sala é protegida', async ({ request }) => {
    const { room } = await protectedRoom(request, 'basico');
    const sem = await join(request, room, { name: 'A' });
    expect(sem.status()).toBe(403);
    expect((await sem.json()).error).toBe('password_required');
    const errada = await join(request, room, { name: 'B', password: 'nao-e-essa' });
    expect(errada.status()).toBe(403);
    expect((await errada.json()).error).toBe('wrong_password');
    const certa = await join(request, room, { name: 'C', password: SENHA });
    expect(certa.status()).toBe(200);
    expect((await certa.json()).protected).toBe(true);
  });

  test('a senha, o hash e o salt nunca aparecem em nenhuma resposta nem no preview', async ({ request }) => {
    const { room, host } = await protectedRoom(request, 'vazamento');
    const certa = await (await join(request, room, { name: 'C', password: SENHA })).json();
    const preview = await (await request.get(`/api/rooms/${encodeURIComponent(room)}/preview`)).json();
    const events = await (await request.get(`/api/rooms/${encodeURIComponent(room)}/events?peerId=${host.peerId}&token=${host.token}&since=0`)).text();
    for (const body of [JSON.stringify(certa), JSON.stringify(preview), events]) {
      expect(body).not.toContain(SENHA);
      expect(body).not.toMatch(/"(hash|salt|passwordHash|scrypt)"/i);
    }
    expect(preview).toEqual({ count: 2, closed: false, protected: true });
  });

  test('5 senhas erradas seguidas trancam a tentativa (429 com Retry-After), até para a senha certa', async ({ request }) => {
    const { room } = await protectedRoom(request, 'forca-bruta');
    for (let i = 0; i < 5; i++) {
      const r = await join(request, room, { name: 'X', password: `errada-${i}` });
      expect([403, 429]).toContain(r.status());
    }
    const trancado = await join(request, room, { name: 'X', password: SENHA });
    expect(trancado.status()).toBe(429);
    expect(Number(trancado.headers()['retry-after'])).toBeGreaterThan(0);
    expect((await trancado.json()).error).toBe('too_many_attempts');
  });

  test('só o anfitrião muda a senha; quem não é anfitrião recebe 403 not_host', async ({ request }) => {
    const { room } = await protectedRoom(request, 'nao-anfitriao');
    const outro = await (await join(request, room, { name: 'Outro', password: SENHA })).json();
    const tenta = await request.post(`/api/rooms/${encodeURIComponent(room)}/password`, { data: { peerId: outro.peerId, token: outro.token, action: 'clear' } });
    expect(tenta.status()).toBe(403);
    expect((await tenta.json()).error).toBe('not_host');
    // e a sala segue protegida
    expect((await join(request, room, { name: 'Z' })).status()).toBe(403);
  });

  test('senha curta ou longa demais é recusada (400) e token errado não altera nada', async ({ request }) => {
    const room = uniqueRoom('validacao');
    const host = await (await join(request, room, { name: 'Host' })).json();
    const url = `/api/rooms/${encodeURIComponent(room)}/password`;
    for (const password of ['abc', 'x'.repeat(65), '']) {
      const r = await request.post(url, { data: { peerId: host.peerId, token: host.token, action: 'set', password } });
      expect(r.status(), password.slice(0, 5)).toBe(400);
    }
    const semToken = await request.post(url, { data: { peerId: host.peerId, token: 'token-errado', action: 'set', password: SENHA } });
    expect(semToken.status()).toBe(410);
    expect((await join(request, room, { name: 'Livre' })).status()).toBe(200); // continua sem senha
  });

  test('o admin observando a sala entra sem a senha; o corpo do cliente não finge ser observador', async ({ request }) => {
    const { room } = await protectedRoom(request, 'admin');
    const obs = await join(request, room, { name: 'Admin', observer: true }, { cookie: adminCookie });
    expect(obs.status()).toBe(200);
    const falso = await join(request, room, { name: 'Falso', observer: true });
    expect(falso.status()).toBe(403);
    expect((await falso.json()).error).toBe('forbidden');
  });

  test('a senha sobrevive à sala ficar vazia por um instante (recarregar a página não abre a sala)', async ({ request }) => {
    const { room, host } = await protectedRoom(request, 'persiste');
    await request.post(`/api/rooms/${encodeURIComponent(room)}/leave`, { data: { peerId: host.peerId, token: host.token } });
    const preview = await (await request.get(`/api/rooms/${encodeURIComponent(room)}/preview`)).json();
    expect(preview.protected).toBe(true);
    expect(preview.count).toBe(0);
    expect((await join(request, room, { name: 'Intruso' })).status()).toBe(403);
    expect((await join(request, room, { name: 'Dono', password: SENHA })).status()).toBe(200);
  });
});

test('o painel do admin mostra "com senha" só nas salas protegidas, sem expor a senha', async ({ request }) => {
  const livre = uniqueRoom('adm-livre');
  const prot = uniqueRoom('adm-prot');
  await join(request, livre, { name: 'A' });
  const host = await (await join(request, prot, { name: 'B' })).json();
  await request.post(`/api/rooms/${encodeURIComponent(prot)}/password`, {
    data: { peerId: host.peerId, token: host.token, action: 'set', password: SENHA },
  });
  const res = await request.get('/api/admin/rooms', { headers: { cookie: adminCookie } });
  expect(res.status()).toBe(200);
  const text = await res.text();
  expect(text).not.toContain(SENHA);
  const rooms = (JSON.parse(text).rooms ?? JSON.parse(text)) as { name: string; passwordProtected: boolean }[];
  expect(rooms.find((r) => r.name === prot)?.passwordProtected).toBe(true);
  expect(rooms.find((r) => r.name === livre)?.passwordProtected).toBe(false);
});
