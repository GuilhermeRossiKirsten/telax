import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, signAdminSession } from './admin-auth';
import { adminRoute, isUuid, optionalReason, readJsonBody, textField } from './admin-route';

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres!!';
const ADMIN_ENV = {
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'csecret',
  ADMIN_GITHUB_USER: 'dono',
  ADMIN_SESSION_SECRET: SECRET,
};
const KEYS = Object.keys(ADMIN_ENV);
const NOW = Date.now();

const session = (over: Partial<{ login: string; id: number; exp: number }> = {}) =>
  `${SESSION_COOKIE}=${signAdminSession({ login: 'dono', id: 1, exp: NOW + 3_600_000, ...over }, SECRET)}`;

const saved: Record<string, string | undefined> = {};
const fakeStore = { listRooms: vi.fn(), kick: vi.fn() };

beforeEach(() => {
  for (const k of KEYS) saved[k] = process.env[k];
  Object.assign(process.env, ADMIN_ENV);
  (globalThis as unknown as { __telaxStore?: unknown }).__telaxStore = fakeStore;
  fakeStore.listRooms.mockReset();
  fakeStore.kick.mockReset();
});
afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  (globalThis as unknown as { __telaxStore?: unknown }).__telaxStore = undefined;
});

const handler = vi.fn(async () => Response.json({ ok: true }));
const route = adminRoute(handler);
const ctx = { params: Promise.resolve({ room: 'sala' }) };
const call = (method: string, headers: Record<string, string> = {}, body?: string) =>
  route(new Request('http://app.test/api/admin/x', { method, headers: { host: 'app.test', ...headers }, body }), ctx);

describe('adminRoute: ordem das checagens (negar por padrão)', () => {
  beforeEach(() => handler.mockClear());

  it('admin DESLIGADO (variável faltando) → 503, mesmo sem cookie, e o handler nunca roda', async () => {
    delete process.env.ADMIN_SESSION_SECRET;
    const res = await call('GET');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'admin_disabled' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('lê o ambiente a cada requisição (ligar e desligar vale na hora)', async () => {
    expect((await call('GET', { cookie: session() })).status).toBe(200);
    delete process.env.GITHUB_CLIENT_ID;
    expect((await call('GET', { cookie: session() })).status).toBe(503);
  });

  it('sem cookie, cookie lixo, assinatura errada ou expirado → 401', async () => {
    for (const cookie of [undefined, `${SESSION_COOKIE}=lixo`, `${SESSION_COOKIE}=a.b`, session({ exp: NOW - 1 }), `outro=1`]) {
      const res = await call('GET', cookie ? { cookie } : {});
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: 'unauthorized' });
    }
    // assinada com OUTRO segredo
    const forged = `${SESSION_COOKIE}=${signAdminSession({ login: 'dono', id: 1, exp: NOW + 1000 }, 'outro-segredo-bem-longo-e-totalmente-diferente')}`;
    expect((await call('GET', { cookie: forged })).status).toBe(401);
    expect(handler).not.toHaveBeenCalled();
  });

  it('sessão assinada corretamente mas de OUTRO usuário → 403', async () => {
    const res = await call('GET', { cookie: session({ login: 'invasor' }) });
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'forbidden' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('admin válido em GET: o handler recebe a sessão, o store, os parâmetros e a requisição', async () => {
    const res = await call('GET', { cookie: session() });
    expect(res.status).toBe(200);
    expect(handler).toHaveBeenCalledTimes(1);
    const arg = (handler.mock.calls[0] as unknown[])[0] as { admin: { login: string }; store: unknown; params: { room: string }; req: Request };
    expect(arg.admin.login).toBe('dono');
    expect(arg.store).toBe(fakeStore);
    expect(arg.params).toEqual({ room: 'sala' });
    expect(arg.req.method).toBe('GET');
  });

  it('um GET com Origin de outro site passa (só métodos mutantes checam origem)', async () => {
    expect((await call('GET', { cookie: session(), origin: 'https://evil.test' })).status).toBe(200);
  });

  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])('%s sem Origin nem Referer → 403 bad_origin', async (method) => {
    const res = await call(method, { cookie: session() }, '{}');
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: 'bad_origin' });
    expect(handler).not.toHaveBeenCalled();
  });

  it('POST com Origin de OUTRO host, ou Referer de outro host → 403 bad_origin', async () => {
    expect((await call('POST', { cookie: session(), origin: 'https://evil.test' }, '{}')).status).toBe(403);
    expect((await call('POST', { cookie: session(), referer: 'https://evil.test/pagina' }, '{}')).status).toBe(403);
    expect((await call('POST', { cookie: session(), origin: 'null' }, '{}')).status).toBe(403);
    expect(handler).not.toHaveBeenCalled();
  });

  it('POST com Origin ou Referer do MESMO host passa (inclusive atrás de proxy com x-forwarded-host)', async () => {
    expect((await call('POST', { cookie: session(), origin: 'http://app.test' }, '{}')).status).toBe(200);
    expect((await call('POST', { cookie: session(), referer: 'http://app.test/admin' }, '{}')).status).toBe(200);
    const proxied = await route(
      new Request('http://interno:3000/api/admin/x', {
        method: 'POST',
        headers: { cookie: session(), origin: 'https://meu.dominio', 'x-forwarded-host': 'meu.dominio', host: 'interno:3000' },
        body: '{}',
      }),
      ctx,
    );
    expect(proxied.status).toBe(200);
  });

  it('o Origin é conferido ANTES do handler, mas depois da autenticação (sem cookie é 401, não 403)', async () => {
    expect((await call('POST', { origin: 'https://evil.test' }, '{}')).status).toBe(401);
  });

  it('TODAS as respostas (503, 401, 403, 200) levam Cache-Control: no-store', async () => {
    const ok = await call('GET', { cookie: session() });
    const noCookie = await call('GET');
    const other = await call('GET', { cookie: session({ login: 'x' }) });
    delete process.env.ADMIN_SESSION_SECRET;
    const off = await call('GET');
    for (const r of [ok, noCookie, other, off]) expect(r.headers.get('cache-control')).toBe('no-store');
  });

  it('erro inesperado no handler → 500 genérico, sem vazar a mensagem nem a pilha', async () => {
    const boom = adminRoute(async () => {
      throw new Error('senha do banco: hunter2');
    });
    const res = await boom(new Request('http://app.test/x', { headers: { host: 'app.test', cookie: session() } }), ctx);
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(text).not.toContain('hunter2');
    expect(JSON.parse(text)).toEqual({ error: 'internal' });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });
});

