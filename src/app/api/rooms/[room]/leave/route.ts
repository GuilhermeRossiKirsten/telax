import { invalid, isString, json, postRoute } from '@/server/http';

export const dynamic = 'force-dynamic';

export const POST = postRoute((store, room, body) => {
  if (!isString(body.peerId)) return invalid();
  store.leave(room, body.peerId);
  return json({ ok: true });
});
