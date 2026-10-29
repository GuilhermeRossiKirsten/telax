import { normalizeRoom } from '@/lib/validation';
import { adminRoute, invalidInput, ok, optionalReason, readOptionalJsonBody } from '@/server/admin-route';

export const dynamic = 'force-dynamic';

export const POST = adminRoute<{ room: string }>(async ({ req, store, params }) => {
  const room = normalizeRoom(params.room);
  const body = await readOptionalJsonBody(req);
  const reason = body && optionalReason(body);
  if (!room || !body || reason === null) return invalidInput();
  return ok({ removed: await store.closeRoom(room, reason) });
});
