import { normalizeRoom } from '@/lib/validation';
import { adminRoute, invalidInput, isUuid, ok, optionalReason, readJsonBody } from '@/server/admin-route';

export const dynamic = 'force-dynamic';

export const POST = adminRoute<{ room: string }>(async ({ req, store, params }) => {
  const room = normalizeRoom(params.room);
  const body = await readJsonBody(req);
  const reason = body && optionalReason(body);
  if (!room || !body || !isUuid(body.peerId) || reason === null) return invalidInput();
  return ok({ ok: await store.kick(room, body.peerId, reason) });
});
