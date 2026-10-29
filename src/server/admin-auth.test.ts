import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_COOKIE,
  STATE_COOKIE,
  SESSION_TTL_MS,
  adminConfig,
  buildAuthorizeUrl,
  clearCookie,
  completeGithubLogin,
  isAdminUser,
  newOAuthState,
  readCookie,
  redirectUriFor,
  serializeCookie,
  signAdminSession,
  statesMatch,
  verifyAdminSession,
  type AdminConfig,
} from './admin-auth';

const SECRET = 'segredo-de-teste-com-mais-de-32-caracteres!!';
const env = {
  GITHUB_CLIENT_ID: 'cid',
  GITHUB_CLIENT_SECRET: 'csecret',
  ADMIN_GITHUB_USER: 'Guilherme-Dono',
  ADMIN_SESSION_SECRET: SECRET,
};
const config = adminConfig(env) as AdminConfig;
const NOW = 1_800_000_000_000;
const good = { login: 'guilherme-dono', id: 42, exp: NOW + 60_000 };

describe('adminConfig (falha fechada)', () => {
  it('com tudo definido devolve a configuração (login em minúsculas)', () => {
    expect(config).toMatchObject({ clientId: 'cid', clientSecret: 'csecret', githubUser: 'guilherme-dono', sessionSecret: SECRET });
    expect(config.githubId).toBeUndefined();
  });

  it.each(['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'ADMIN_GITHUB_USER', 'ADMIN_SESSION_SECRET'])(
    'sem %s o admin fica DESLIGADO (null), nunca aberto',
    (key) => {
      expect(adminConfig({ ...env, [key]: undefined })).toBeNull();
      expect(adminConfig({ ...env, [key]: '   ' })).toBeNull();
    },
  );

  it('segredo de sessão com menos de 32 caracteres desliga o admin', () => {
    expect(adminConfig({ ...env, ADMIN_SESSION_SECRET: 'curto' })).toBeNull();
    expect(adminConfig({ ...env, ADMIN_SESSION_SECRET: 'x'.repeat(31) })).toBeNull();
    expect(adminConfig({ ...env, ADMIN_SESSION_SECRET: 'x'.repeat(32) })).not.toBeNull();
  });

  it('ADMIN_GITHUB_ID válido é lido; definido mas inválido também DESLIGA (não vira "qualquer id")', () => {
    expect(adminConfig({ ...env, ADMIN_GITHUB_ID: '12345' })?.githubId).toBe(12345);
    expect(adminConfig({ ...env, ADMIN_GITHUB_ID: 'abc' })).toBeNull();
    expect(adminConfig({ ...env, ADMIN_GITHUB_ID: '-1' })).toBeNull();
    expect(adminConfig({ ...env, ADMIN_GITHUB_ID: '1.5' })).toBeNull();
    expect(adminConfig({ ...env, ADMIN_GITHUB_ID: '' })?.githubId).toBeUndefined(); // vazio = não definido
  });
});

describe('isAdminUser', () => {
  it('compara o login sem diferenciar maiúsculas', () => {
    expect(isAdminUser({ login: 'GUILHERME-dono', id: 1 }, config)).toBe(true);
    expect(isAdminUser({ login: 'outra-pessoa', id: 1 }, config)).toBe(false);
  });
  it('com ADMIN_GITHUB_ID definido o id também precisa bater (o login pode mudar de dono)', () => {
    const withId = adminConfig({ ...env, ADMIN_GITHUB_ID: '42' }) as AdminConfig;
    expect(isAdminUser({ login: 'guilherme-dono', id: 42 }, withId)).toBe(true);
    expect(isAdminUser({ login: 'guilherme-dono', id: 43 }, withId)).toBe(false);
  });
});

describe('sessão assinada', () => {
  it('assina e verifica', () => {
    const v = signAdminSession(good, SECRET);
    expect(verifyAdminSession(v, config, NOW)).toEqual({ ok: true, session: good });
  });

  it('sem cookie: missing', () => {
    expect(verifyAdminSession(undefined, config, NOW)).toEqual({ ok: false, reason: 'missing' });
    expect(verifyAdminSession('', config, NOW)).toEqual({ ok: false, reason: 'missing' });
  });

  it('expirada: expired', () => {
    const v = signAdminSession({ ...good, exp: NOW - 1 }, SECRET);
    expect(verifyAdminSession(v, config, NOW)).toEqual({ ok: false, reason: 'expired' });
  });

  it('assinatura de outro segredo, payload adulterado e lixo: invalid', () => {
    const v = signAdminSession(good, SECRET);
    expect(verifyAdminSession(signAdminSession(good, 'outro-segredo-também-bem-longo-e-diferente'), config, NOW)).toEqual({ ok: false, reason: 'invalid' });
    const [payload, sig] = v.split('.');
    const forged = Buffer.from(JSON.stringify({ ...good, login: 'invasor' })).toString('base64url');
    expect(verifyAdminSession(`${forged}.${sig}`, config, NOW)).toEqual({ ok: false, reason: 'invalid' });
    expect(verifyAdminSession(`${payload}.${sig.slice(0, -2)}AA`, config, NOW)).toEqual({ ok: false, reason: 'invalid' });
    for (const junk of ['x', 'a.b.c', '.', 'a.', '.b', '%%%.%%%', 'x'.repeat(5000), payload]) {
      expect(verifyAdminSession(junk, config, NOW)).toEqual({ ok: false, reason: 'invalid' });
    }
  });

  it('assinatura boa mas payload que não é JSON válido ou sem os campos: invalid', () => {
    const sign = (text: string) => {
      const real = signAdminSession(good, SECRET).split('.')[1];
      return `${Buffer.from(text).toString('base64url')}.${real}`;
    };
    expect(verifyAdminSession(sign('não é json'), config, NOW).ok).toBe(false);
    expect(verifyAdminSession(sign('{"login":1}'), config, NOW).ok).toBe(false);
  });

  it('assinada com o segredo CERTO mas de OUTRO usuário: forbidden (não é admin)', () => {
    const v = signAdminSession({ login: 'invasor', id: 7, exp: NOW + 1000 }, SECRET);
    expect(verifyAdminSession(v, config, NOW)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('o login da sessão é comparado sem diferenciar maiúsculas; com ADMIN_GITHUB_ID o id da sessão precisa bater', () => {
    expect(verifyAdminSession(signAdminSession({ ...good, login: 'GUILHERME-DONO' }, SECRET), config, NOW).ok).toBe(true);
    const withId = adminConfig({ ...env, ADMIN_GITHUB_ID: '42' }) as AdminConfig;
    expect(verifyAdminSession(signAdminSession(good, SECRET), withId, NOW).ok).toBe(true);
    expect(verifyAdminSession(signAdminSession({ ...good, id: 99 }, SECRET), withId, NOW)).toEqual({ ok: false, reason: 'forbidden' });
  });

  it('a sessão dura 12 h', () => {
    expect(SESSION_TTL_MS).toBe(12 * 60 * 60 * 1000);
  });
});

describe('cookies', () => {
  it('readCookie lê pelo nome, sem confundir prefixos', () => {
    const header = `a=1; ${SESSION_COOKIE}=abc.def; ${SESSION_COOKIE}x=zzz; outro=2`;
    expect(readCookie(header, SESSION_COOKIE)).toBe('abc.def');
    expect(readCookie(header, 'nada')).toBeUndefined();
    expect(readCookie(null, SESSION_COOKIE)).toBeUndefined();
  });

  it('serializeCookie: HttpOnly, SameSite=Lax, Path e Max-Age; Secure só em produção', () => {
    const dev = serializeCookie(SESSION_COOKIE, 'v', { maxAgeSeconds: 100, path: '/', secure: false });
    expect(dev).toContain(`${SESSION_COOKIE}=v`);
    expect(dev).toContain('HttpOnly');
    expect(dev).toContain('SameSite=Lax');
    expect(dev).toContain('Path=/');
    expect(dev).toContain('Max-Age=100');
    expect(dev).not.toContain('Secure');
    expect(serializeCookie(SESSION_COOKIE, 'v', { maxAgeSeconds: 100, path: '/', secure: true })).toContain('Secure');
  });

  it('clearCookie expira o cookie na hora', () => {
    const c = clearCookie(SESSION_COOKIE, '/', true);
    expect(c).toContain(`${SESSION_COOKIE}=;`);
    expect(c).toContain('Max-Age=0');
    expect(c).toContain('HttpOnly');
  });
});

describe('fluxo OAuth do GitHub', () => {
  it('buildAuthorizeUrl: client_id, redirect_uri, state, escopo mínimo e sem cadastro novo', () => {
    const url = new URL(buildAuthorizeUrl(config, 'https://app.exemplo/api/admin/auth/callback', 'ESTADO'));
    expect(url.origin + url.pathname).toBe('https://github.com/login/oauth/authorize');
    expect(url.searchParams.get('client_id')).toBe('cid');
    expect(url.searchParams.get('redirect_uri')).toBe('https://app.exemplo/api/admin/auth/callback');
    expect(url.searchParams.get('state')).toBe('ESTADO');
    expect(url.searchParams.get('scope')).toBe('read:user');
    expect(url.searchParams.get('allow_signup')).toBe('false');
    expect(url.toString()).not.toContain('csecret'); // o segredo do app nunca vai na URL
  });

  it('o state é aleatório e a comparação é exata (e de tempo constante)', () => {
    const a = newOAuthState();
    expect(a.length).toBeGreaterThanOrEqual(30);
    expect(newOAuthState()).not.toBe(a);
    expect(statesMatch(a, a)).toBe(true);
    expect(statesMatch(a, a + 'x')).toBe(false);
    expect(statesMatch(a, undefined)).toBe(false);
    expect(statesMatch(undefined, a)).toBe(false);
    expect(statesMatch('', '')).toBe(false);
  });

  it('redirectUriFor: usa ADMIN_BASE_URL quando definida; senão x-forwarded-proto e host', () => {
    const req = new Request('http://localhost:3000/x', { headers: { host: 'app.exemplo', 'x-forwarded-proto': 'https' } });
    expect(redirectUriFor(req, config)).toBe('https://app.exemplo/api/admin/auth/callback');
    const withBase = adminConfig({ ...env, ADMIN_BASE_URL: 'https://meu.dominio/' }) as AdminConfig;
    expect(redirectUriFor(req, withBase)).toBe('https://meu.dominio/api/admin/auth/callback');
    const local = new Request('http://localhost:3000/x', { headers: { host: 'localhost:3000' } });
    expect(redirectUriFor(local, config)).toBe('http://localhost:3000/api/admin/auth/callback');
  });

  const ok = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('troca o code, lê o usuário e devolve só login e id (o token do GitHub não sai da função)', async () => {
    const fetchFn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u === 'https://github.com/login/oauth/access_token') {
        expect(init?.method).toBe('POST');
        expect((init?.headers as Record<string, string>).Accept).toBe('application/json');
        const sent = JSON.parse(String(init?.body));
        expect(sent).toMatchObject({ client_id: 'cid', client_secret: 'csecret', code: 'CODIGO', redirect_uri: 'https://app/cb' });
        return ok({ access_token: 'gho_TOKEN-SECRETO' });
      }
      if (u === 'https://api.github.com/user') {
        expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer gho_TOKEN-SECRETO');
        return ok({ login: 'Guilherme-Dono', id: 42, avatar_url: 'x' });
      }
      throw new Error('url inesperada ' + u);
    });
    const user = await completeGithubLogin('CODIGO', config, 'https://app/cb', fetchFn as unknown as typeof fetch);
    expect(user).toEqual({ login: 'Guilherme-Dono', id: 42 });
    expect(JSON.stringify(user)).not.toContain('gho_');
  });

  it.each([
    ['GitHub recusa o code (error no JSON)', async () => ok({ error: 'bad_verification_code' })],
    ['troca com status 500', async () => ok({}, 500)],
    ['resposta sem access_token', async () => ok({ token_type: 'bearer' })],
  ])('falha na troca do code: %s → null', async (_n, handler) => {
    const fetchFn = vi.fn(handler as () => Promise<Response>);
    expect(await completeGithubLogin('c', config, 'https://app/cb', fetchFn as unknown as typeof fetch)).toBeNull();
  });

  it('falha ao ler /user, usuário malformado ou fetch que lança → null', async () => {
    const make = (user: () => Promise<Response>) =>
      vi.fn(async (url: string | URL | Request) => (String(url).includes('access_token') ? ok({ access_token: 't' }) : user()));
    expect(await completeGithubLogin('c', config, 'u', make(async () => ok({}, 401)) as unknown as typeof fetch)).toBeNull();
    expect(await completeGithubLogin('c', config, 'u', make(async () => ok({ login: 7, id: 'x' })) as unknown as typeof fetch)).toBeNull();
    expect(await completeGithubLogin('c', config, 'u', make(async () => ok({ login: 'a' })) as unknown as typeof fetch)).toBeNull();
    const boom = vi.fn(async () => {
      throw new Error('rede caiu');
    });
    expect(await completeGithubLogin('c', config, 'u', boom as unknown as typeof fetch)).toBeNull();
  });

  it('STATE_COOKIE e SESSION_COOKIE têm nomes distintos e estáveis', () => {
    expect(SESSION_COOKIE).toBe('telax_admin');
    expect(STATE_COOKIE).toBe('telax_oauth_state');
  });
});
