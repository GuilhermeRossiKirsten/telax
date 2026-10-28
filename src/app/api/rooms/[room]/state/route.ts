import { invalid, isBool, isString, json, postRoute } from '@/server/http';

export const dynamic = 'force-dynamic';

export const POST = postRoute((store, room, body) => {
  if (!isString(body.from) || !isBool(body.audio) || !isBool(body.video) || !isBool(body.sharing)) {
    return invalid();
  }
  store.setState(room, body.from, { audio: body.audio, video: body.video, sharing: body.sharing });
  return json({ ok: true });
});
