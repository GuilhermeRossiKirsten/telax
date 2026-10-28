import { normalizeRoom } from '@/lib/validation';
import { RoomFullError, UnknownPeerError, type RoomStore } from './room-store';
import { getStore } from './store';

export type RoomContext = { params: Promise<{ room: string }> };
export type Body = Record<string, unknown>;

export const json = (body: unknown, status = 200) => Response.json(body, { status });
export const invalid = () => json({ error: 'invalid' }, 400);

export const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
export const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

async function readBody(req: Request): Promise<Body | null> {
  try {
    const body: unknown = await req.json();
    return body && typeof body === 'object' && !Array.isArray(body) ? (body as Body) : null;
  } catch {
    return null;
  }
}

/** Traduz erros do store para respostas HTTP; qualquer outro erro sobe. */
export function storeErrorResponse(e: unknown): Response {
  if (e instanceof RoomFullError) return json({ error: 'room_full' }, 409);
  if (e instanceof UnknownPeerError) return json({ error: 'gone' }, 410);
  throw e;
}

/** POST com corpo JSON: valida sala e corpo, executa o handler e mapeia erros do store. */
export function postRoute(handler: (store: RoomStore, room: string, body: Body) => Response | Promise<Response>) {
  return async (req: Request, ctx: RoomContext): Promise<Response> => {
    const room = normalizeRoom((await ctx.params).room);
    const body = await readBody(req);
    if (!room || !body) return invalid();
    try {
      return await handler(getStore(), room, body);
    } catch (e) {
      return storeErrorResponse(e);
    }
  };
}
