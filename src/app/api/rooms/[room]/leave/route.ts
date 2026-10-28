import { json, postRoute } from '@/server/http';

export const dynamic = 'force-dynamic';

export const POST = postRoute((store, room, body) => {
  store.leave(room, body.peerId as string);
  return json({ ok: true });
}, 'peerId');
