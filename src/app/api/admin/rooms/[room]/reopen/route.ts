import { normalizeRoom } from '@/lib/validation';
import { adminRoute, invalidInput, ok, readOptionalJsonBody } from '@/server/admin-route';

export const dynamic = 'force-dynamic';

export const POST = adminRoute<{ room: string }>(async ({ req, store, params }) => {
  const room = normalizeRoom(params.room);
  if (!room || !(await readOptionalJsonBody(req))) return invalidInput();
  return ok({ ok: await store.reopenRoom(room) });
});
