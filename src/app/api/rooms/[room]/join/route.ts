import { normalizeName } from '@/lib/validation';
import { getIceServers } from '@/server/ice';
import { invalid, json, postRoute } from '@/server/http';

export const dynamic = 'force-dynamic';

export const POST = postRoute((store, room, body) => {
  const name = normalizeName(body.name);
  if (!name) return invalid();
  return json({ ...store.join(room, name), iceServers: getIceServers(process.env) });
});
