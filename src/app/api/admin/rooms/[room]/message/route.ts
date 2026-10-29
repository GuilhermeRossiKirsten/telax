import { ADMIN_MESSAGE_MAX } from '@/lib/admin-types';
import { normalizeRoom } from '@/lib/validation';
import { adminRoute, invalidInput, ok, readJsonBody, textField } from '@/server/admin-route';

export const dynamic = 'force-dynamic';

export const POST = adminRoute<{ room: string }>(async ({ req, store, params }) => {
  const room = normalizeRoom(params.room);
  const body = await readJsonBody(req);
  const text = body && textField(body, 'text', ADMIN_MESSAGE_MAX);
  if (!room || !text) return invalidInput();
  return ok({ delivered: await store.broadcast(room, text) });
});