describe('helpers de validação', () => {
  it('readJsonBody: objeto JSON até 16 KB; o resto vira null', async () => {
    const req = (body: string) => new Request('http://x', { method: 'POST', body });
    expect(await readJsonBody(req('{"a":1}'))).toEqual({ a: 1 });
    expect(await readJsonBody(req('[1]'))).toBeNull();
    expect(await readJsonBody(req('não json'))).toBeNull();
    expect(await readJsonBody(req('null'))).toBeNull();
    expect(await readJsonBody(req(JSON.stringify({ x: 'a'.repeat(17 * 1024) })))).toBeNull();
    expect(await readJsonBody(req(''))).toBeNull();
  });

  it('isUuid aceita só UUID; textField respeita 1..máx; optionalReason aceita ausente e limita a 200', () => {
    expect(isUuid('3f197123-2bf8-4730-aadf-6c61db50d59e')).toBe(true);
    expect(isUuid('3f197123')).toBe(false);
    expect(isUuid('$where')).toBe(false);
    expect(isUuid(5)).toBe(false);
    expect(textField({ t: '  oi  ' }, 't', 500)).toBe('oi');
    expect(textField({ t: '   ' }, 't', 500)).toBeNull();
    expect(textField({ t: 'a'.repeat(501) }, 't', 500)).toBeNull();
    expect(textField({}, 't', 500)).toBeNull();
    expect(optionalReason({})).toBeUndefined();
    expect(optionalReason({ reason: '  spam ' })).toBe('spam');
    expect(optionalReason({ reason: '' })).toBeUndefined();
    expect(optionalReason({ reason: 'a'.repeat(201) })).toBeNull(); // inválido
    expect(optionalReason({ reason: 7 })).toBeNull();
  });
});
