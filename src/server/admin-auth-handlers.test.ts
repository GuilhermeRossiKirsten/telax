import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SESSION_COOKIE, STATE_COOKIE, adminConfig, readCookie, verifyAdminSession, type AdminConfig } from './admin-auth';
import { createCallbackHandler, loginHandler, logoutHandler } from './admin-auth-handlers';

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres!!';
const ENV = { GITHUB_CLIENT_ID: 'cid', GITHUB_CLIENT_SECRET: 'csecret', ADMIN_GITHUB_USER: 'dono', ADMIN_SESSION_SECRET: SECRET };
const saved: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of Object.keys(ENV)) saved[k] = process.env[k];
  Object.assign(process.env, ENV);
});
afterEach(() => {
  vi.unstubAllEnvs();
  for (const k of Object.keys(ENV)) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

const config = adminConfig(ENV) as AdminConfig;
const setCookies = (res: Response) => res.headers.getSetCookie();
const cookieNamed = (res: Response, name: string) => setCookies(res).find((c) => c.startsWith(`${name}=`));
const valueOf = (setCookie: string | undefined) => setCookie?.split(';')[0].split('=').slice(1).join('=');

describe('GET /api/admin/auth/login', () => {
  const req = () => new Request('http://app.test/api/admin/auth/login', { headers: { host: 'app.test', 'x-forwarded-proto': 'https' } });

  it('admin desligado → 503 e nenhuma ida ao GitHub', async () => {
    delete process.env.ADMIN_GITHUB_USER;
    const res = await loginHandler()(req());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'admin_disabled' });
    expect(res.headers.get('location')).toBeNull();
  });

  it('redireciona ao GitHub com o state e grava o MESMO state num cookie HttpOnly de 10 min', async () => {
    const res = await loginHandler()(req());
    expect(res.status).toBe(302);
    const url = new URL(res.headers.get('location')!);
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.test/api/admin/auth/callback');
    expect(url.searchParams.get('scope')).toBe('read:user');
    const state = url.searchParams.get('state')!;
    const cookie = cookieNamed(res, STATE_COOKIE)!;
    expect(valueOf(cookie)).toBe(state);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/api/admin/auth');
    expect(cookie).toContain('Max-Age=600');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(url.toString()).not.toContain('csecret');
  });

  it('cada login usa um state novo', async () => {
    const a = new URL((await loginHandler()(req())).headers.get('location')!).searchParams.get('state');
    const b = new URL((await loginHandler()(req())).headers.get('location')!).searchParams.get('state');
    expect(a).not.toBe(b);
  });
});

