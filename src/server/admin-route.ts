import { adminConfig, readCookie, SESSION_COOKIE, verifyAdminSession, type AdminSession } from './admin-auth';
import type { RoomStore } from './room-store';
import { getStore } from './store';

/**
 * ÚNICO jeito de criar handlers em `src/app/api/admin/**` (as 3 rotas que CRIAM a sessão são a exceção explícita).
 * Negar por padrão: nada do handler roda sem passar, em ordem, por
 *   1. admin desligado (variável faltando)  → 503
 *   2. sem sessão / inválida / expirada      → 401
 *   3. sessão de outro usuário               → 403
 *   4. método mutante de outra origem        → 403 (CSRF)
 * O teste `admin-guard.test.ts` varre as rotas e quebra se alguma escapar disto.
 */

export type AdminContext<P extends Record<string, string> = Record<string, string>> = {
  req: Request;
  params: P;
  admin: AdminSession;
  store: RoomStore;
};

export type AdminHandler<P extends Record<string, string>> = (c: AdminContext<P>) => Response | Promise<Response>;

const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const MAX_ADMIN_BODY = 16 * 1024;

const reply = (body: unknown, status: number) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });

/** Host que o navegador usou (atrás de proxy: x-forwarded-host). */
function requestHost(req: Request): string {
  return req.headers.get('x-forwarded-host')?.split(',')[0].trim() || req.headers.get('host') || new URL(req.url).host;
}

/** `Origin` (ou, sem ele, `Referer`) precisa ser do mesmo host; ausente ou `null` não vale. */
export function sameOrigin(req: Request): boolean {
  const host = requestHost(req);
  const source = req.headers.get('origin') ?? req.headers.get('referer');
  if (!source) return false;
  try {
    return new URL(source).host === host;
  } catch {
    return false; // inclui o "null" de origens opacas
  }
}

export function adminRoute<P extends Record<string, string> = Record<string, string>>(handler: AdminHandler<P>) {
  return async (req: Request, ctx: { params: Promise<P> }): Promise<Response> => {
    const config = adminConfig(process.env);
    if (!config) return reply({ error: 'admin_disabled' }, 503);

    const check = verifyAdminSession(readCookie(req.headers.get('cookie'), SESSION_COOKIE), config, Date.now());
    if (!check.ok) return check.reason === 'forbidden' ? reply({ error: 'forbidden' }, 403) : reply({ error: 'unauthorized' }, 401);

    if (MUTATING.has(req.method.toUpperCase()) && !sameOrigin(req)) return reply({ error: 'bad_origin' }, 403);

    try {
      const res = await handler({ req, params: await ctx.params, admin: check.session, store: getStore() });
      const out = new Response(res.body, res);
      out.headers.set('cache-control', 'no-store');
      return out;
    } catch {
      // nunca devolve mensagem nem pilha: pode conter segredo (URI do banco, caminhos)
      return reply({ error: 'internal' }, 500);
    }
  };
}

// ---------------------------------------------------------------- validação de entrada

export const invalidInput = () => reply({ error: 'invalid' }, 400);
export const notFound = () => reply({ error: 'not_found' }, 404);
export const ok = (body: unknown = { ok: true }) => reply(body, 200);

/** Corpo JSON (objeto) de até 16 KB; qualquer outra coisa → null. */
export async function readJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const text = await req.text();
    if (text.length > MAX_ADMIN_BODY) return null;
    const body: unknown = JSON.parse(text);
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** Como readJsonBody, mas corpo VAZIO vale como `{}` (rotas cujos campos são todos opcionais). */
export async function readOptionalJsonBody(req: Request): Promise<Record<string, unknown> | null> {
  const text = await req.clone().text().catch(() => null);
  if (text === null) return null;
  return text.trim() === '' ? {} : readJsonBody(req);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (v: unknown): v is string => typeof v === 'string' && UUID.test(v);

/** Texto obrigatório de 1 até `max` caracteres (sem espaços nas pontas); senão null. */
export function textField(body: Record<string, unknown>, key: string, max: number): string | null {
  const v = body[key];
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length >= 1 && t.length <= max ? t : null;
}

export const MAX_REASON = 200;

/** Motivo opcional: ausente ou vazio → `undefined`; texto válido → o texto; presente e inválido → `null`. */
export function optionalReason(body: Record<string, unknown>): string | undefined | null {
  const v = body.reason;
  if (v === undefined) return undefined;
  if (typeof v !== 'string') return null;
  const t = v.trim();
  if (t.length === 0) return undefined;
  return t.length <= MAX_REASON ? t : null;
}
