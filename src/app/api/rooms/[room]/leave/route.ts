import { json, postRoute } from '@/server/http';

export const dynamic = 'force-dynamic';

export const POST = postRoute(async (store, room, body) => {
  await store.leave(room, body.peerId as string);
  return json({ ok: true });
}, 'peerId');
