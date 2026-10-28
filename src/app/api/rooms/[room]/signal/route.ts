import { invalid, isString, json, postRoute } from '@/server/http';
import { parseSignal } from '@/server/signal-validation';

export const dynamic = 'force-dynamic';

export const POST = postRoute((store, room, body) => {
  const data = parseSignal(body.data);
  if (!isString(body.to) || !data) return invalid();
  store.signal(room, body.from as string, body.to, data);
  return json({ ok: true });
}, 'from');
