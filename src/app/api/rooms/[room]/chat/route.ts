import { normalizeChat } from '@/lib/validation';
import { invalid, json, postRoute } from '@/server/http';

export const dynamic = 'force-dynamic';

export const POST = postRoute(async (store, room, body) => {
  const text = normalizeChat(body.text);
  if (!text) return invalid();
  await store.chat(room, body.from as string, text);
  return json({ ok: true });
}, 'from');
