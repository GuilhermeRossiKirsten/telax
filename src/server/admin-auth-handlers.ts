import {
  SESSION_COOKIE,
  SESSION_TTL_MS,
  STATE_COOKIE,
  STATE_TTL_SECONDS,
  adminConfig,
  buildAuthorizeUrl,
  clearCookie,
  completeGithubLogin,
  isAdminUser,
  isProduction,
  newOAuthState,
  readCookie,
  redirectUriFor,
  serializeCookie,
  signAdminSession,
  statesMatch,
} from './admin-auth';
import { sameOrigin } from './admin-route';

/**
 * As 3 rotas que CRIAM ou ENCERRAM a sessão. São a única exceção declarada ao `adminRoute` (não dá para exigir uma
 * sessão para criá-la). Vivem aqui, e não nos `route.ts`, para o `fetch` do GitHub poder ser injetado nos testes
 * (um `route.ts` só pode exportar os métodos HTTP).
 */

const STATE_PATH = '/api/admin/auth';

const jsonReply = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** 302 com vários Set-Cookie (Response.redirect devolve cabeçalhos imutáveis). */
function redirect(location: string, cookies: string[]): Response {
  const headers = new Headers({ location, 'cache-control': 'no-store' });
  for (const c of cookies) headers.append('set-cookie', c);
  return new Response(null, { status: 302, headers });
}

export function loginHandler() {
  return async (req: Request): Promise<Response> => {
    const config = adminConfig(process.env);
    if (!config) return jsonReply({ error: 'admin_disabled' }, 503);
    const state = newOAuthState();
    const stateCookie = serializeCookie(STATE_COOKIE, state, { maxAgeSeconds: STATE_TTL_SECONDS, path: STATE_PATH, secure: isProduction() });
    return redirect(buildAuthorizeUrl(config, redirectUriFor(req, config), state), [stateCookie]);
  };
}

export function createCallbackHandler(fetchFn: typeof fetch = fetch) {
  return async (req: Request): Promise<Response> => {
    const config = adminConfig(process.env);
    if (!config) return jsonReply({ error: 'admin_disabled' }, 503);

    // o state é de uso único: apagado em QUALQUER desfecho
    const clearState = clearCookie(STATE_COOKIE, STATE_PATH, isProduction());
    const fail = (error: 'state' | 'github' | 'forbidden') => redirect(`/admin?error=${error}`, [clearState]);

    const url = new URL(req.url);
    if (!statesMatch(url.searchParams.get('state') ?? undefined, readCookie(req.headers.get('cookie'), STATE_COOKIE))) return fail('state');
    const code = url.searchParams.get('code');
    if (!code) return fail('github');

    const user = await completeGithubLogin(code, config, redirectUriFor(req, config), fetchFn);
    if (!user) return fail('github');
    if (!isAdminUser(user, config)) return fail('forbidden');

    const value = signAdminSession({ login: user.login, id: user.id, exp: Date.now() + SESSION_TTL_MS }, config.sessionSecret);
    const session = serializeCookie(SESSION_COOKIE, value, { maxAgeSeconds: SESSION_TTL_MS / 1000, path: '/', secure: isProduction() });
    return redirect('/admin', [session, clearState]);
  };
}

export function logoutHandler() {
  return async (req: Request): Promise<Response> => {
    if (!sameOrigin(req)) return jsonReply({ error: 'bad_origin' }, 403);
    const res = jsonReply({ ok: true }, 200);
    res.headers.append('set-cookie', clearCookie(SESSION_COOKIE, '/', isProduction()));
    return res;
  };
}
