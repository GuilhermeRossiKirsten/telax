import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { ADMIN_TEST_ENV } from '../playwright.config';
import { SESSION_COOKIE, signAdminSession } from '../src/server/admin-auth';

/** Tela inicial: ao digitar o nome de uma sala que já existe, mostra que ela existe e quantas pessoas estão nela. */

const BASE = 'http://localhost:3100';
const adminSession = signAdminSession(
  { login: ADMIN_TEST_ENV.ADMIN_GITHUB_USER, id: 1, exp: Date.now() + 3_600_000 },
  ADMIN_TEST_ENV.ADMIN_SESSION_SECRET,
);
const adminHeaders = { cookie: `${SESSION_COOKIE}=${adminSession}`, origin: BASE };

let seq = 0;
const uniqueRoom = (label: string) => `e2e-prev-${label}-${Date.now()}-${++seq}`;

type User = { ctx: BrowserContext; page: Page };

async function newUser(browser: Browser): Promise<User> {
  const ctx = await browser.newContext({ permissions: ['camera', 'microphone'] });
  return { ctx, page: await ctx.newPage() };
}

async function enter(u: User, room: string, name: string) {
  await u.page.goto('/');
  await u.page.getByLabel('Nome da sala').fill(room);
  await u.page.getByLabel('Seu nome').fill(name);
  await u.page.getByRole('button', { name: 'Entrar na sala' }).click();
  await expect(u.page).toHaveURL(/\/room\//);
}

const preview = (p: Page) => p.getByTestId('room-preview');

test('sala que não existe: nenhum aviso aparece', async ({ browser }) => {
  const u = await newUser(browser);
  await u.page.goto('/');
  await u.page.getByLabel('Nome da sala').fill(uniqueRoom('nova'));
  await u.page.waitForTimeout(1200); // bem mais que a espera de digitação: não aparece nada
  await expect(preview(u.page)).toHaveCount(0);
  await u.ctx.close();
});

test('sala que já existe: diz que ela existe e quantas pessoas estão nela, e acompanha a contagem', async ({ browser }) => {
  const room = uniqueRoom('conta');
  const ana = await newUser(browser);
  await enter(ana, room, 'Ana');

  const visitante = await newUser(browser);
  await visitante.page.goto('/');
  const campo = visitante.page.getByLabel('Nome da sala');
  await campo.fill(room);
  await expect(preview(visitante.page)).toHaveText('Esta sala já existe: 1 pessoa na sala agora.');
  await expect(preview(visitante.page)).toHaveAttribute('data-tone', 'live');

  const beto = await newUser(browser);
  await enter(beto, room, 'Beto');
  // o preview não faz polling (cota da Vercel): atualiza quando o nome é digitado de novo
  await campo.fill(room + 'x');
  await campo.fill(room);
  await expect(preview(visitante.page)).toHaveText('Esta sala já existe: 2 pessoas na sala agora.');

  // e some quando o nome deixa de ser o de uma sala existente
  await campo.fill(uniqueRoom('outra'));
  await expect(preview(visitante.page)).toHaveCount(0);
  for (const u of [ana, beto, visitante]) await u.ctx.close();
});

test('o link com ?room= já mostra o preview, sem digitar', async ({ browser }) => {
  const room = uniqueRoom('link');
  const ana = await newUser(browser);
  await enter(ana, room, 'Ana');
  const convidado = await newUser(browser);
  await convidado.page.goto(`/?room=${encodeURIComponent(room)}`);
  await expect(preview(convidado.page)).toHaveText('Esta sala já existe: 1 pessoa na sala agora.');
  await ana.ctx.close();
  await convidado.ctx.close();
});

test('o preview só mostra a contagem: nenhum nome, id ou IP', async ({ browser, request }) => {
  const room = uniqueRoom('privado');
  const ana = await newUser(browser);
  await enter(ana, room, 'Ana Secreta');
  const res = await request.get(`/api/rooms/${encodeURIComponent(room)}/preview`);
  expect(res.status()).toBe(200);
  expect(res.headers()['cache-control']).toContain('no-store');
  const body = await res.json();
  expect(Object.keys(body).sort()).toEqual(['closed', 'count', 'protected']);
  expect(JSON.stringify(body)).not.toMatch(/Ana|ip|peer|token/i);

  const convidado = await newUser(browser);
  await convidado.page.goto('/');
  await convidado.page.getByLabel('Nome da sala').fill(room);
  await expect(preview(convidado.page)).toBeVisible();
  expect(await convidado.page.locator('body').innerText()).not.toContain('Ana Secreta');
  expect((await request.get('/api/rooms/%20/preview')).status()).toBe(400);
  await ana.ctx.close();
  await convidado.ctx.close();
});

test('digitar rápido faz poucas consultas (espera antes de consultar)', async ({ browser }) => {
  const u = await newUser(browser);
  let calls = 0;
  u.page.on('request', (r) => {
    if (r.url().includes('/preview')) calls++;
  });
  await u.page.goto('/');
  await u.page.getByLabel('Nome da sala').pressSequentially('reuniao-do-time', { delay: 40 });
  await u.page.waitForTimeout(1000);
  expect(calls).toBeGreaterThanOrEqual(1);
  expect(calls).toBeLessThanOrEqual(2); // 15 teclas, no máximo 2 consultas
  await u.ctx.close();
});

test('sala vazia deixa de existir; observador do admin não conta como pessoa', async ({ request }) => {
  const room = uniqueRoom('contagem-api');
  const j1 = await (await request.post(`/api/rooms/${room}/join`, { data: { name: 'Ana' } })).json();
  expect((await (await request.get(`/api/rooms/${room}/preview`)).json()).count).toBe(1);

  const obs = await request.post(`/api/rooms/${room}/join`, { data: { name: 'Admin', observer: true }, headers: { cookie: adminHeaders.cookie } });
  expect(obs.status()).toBe(200);
  expect((await (await request.get(`/api/rooms/${room}/preview`)).json()).count).toBe(1); // o observador não é pessoa

  await request.post(`/api/rooms/${room}/leave`, { data: { peerId: j1.peerId, token: j1.token } });
  expect((await (await request.get(`/api/rooms/${room}/preview`)).json()).count).toBe(0);
});

test('sala encerrada pelo administrador: o preview diz que ela existe, mas foi encerrada', async ({ browser, request }) => {
  const room = uniqueRoom('fechada');
  const close = await request.post(`/api/admin/rooms/${encodeURIComponent(room)}/close`, {
    headers: { ...adminHeaders, 'content-type': 'application/json' },
    data: JSON.stringify({ reason: 'teste' }),
  });
  expect(close.status()).toBe(200);
  try {
    const u = await newUser(browser);
    await u.page.goto('/');
    await u.page.getByLabel('Nome da sala').fill(room);
    await expect(preview(u.page)).toHaveText('Esta sala existe, mas foi encerrada pelo administrador.');
    await expect(preview(u.page)).toHaveAttribute('data-tone', 'closed');
    await u.ctx.close();
  } finally {
    await request.post(`/api/admin/rooms/${encodeURIComponent(room)}/reopen`, { headers: { ...adminHeaders, 'content-type': 'application/json' }, data: '{}' });
  }
});
