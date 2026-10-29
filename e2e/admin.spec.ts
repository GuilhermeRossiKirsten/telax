import { expect, test, type APIRequestContext, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ADMIN_TEST_ENV } from '../playwright.config';
import { SESSION_COOKIE, signAdminSession } from '../src/server/admin-auth';

/**
 * Painel de administração. O GitHub real não é acionado: a sessão é ASSINADA AQUI com o mesmo segredo do servidor de
 * teste (o fluxo OAuth tem teste unitário com `fetch` falso). Nada de "modo de teste" no código de produção.
 */

const BASE = 'http://localhost:3100';
const SECRET = ADMIN_TEST_ENV.ADMIN_SESSION_SECRET;
const ADMIN_LOGIN = ADMIN_TEST_ENV.ADMIN_GITHUB_USER;

const session = (over: Partial<{ login: string; id: number; exp: number }> = {}, secret = SECRET) =>
  signAdminSession({ login: ADMIN_LOGIN, id: 1, exp: Date.now() + 3_600_000, ...over }, secret);

async function withAdmin(ctx: BrowserContext, value = session()) {
  await ctx.addCookies([{ name: SESSION_COOKIE, value, url: BASE }]);
}

const adminHeaders = (value = session()) => ({ cookie: `${SESSION_COOKIE}=${value}`, origin: BASE });

type User = { ctx: BrowserContext; page: Page; errors: string[] };

let seq = 0;
const uniqueRoom = (label: string) => `e2e-adm-${label}-${Date.now()}-${++seq}`;

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

async function pair(browser: Browser, label: string) {
  const room = uniqueRoom(label);
  const ana = await newUser(browser);
  const beto = await newUser(browser);
  await enter(ana, room, 'Ana');
  await enter(beto, room, 'Beto');
  await expect(participants(ana.page).filter({ hasText: 'Beto' }).locator('.badge')).toHaveText('Conectado');
  return { room, ana, beto };
}

async function openAdmin(browser: Browser) {
  const ctx = await browser.newContext();
  await withAdmin(ctx);
  const page = await ctx.newPage();
  await page.goto('/admin');
  await expect(page.getByRole('tablist', { name: 'Seções do painel' })).toBeVisible();
  return { ctx, page };
}

/** Abre a sala na tela de admin (a sala precisa aparecer na lista, que atualiza a cada 5 s). */
async function viewRoom(admin: Page, room: string) {
  await admin.getByRole('button', { name: `Ver sala ${room}` }).click({ timeout: 30_000 });
}

async function confirm(admin: Page, label: string) {
  await admin.getByRole('button', { name: label, exact: true }).click();
  await admin.getByRole('group', { name: `Confirmar: ${label}` }).getByRole('button').first().click();
}

/** Limpa todos os bloqueios: ban por IP vale para todos os navegadores do teste (mesmo IP). */
async function clearBans(request: APIRequestContext) {
  const res = await request.get('/api/admin/bans', { headers: adminHeaders() });
  if (!res.ok()) return;
  const { bans } = (await res.json()) as { bans: Array<{ id: string }> };
  for (const b of bans) await request.delete(`/api/admin/bans/${encodeURIComponent(b.id)}`, { headers: adminHeaders() });
}

test.afterEach(async ({ request }) => {
  await clearBans(request);
});

// ---------------------------------------------------------------------------------------------------------------
// Controle de acesso: TODO endpoint de admin é protegido
// ---------------------------------------------------------------------------------------------------------------

const ENDPOINTS: Array<{ method: 'GET' | 'POST' | 'DELETE'; path: string; body?: unknown }> = [
  { method: 'GET', path: '/api/admin/me' },
  { method: 'GET', path: '/api/admin/rooms' },
  { method: 'GET', path: '/api/admin/rooms/qualquer' },
  { method: 'POST', path: '/api/admin/rooms/qualquer/message', body: { text: 'oi' } },
  { method: 'POST', path: '/api/admin/rooms/qualquer/close', body: {} },
  { method: 'POST', path: '/api/admin/rooms/qualquer/reopen', body: {} },
  { method: 'POST', path: '/api/admin/rooms/qualquer/kick', body: { peerId: '6a2989c8-188f-4f4e-bab5-d0aedc5a9588' } },
  { method: 'POST', path: '/api/admin/rooms/qualquer/command', body: { peerId: '6a2989c8-188f-4f4e-bab5-d0aedc5a9588', what: 'all' } },
  { method: 'POST', path: '/api/admin/broadcast', body: { text: 'oi' } },
  { method: 'GET', path: '/api/admin/bans' },
  { method: 'POST', path: '/api/admin/bans', body: { ip: '203.0.113.9' } },
  { method: 'DELETE', path: '/api/admin/bans/qualquer' },
];

