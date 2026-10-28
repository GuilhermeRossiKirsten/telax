import { normalizeChat } from '@/lib/validation';
import { invalid, isString, json, postRoute } from '@/server/http';

export const dynamic = 'force-dynamic';

export const POST = postRoute((store, room, body) => {
  const text = normalizeChat(body.text);
  if (!isString(body.from) || !text) return invalid();
  store.chat(room, body.from, text);
  return json({ ok: true });
});
