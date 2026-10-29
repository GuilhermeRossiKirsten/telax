import { isIP } from 'node:net';
import { normalizeRoom } from '@/lib/validation';
import { adminRoute, invalidInput, isUuid, notFound, ok, optionalReason, readJsonBody } from '@/server/admin-route';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async ({ store }) => ok({ bans: await store.listBans() }));

/**
 * Dois formatos, nunca misturados:
 *  - { room, peerId, reason? }: bane o IP e o dispositivo de quem está conectado (e o expulsa);
 *  - { ip?, deviceId?, reason? }: bane valores informados (ao menos um). O MAC não existe para a web.
 */
export const POST = adminRoute(async ({ req, store }) => {
  const body = await readJsonBody(req);
  if (!body) return invalidInput();
  const reason = optionalReason(body);
  if (reason === null) return invalidInput();

  const byPeer = body.room !== undefined || body.peerId !== undefined;
  const byValue = body.ip !== undefined || body.deviceId !== undefined;
  if (byPeer === byValue) return invalidInput(); // nenhum dos dois, ou os dois misturados

  if (byPeer) {
    const room = normalizeRoom(body.room);
    if (!room || !isUuid(body.peerId)) return invalidInput();
    const result = await store.banPeer(room, body.peerId, reason);
    return result ? ok(result) : notFound();
  }

  const ip = body.ip === undefined ? undefined : typeof body.ip === 'string' && isIP(body.ip.trim()) ? body.ip.trim().toLowerCase() : null;
  const deviceId = body.deviceId === undefined ? undefined : isUuid(body.deviceId) ? body.deviceId : null;
  if (ip === null || deviceId === null) return invalidInput();
  return ok(await store.ban({ ip, deviceId, reason }));
});
