import { parseMediaState } from '@/lib/validation';
import { invalid, json, postRoute } from '@/server/http';

export const dynamic = 'force-dynamic';

export const POST = postRoute(async (store, room, body) => {
  const media = parseMediaState(body);
  if (!media) return invalid();
  await store.setState(room, body.from as string, media);
  return json({ ok: true });
}, 'from');