const call = (request: APIRequestContext, e: (typeof ENDPOINTS)[number], headers: Record<string, string>) =>
  request.fetch(e.path, { method: e.method, headers: { 'content-type': 'application/json', ...headers }, data: e.body ? JSON.stringify(e.body) : undefined });

test.describe('todos os endpoints de admin são protegidos', () => {
  for (const e of ENDPOINTS) {
    test(`${e.method} ${e.path}: sem sessão = 401; sessão de OUTRO usuário = 403; segredo errado, adulterada ou expirada = 401`, async ({ request }) => {
      expect((await call(request, e, { origin: BASE })).status()).toBe(401);
      expect((await call(request, e, { ...adminHeaders(session({ login: 'outra-pessoa' })) })).status()).toBe(403);
      expect((await call(request, e, { ...adminHeaders(session({}, 'um-segredo-errado-com-mais-de-trinta-e-dois-chars')) })).status()).toBe(401);
      expect((await call(request, e, { ...adminHeaders(session({ exp: Date.now() - 1000 })) })).status()).toBe(401);
      const [payload, mac] = session().split('.');
      const forged = Buffer.from(JSON.stringify({ login: ADMIN_LOGIN, id: 1, exp: Date.now() + 9e9 })).toString('base64url');
      expect(forged).not.toBe(payload);
      expect((await call(request, e, { ...adminHeaders(`${forged}.${mac}`) })).status()).toBe(401);
    });
  }

  test('métodos que alteram dados exigem a origem do próprio site, mesmo com sessão válida', async ({ request }) => {
    const res = await request.post('/api/admin/broadcast', {
      headers: { cookie: `${SESSION_COOKIE}=${session()}`, origin: 'https://site-malicioso.example', 'content-type': 'application/json' },
      data: JSON.stringify({ text: 'oi' }),
    });
    expect(res.status()).toBe(403);
    expect((await res.json()).error).toBe('bad_origin');
  });

  test('o admin legítimo passa', async ({ request }) => {
    const res = await request.get('/api/admin/me', { headers: adminHeaders() });
    expect(res.status()).toBe(200);
    expect((await res.json()).login).toBe(ADMIN_LOGIN);
  });

  test('entrar como observador sem sessão de admin é negado e ninguém entra na sala', async ({ request }) => {
    const room = uniqueRoom('obs-negado');
    const res = await request.post(`/api/rooms/${room}/join`, { data: { name: 'Espiao', observer: true } });
    expect(res.status()).toBe(403);
    const ok = await request.post(`/api/rooms/${room}/join`, { data: { name: 'Normal' } });
    expect(ok.status()).toBe(200);
    const body = await ok.json();
    expect(body.participants).toHaveLength(1); // o espião NÃO entrou
    // e quem tenta se passar por observador também não ganha os dados de admin
    expect(JSON.stringify(body)).not.toMatch(/"ip"|deviceId/);
  });

  test('o corpo do cliente não consegue escolher o próprio IP nem virar observador', async ({ request }) => {
    const room = uniqueRoom('ip-forjado');
    const res = await request.post(`/api/rooms/${room}/join`, { data: { name: 'Forjador', ip: '198.51.100.1', observer: true } });
    expect(res.status()).toBe(403);
  });

  test('/admin sem sessão pede login e não mostra nada de admin', async ({ page }) => {
    await page.goto('/admin');
    await expect(page.getByRole('button', { name: /Entrar com GitHub/ }).or(page.getByRole('link', { name: /Entrar com GitHub/ }))).toBeVisible();
    await expect(page.getByRole('tablist', { name: 'Seções do painel' })).toHaveCount(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Poderes do admin
// ---------------------------------------------------------------------------------------------------------------

test('o admin vê as salas criadas, os participantes e as câmeras ao vivo; os participantes são avisados', async ({ browser }) => {
  const { room, ana, beto } = await pair(browser, 'ver');
  await ana.page.getByRole('button', { name: 'Câmera', exact: true }).click();

  const admin = await openAdmin(browser);
  await expect(admin.page.getByRole('row', { name: new RegExp(room) })).toBeVisible({ timeout: 30_000 });
  await viewRoom(admin.page, room);

  // tabela de participantes com o IP visto pelo servidor
  await expect(admin.page.getByRole('row', { name: /Ana/ })).toBeVisible();
  await expect(admin.page.getByRole('row', { name: /Beto/ })).toBeVisible();
  // o IP e o dispositivo aparecem só aqui, na tela de admin
  await expect(admin.page.getByRole('row', { name: /Ana/ })).toContainText(/\d|::1/);

  // visão ao vivo: a câmera de Ana chega ao admin com imagem de verdade
  const live = admin.page.getByRole('region', { name: `Visão ao vivo da sala ${room}` });
  const cam = live.getByRole('group', { name: 'Câmera de Ana' }).locator('video');
  await expect.poll(() => cam.evaluate((v: HTMLVideoElement) => v.videoWidth), { timeout: 40_000 }).toBeGreaterThan(0);

  // os participantes veem o aviso, e o observador NÃO é um participante (nem na lista nem em tile)
  await expect(ana.page.getByText(/Um administrador pode estar vendo/)).toBeVisible({ timeout: 20_000 });
  await expect(beto.page.getByText(/Um administrador pode estar vendo/)).toBeVisible();
  await expect(participants(ana.page)).toHaveCount(2);
  await expect(ana.page.locator('figure[data-testid="tile"][data-kind="person"]')).toHaveCount(2);

  // sair da visão ao vivo tira o observador e o aviso some
  await admin.page.getByRole('button', { name: /Salas/ }).first().click();
  await expect(live).toHaveCount(0);
  await expect(ana.page.getByText(/Um administrador pode estar vendo/)).toHaveCount(0, { timeout: 30_000 });
  await admin.ctx.close();
  expect(ana.errors).toEqual([]);
  await ana.ctx.close();
  await beto.ctx.close();
});

test('mensagem do admin para a sala aparece como aviso para todos', async ({ browser }) => {
  const { room, ana, beto } = await pair(browser, 'msg');
  const admin = await openAdmin(browser);
  await admin.page.getByRole('button', { name: `Mensagem para a sala ${room}` }).click({ timeout: 30_000 });
  await admin.page.getByPlaceholder('Escreva a mensagem…').fill('Manutenção em 5 minutos');
  await admin.page.getByRole('button', { name: 'Enviar à sala' }).click();

  for (const u of [ana, beto]) {
    await expect(u.page.getByText(/Mensagem do administrador/)).toBeVisible({ timeout: 20_000 });
    await expect(u.page.getByText(/Manutenção em 5 minutos/)).toBeVisible();
  }
  await admin.ctx.close();
  await ana.ctx.close();
  await beto.ctx.close();
});

test('expulsar tira só aquela pessoa, ela vê o motivo e NÃO reentra sozinha', async ({ browser }) => {
  const { room, ana, beto } = await pair(browser, 'kick');
  const admin = await openAdmin(browser);
  await viewRoom(admin.page, room);
  await admin.page.getByRole('button', { name: 'Expulsar Beto', exact: true }).click();
  await admin.page.getByLabel(/Motivo/).fill('conversa fora do assunto');
  await admin.page.getByRole('group', { name: 'Confirmar: Expulsar Beto' }).getByRole('button').first().click();

  await expect(beto.page.getByText(/removido da sala pelo administrador/)).toBeVisible({ timeout: 25_000 });
  await expect(beto.page.getByText(/conversa fora do assunto/)).toBeVisible();
  await expect(participants(ana.page)).toHaveCount(1, { timeout: 25_000 });
  // não volta sozinho
  await beto.page.waitForTimeout(6000);
  await expect(beto.page.getByText(/removido da sala pelo administrador/)).toBeVisible();
  await expect(participants(ana.page)).toHaveCount(1);
  await admin.ctx.close();
  await ana.ctx.close();
  await beto.ctx.close();
});

test('banir bloqueia a pessoa e quem entra depois do mesmo IP/dispositivo; remover o bloqueio libera', async ({ browser }) => {
  const { room, ana, beto } = await pair(browser, 'ban');
  const admin = await openAdmin(browser);
  await viewRoom(admin.page, room);
  await confirm(admin.page, 'Banir Beto (IP + dispositivo)');

  await expect(beto.page.getByText(/bloqueado/)).toBeVisible({ timeout: 25_000 });
  // todos os navegadores do teste compartilham UM IP: o ban por IP atinge quem casa, inclusive a Ana (efeito colateral
  // conhecido de IP compartilhado, avisado na tela de Bloqueios)
  await expect(ana.page.getByText(/bloqueado/)).toBeVisible({ timeout: 25_000 });

  // um navegador novo (outro contexto, mesmo IP) é barrado na entrada
  const novo = await newUser(browser);
  await novo.page.goto('/');
  await novo.page.getByLabel('Nome da sala').fill(uniqueRoom('ban-novo'));
  await novo.page.getByLabel('Seu nome').fill('Novato');
  await novo.page.getByRole('button', { name: 'Entrar na sala' }).click();
  await expect(novo.page.getByText(/bloqueado/)).toBeVisible({ timeout: 20_000 });

  // aba Bloqueios: lista e aviso sobre MAC; remover libera
  await admin.page.getByRole('tab', { name: 'Bloqueios' }).click();
  await expect(admin.page.getByText(/endereço MAC não é acessível/i)).toBeVisible();
  const remove = admin.page.getByRole('button', { name: /^Remover bloqueio/ });
  await expect(remove.first()).toBeVisible({ timeout: 20_000 });
  const before = await remove.count();
  await confirm(admin.page, ((await remove.first().textContent()) ?? '').trim());
  await expect(remove).toHaveCount(before - 1, { timeout: 20_000 });
  await clearBans(admin.ctx.request); // o que sobrou (ex.: o ban de dispositivo)

  const livre = await newUser(browser);
  await enter(livre, uniqueRoom('ban-livre'), 'Livre');
  await expect(livre.page.getByRole('navigation', { name: 'Controles da reunião' })).toBeVisible();
  await admin.ctx.close();
  for (const u of [ana, beto, novo, livre]) await u.ctx.close();
});

test('fechar a sala expulsa todos, barra novas entradas e "Reabrir" libera', async ({ browser }) => {
  const { room, ana, beto } = await pair(browser, 'close');
  const admin = await openAdmin(browser);
  await confirm(admin.page, `Fechar sala ${room}`).catch(async () => {
    // a lista pode ter atualizado entre os cliques: tenta de novo
    await confirm(admin.page, `Fechar sala ${room}`);
  });

  for (const u of [ana, beto]) await expect(u.page.getByText(/encerrada pelo administrador/)).toBeVisible({ timeout: 25_000 });

  const novo = await newUser(browser);
  await novo.page.goto('/');
  await novo.page.getByLabel('Nome da sala').fill(room);
  await novo.page.getByLabel('Seu nome').fill('Atrasado');
  await novo.page.getByRole('button', { name: 'Entrar na sala' }).click();
  await expect(novo.page.getByText(/encerrada/)).toBeVisible({ timeout: 20_000 });

  await admin.page.getByRole('button', { name: `Reabrir sala ${room}` }).click({ timeout: 30_000 });
  const volta = await newUser(browser);
  await enter(volta, room, 'Voltou');
  await expect(volta.page.getByRole('navigation', { name: 'Controles da reunião' })).toBeVisible();
  await admin.ctx.close();
  for (const u of [ana, beto, novo, volta]) await u.ctx.close();
});

test('o admin para a transmissão de tela de UMA pessoa e as outras seguem normais', async ({ browser }) => {
  const { room, ana, beto } = await pair(browser, 'parar');
  await beto.page.getByRole('button', { name: 'Tela', exact: true }).click();
  await expect(beto.page.getByRole('button', { name: 'Parar compartilhamento' })).toBeVisible();
  await expect(ana.page.locator('figure[data-testid="tile"][data-sharing="true"]')).toHaveCount(1);

  const admin = await openAdmin(browser);
  await viewRoom(admin.page, room);
  await confirm(admin.page, 'Parar telas de Beto');

  await expect(beto.page.getByRole('button', { name: 'Parar compartilhamento' })).toHaveCount(0, { timeout: 25_000 });
  await expect(ana.page.locator('figure[data-testid="tile"][data-sharing="true"]')).toHaveCount(0, { timeout: 25_000 });
  // ninguém foi removido
  await expect(participants(ana.page)).toHaveCount(2);
  await admin.ctx.close();
  await ana.ctx.close();
  await beto.ctx.close();
});

test('mensagem global chega a participantes de salas diferentes', async ({ browser }) => {
  const a = await pair(browser, 'glob-a');
  const b = await pair(browser, 'glob-b');
  const admin = await openAdmin(browser);
  await admin.page.getByRole('button', { name: /Mensagem global/ }).click({ timeout: 30_000 });
  await admin.page.getByPlaceholder('Escreva a mensagem…').fill('Aviso geral do admin');
  await admin.page.getByRole('button', { name: 'Enviar a todas as salas' }).click();
  for (const u of [a.ana, a.beto, b.ana, b.beto]) await expect(u.page.getByText(/Aviso geral do admin/)).toBeVisible({ timeout: 25_000 });
  await admin.ctx.close();
  for (const u of [a.ana, a.beto, b.ana, b.beto]) await u.ctx.close();
});