describe('GET /api/admin/auth/callback', () => {
  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const githubAs = (login: string, id = 7) =>
    vi.fn(async (url: string | URL | Request) =>
      String(url).includes('access_token') ? ok({ access_token: 'gho_TOKEN-SECRETO' }) : ok({ login, id }),
    ) as unknown as typeof fetch;

  const cb = (query: string, cookie?: string) =>
    new Request(`http://app.test/api/admin/auth/callback?${query}`, { headers: { host: 'app.test', ...(cookie ? { cookie } : {}) } });
  const withState = (state = 'ESTADO123') => `${STATE_COOKIE}=${state}`;

  it('usuário certo: cria a sessão assinada, apaga o cookie de state e vai para /admin', async () => {
    const fetchFn = githubAs('Dono', 7);
    const res = await createCallbackHandler(fetchFn)(cb('code=C0D&state=ESTADO123', withState()));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin');
    const session = cookieNamed(res, SESSION_COOKIE)!;
    expect(session).toContain('HttpOnly');
    expect(session).toContain('SameSite=Lax');
    expect(session).toContain('Path=/');
    expect(session).toContain(`Max-Age=${12 * 60 * 60}`);
    const check = verifyAdminSession(valueOf(session), config, Date.now());
    expect(check).toMatchObject({ ok: true, session: { login: 'Dono', id: 7 } });
    // o state é de uso único: o cookie é apagado
    expect(cookieNamed(res, STATE_COOKIE)).toContain('Max-Age=0');
    // o token do GitHub nunca chega ao navegador
    expect(JSON.stringify([...res.headers.entries()])).not.toContain('gho_');
  });

  it('em produção a sessão leva Secure; em desenvolvimento não', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const prod = await createCallbackHandler(githubAs('dono'))(cb('code=c&state=ESTADO123', withState()));
    expect(cookieNamed(prod, SESSION_COOKIE)).toContain('Secure');
    vi.stubEnv('NODE_ENV', 'development');
    const dev = await createCallbackHandler(githubAs('dono'))(cb('code=c&state=ESTADO123', withState()));
    expect(cookieNamed(dev, SESSION_COOKIE)).not.toContain('Secure');
  });

  it('OUTRO usuário do GitHub: forbidden, SEM sessão', async () => {
    const res = await createCallbackHandler(githubAs('invasor'))(cb('code=c&state=ESTADO123', withState()));
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toBe('/admin?error=forbidden');
    expect(cookieNamed(res, SESSION_COOKIE)).toBeUndefined();
    expect(cookieNamed(res, STATE_COOKIE)).toContain('Max-Age=0');
  });

  it('com ADMIN_GITHUB_ID definido, o mesmo login com id diferente também é forbidden', async () => {
    process.env.ADMIN_GITHUB_ID = '7';
    try {
      const wrong = await createCallbackHandler(githubAs('dono', 8))(cb('code=c&state=ESTADO123', withState()));
      expect(wrong.headers.get('location')).toBe('/admin?error=forbidden');
      expect(cookieNamed(wrong, SESSION_COOKIE)).toBeUndefined();
      const right = await createCallbackHandler(githubAs('dono', 7))(cb('code=c&state=ESTADO123', withState()));
      expect(right.headers.get('location')).toBe('/admin');
    } finally {
      delete process.env.ADMIN_GITHUB_ID;
    }
  });

  it('state ausente, diferente ou sem cookie: error=state, SEM falar com o GitHub e sem sessão', async () => {
    const fetchFn = githubAs('dono');
    const h = createCallbackHandler(fetchFn);
    for (const req of [
      cb('code=c&state=ESTADO123'), // sem cookie
      cb('code=c', withState()), // sem state na URL
      cb('code=c&state=OUTRO', withState()), // diferente
      cb('code=c&state=', withState('')), // vazio
    ]) {
      const res = await h(req);
      expect(res.headers.get('location')).toBe('/admin?error=state');
      expect(cookieNamed(res, SESSION_COOKIE)).toBeUndefined();
    }
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('sem code ou GitHub falhando: error=github, sem sessão', async () => {
    const noCode = await createCallbackHandler(githubAs('dono'))(cb('state=ESTADO123', withState()));
    expect(noCode.headers.get('location')).toBe('/admin?error=github');
    const down = vi.fn(async () => ok({}, 500)) as unknown as typeof fetch;
    const res = await createCallbackHandler(down)(cb('code=c&state=ESTADO123', withState()));
    expect(res.headers.get('location')).toBe('/admin?error=github');
    expect(cookieNamed(res, SESSION_COOKIE)).toBeUndefined();
  });

  it('admin desligado → 503, sem ir ao GitHub', async () => {
    delete process.env.ADMIN_SESSION_SECRET;
    const fetchFn = githubAs('dono');
    const res = await createCallbackHandler(fetchFn)(cb('code=c&state=ESTADO123', withState()));
    expect(res.status).toBe(503);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('a sessão criada é a que o adminRoute aceita (mesmo segredo e mesmo usuário)', async () => {
    const res = await createCallbackHandler(githubAs('dono', 3))(cb('code=c&state=ESTADO123', withState()));
    const header = `${SESSION_COOKIE}=${valueOf(cookieNamed(res, SESSION_COOKIE))}`;
    expect(verifyAdminSession(readCookie(header, SESSION_COOKIE), config, Date.now()).ok).toBe(true);
  });
});

describe('POST /api/admin/auth/logout', () => {
  const out = (headers: Record<string, string>) =>
    logoutHandler()(new Request('http://app.test/api/admin/auth/logout', { method: 'POST', headers: { host: 'app.test', ...headers } }));

  it('do mesmo site: apaga o cookie da sessão (mesmo sem sessão válida)', async () => {
    const res = await out({ origin: 'http://app.test' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const c = cookieNamed(res, SESSION_COOKIE)!;
    expect(c).toContain('Max-Age=0');
    expect(c).toContain('Path=/');
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('de outra origem ou sem origem: 403 bad_origin e o cookie NÃO é apagado (anti-CSRF)', async () => {
    const cases: Array<Record<string, string>> = [{ origin: 'https://evil.test' }, {}, { origin: 'null' }];
    for (const headers of cases) {
      const res = await out(headers);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: 'bad_origin' });
      expect(cookieNamed(res, SESSION_COOKIE)).toBeUndefined();
    }
  });
});
