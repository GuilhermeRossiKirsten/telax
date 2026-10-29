import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Autenticação do administrador: login pelo GitHub (OAuth) e sessão em cookie assinado.
 * Regra de ouro: FALHA FECHADA. Sem a configuração completa o admin fica desligado; nunca aberto.
 * O token do GitHub só é usado para ler o usuário e é descartado (nunca guardado nem devolvido).
 */

export const SESSION_COOKIE = 'telax_admin';
export const STATE_COOKIE = 'telax_oauth_state';
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
export const STATE_TTL_SECONDS = 10 * 60;
export const MIN_SECRET_LENGTH = 32;

export type AdminConfig = {
  clientId: string;
  clientSecret: string;
  /** login do GitHub do admin, em minúsculas */
  githubUser: string;
  /** opcional: id numérico; se definido, também precisa bater (o login pode mudar de dono) */
  githubId?: number;
  sessionSecret: string;
  baseUrl?: string;
};

type Env = Record<string, string | undefined>;

const clean = (v: string | undefined) => v?.trim() || undefined;

/** `null` = admin DESLIGADO (qualquer variável obrigatória faltando ou inválida). */
export function adminConfig(env: Env): AdminConfig | null {
  const clientId = clean(env.GITHUB_CLIENT_ID);
  const clientSecret = clean(env.GITHUB_CLIENT_SECRET);
  const user = clean(env.ADMIN_GITHUB_USER);
  const sessionSecret = clean(env.ADMIN_SESSION_SECRET);
  if (!clientId || !clientSecret || !user || !sessionSecret || sessionSecret.length < MIN_SECRET_LENGTH) return null;

  let githubId: number | undefined;
  const rawId = clean(env.ADMIN_GITHUB_ID);
  if (rawId !== undefined) {
    // definido mas inválido NÃO pode virar "qualquer id": desliga o admin
    if (!/^\d+$/.test(rawId) || !Number.isSafeInteger(Number(rawId)) || Number(rawId) <= 0) return null;
    githubId = Number(rawId);
  }
  return {
    clientId,
    clientSecret,
    githubUser: user.toLowerCase(),
    githubId,
    sessionSecret,
    baseUrl: clean(env.ADMIN_BASE_URL)?.replace(/\/+$/, ''),
  };
}

export type GithubUser = { login: string; id: number };

/** O usuário do GitHub é o admin? Login sem diferenciar maiúsculas; com `githubId` definido o id também precisa bater. */
export function isAdminUser(user: GithubUser, config: AdminConfig): boolean {
  if (user.login.toLowerCase() !== config.githubUser) return false;
  return config.githubId === undefined || user.id === config.githubId;
}

// ---------------------------------------------------------------- sessão

export type AdminSession = { login: string; id: number; exp: number };

export type SessionCheck =
  | { ok: true; session: AdminSession }
  | { ok: false; reason: 'missing' | 'invalid' | 'expired' | 'forbidden' };

const mac = (payload: string, secret: string) => createHmac('sha256', secret).update(payload).digest('base64url');

/** `base64url(JSON).base64url(HMAC-SHA256)` */
export function signAdminSession(session: AdminSession, secret: string): string {
  const payload = Buffer.from(JSON.stringify(session)).toString('base64url');
  return `${payload}.${mac(payload, secret)}`;
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

/**
 * Confere a assinatura, o formato, a expiração e SE O DONO DA SESSÃO AINDA É O ADMIN configurado.
 * `forbidden` = assinatura válida mas de outro usuário (ex.: a config mudou); o chamador responde 403.
 */
export function verifyAdminSession(value: string | undefined | null, config: AdminConfig, now: number): SessionCheck {
  if (!value) return { ok: false, reason: 'missing' };
  if (value.length > 2000) return { ok: false, reason: 'invalid' };
  const parts = value.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) return { ok: false, reason: 'invalid' };
  const [payload, signature] = parts;
  if (!safeEqual(mac(payload, config.sessionSecret), signature)) return { ok: false, reason: 'invalid' };

  let data: unknown;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  const s = data as Partial<AdminSession> | null;
  if (!s || typeof s.login !== 'string' || typeof s.id !== 'number' || typeof s.exp !== 'number') {
    return { ok: false, reason: 'invalid' };
  }
  if (s.exp <= now) return { ok: false, reason: 'expired' };
  if (!isAdminUser({ login: s.login, id: s.id }, config)) return { ok: false, reason: 'forbidden' };
  return { ok: true, session: { login: s.login, id: s.id, exp: s.exp } };
}

// ---------------------------------------------------------------- cookies

export function readCookie(header: string | null | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    if (part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return undefined;
}

type CookieOpts = { maxAgeSeconds: number; path: string; secure: boolean };

/** HttpOnly e SameSite=Lax sempre; Secure só em produção (em http://localhost o navegador descartaria o cookie). */
export function serializeCookie(name: string, value: string, o: CookieOpts): string {
  return [`${name}=${value}`, `Path=${o.path}`, `Max-Age=${o.maxAgeSeconds}`, 'HttpOnly', 'SameSite=Lax', ...(o.secure ? ['Secure'] : [])].join('; ');
}

export function clearCookie(name: string, path: string, secure: boolean): string {
  return serializeCookie(name, '', { maxAgeSeconds: 0, path, secure });
}

export const isProduction = () => process.env.NODE_ENV === 'production';

// ---------------------------------------------------------------- OAuth do GitHub

export const newOAuthState = () => randomBytes(24).toString('base64url');

/** Compara o `state` da URL com o do cookie em tempo constante; vazio ou ausente nunca casa. */
export function statesMatch(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return safeEqual(a, b);
}

export function buildAuthorizeUrl(config: AdminConfig, redirectUri: string, state: string): string {
  const url = new URL('https://github.com/login/oauth/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', 'read:user');
  url.searchParams.set('allow_signup', 'false');
  return url.toString();
}

const CALLBACK_PATH = '/api/admin/auth/callback';

/** URL de retorno do OAuth: `ADMIN_BASE_URL` se definida; senão a origem vista pelo proxy. */
export function redirectUriFor(req: Request, config: AdminConfig): string {
  if (config.baseUrl) return `${config.baseUrl}${CALLBACK_PATH}`;
  const host = req.headers.get('x-forwarded-host') ?? req.headers.get('host') ?? new URL(req.url).host;
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0].trim() || new URL(req.url).protocol.replace(':', '');
  return `${proto}://${host}${CALLBACK_PATH}`;
}

/**
 * Troca o `code` por um token, lê o usuário e DEVOLVE SÓ login e id. O token do GitHub fica aqui dentro e some.
 * Qualquer falha (rede, status, formato) → `null`. `fetchFn` é injetável para testar sem rede.
 */
export async function completeGithubLogin(
  code: string,
  config: AdminConfig,
  redirectUri: string,
  fetchFn: typeof fetch = fetch,
): Promise<GithubUser | null> {
  try {
    const tokenRes = await fetchFn('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ client_id: config.clientId, client_secret: config.clientSecret, code, redirect_uri: redirectUri }),
    });
    if (!tokenRes.ok) return null;
    const token = ((await tokenRes.json()) as { access_token?: unknown }).access_token;
    if (typeof token !== 'string' || !token) return null;

    const userRes = await fetchFn('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'User-Agent': 'telax-admin' },
    });
    if (!userRes.ok) return null;
    const user = (await userRes.json()) as { login?: unknown; id?: unknown };
    if (typeof user.login !== 'string' || !user.login || typeof user.id !== 'number') return null;
    return { login: user.login, id: user.id };
  } catch {
    return null;
  }
}
