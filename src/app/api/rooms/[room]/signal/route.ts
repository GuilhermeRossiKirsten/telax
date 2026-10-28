import type { SignalData } from '@/lib/types';
import { invalid, isString, json, postRoute } from '@/server/http';

export const dynamic = 'force-dynamic';

const KINDS = ['offer', 'answer', 'candidate', 'reset'];

export const POST = postRoute((store, room, body) => {
  const data = body.data as Partial<SignalData> | null;
  if (
    !isString(body.from) ||
    !isString(body.to) ||
    !data ||
    typeof data !== 'object' ||
    typeof data.gen !== 'number' ||
    !KINDS.includes(data.kind as string)
  ) {
    return invalid();
  }
  store.signal(room, body.from, body.to, data as SignalData);
  return json({ ok: true });
});
