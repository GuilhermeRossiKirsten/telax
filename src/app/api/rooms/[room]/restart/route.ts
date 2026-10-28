import { invalid, isString, json, postRoute } from '@/server/http';

export const dynamic = 'force-dynamic';

export const POST = postRoute((store, room, body) => {
  if (!isString(body.from)) return invalid();
  return json({ gen: store.restart(room, body.from) });
});
