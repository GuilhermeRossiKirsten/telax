import type { JoinContext } from '@/lib/admin-types';
import { normalizeName } from '@/lib/validation';
import { adminConfig, readCookie, SESSION_COOKIE, verifyAdminSession } from '@/server/admin-auth';
import { clientIp } from '@/server/client-ip';
import { invalid, json, postRoute, tooManyAttempts } from '@/server/http';
import { getIceServers } from '@/server/ice';
import { PASSWORD_MAX, verifyPassword } from '@/server/room-password';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** O pedido traz uma sessão de admin válida? (só isso autoriza a entrar como observador) */
function isAdminRequest(req: Request): boolean {
  const config = adminConfig(process.env);
  return !!config && verifyAdminSession(readCookie(req.headers.get('cookie'), SESSION_COOKIE), config, Date.now()).ok;
}

/**
 * Entrada na sala. O contexto (IP, observador) é decidido AQUI, pelo servidor:
 *  - o IP vem dos cabeçalhos do proxy, nunca do corpo;
 *  - o `deviceId` do corpo só vale se for um UUID;
 *  - `observer: true` (o admin vendo a sala) exige sessão de admin válida; sem ela é 403 e ninguém entra;
 *  - sala com senha: quem não é observador precisa mandar `password` (403 `password_required` / `wrong_password`),
 *    com limite de tentativas por (sala, IP) e por sala (429 `too_many_attempts`). A senha nunca é registrada nem devolvida.
 */
export const POST = postRoute(async (store, room, body, req) => {
  const name = normalizeName(body.name);
  if (!name) return invalid();
  if (body.observer !== undefined && typeof body.observer !== 'boolean') return invalid();
  const observer = body.observer === true;
  if (observer && !isAdminRequest(req)) return json({ error: 'forbidden' }, 403);

  const password = body.password;
  if (password !== undefined && typeof password !== 'string') return invalid();

  const ctx: JoinContext = {
    ip: clientIp(req.headers),
    deviceId: typeof body.deviceId === 'string' && UUID.test(body.deviceId) ? body.deviceId : undefined,
    observer,
  };

  const record = await store.getRoomPassword(room);
  // sala fechada pelo admin: quem tenta entrar vê "encerrada" (o store recusa), não um pedido de senha
  if (record && !observer && !(await store.roomPreview(room)).closed) {
    const key = ctx.ip ?? 'unknown';
    const gate = await store.passwordThrottle(room, key);
    if (gate.locked) return tooManyAttempts(gate.retryAfterMs);
    if (!password) return json({ error: 'password_required' }, 403);
    // texto enorme nem chega ao scrypt: é senha errada
    if (password.length > PASSWORD_MAX || !(await verifyPassword(password, record))) {
      await store.passwordFailed(room, key);
      return json({ error: 'wrong_password' }, 403);
    }
    await store.passwordSucceeded(room, key);
  }
  return json({ ...(await store.join(room, name, ctx)), protected: record !== null, iceServers: getIceServers(process.env) });
});
