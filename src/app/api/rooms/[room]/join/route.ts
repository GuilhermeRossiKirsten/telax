import type { JoinContext } from '@/lib/admin-types';
import { normalizeName } from '@/lib/validation';
import { adminConfig, readCookie, SESSION_COOKIE, verifyAdminSession } from '@/server/admin-auth';
import { clientIp } from '@/server/client-ip';
import { invalid, json, postRoute } from '@/server/http';
import { getIceServers } from '@/server/ice';

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
 *  - `observer: true` (o admin vendo a sala) exige sessão de admin válida; sem ela é 403 e ninguém entra.
 */
export const POST = postRoute(async (store, room, body, req) => {
  const name = normalizeName(body.name);
  if (!name) return invalid();
  if (body.observer !== undefined && typeof body.observer !== 'boolean') return invalid();
  const observer = body.observer === true;
  if (observer && !isAdminRequest(req)) return json({ error: 'forbidden' }, 403);

  const ctx: JoinContext = {
    ip: clientIp(req.headers),
    deviceId: typeof body.deviceId === 'string' && UUID.test(body.deviceId) ? body.deviceId : undefined,
    observer,
  };
  return json({ ...(await store.join(room, name, ctx)), iceServers: getIceServers(process.env) });
});
