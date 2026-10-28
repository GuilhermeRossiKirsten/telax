import { normalizeRoom } from '@/lib/validation';
import { invalid, json, storeErrorResponse, type RoomContext } from '@/server/http';
import { getStore } from '@/server/store';

export const dynamic = 'force-dynamic';

export async function GET(req: Request, ctx: RoomContext): Promise<Response> {
  const room = normalizeRoom((await ctx.params).room);
  const url = new URL(req.url);
  const peerId = url.searchParams.get('peerId');
  const since = Number(url.searchParams.get('since') ?? 0);
  if (!room || !peerId) return invalid();
  try {
    return json(getStore().events(room, peerId, Number.isFinite(since) && since > 0 ? since : 0));
  } catch (e) {
    return storeErrorResponse(e);
  }
}
