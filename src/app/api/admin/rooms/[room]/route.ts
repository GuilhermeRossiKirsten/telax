import { normalizeRoom } from '@/lib/validation';
import { adminRoute, invalidInput, notFound, ok } from '@/server/admin-route';

export const dynamic = 'force-dynamic';

export const GET = adminRoute<{ room: string }>(async ({ store, params }) => {
  const room = normalizeRoom(params.room);
  if (!room) return invalidInput();
  const detail = await store.getRoom(room);
  return detail ? ok(detail) : notFound();
});
