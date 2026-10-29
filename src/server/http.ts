import { normalizeRoom } from '@/lib/validation';
import { RoomFullError, UnknownPeerError, type RoomStore } from './room-store';
import { getStore } from './store';

export type RoomContext = { params: Promise<{ room: string }> };
export type Body = Record<string, unknown>;

export const json = (body: unknown, status = 200) => Response.json(body, { status });
export const invalid = () => json({ error: 'invalid' }, 400);

export const isString = (v: unknown): v is string => typeof v === 'string' && v.length > 0;
export const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

export const MAX_BODY = 128 * 1024;

/** Espera máxima (ms) de uma consulta de eventos: metade do TTL de 15 s do peer, para o batimento nunca atrasar. */
export const MAX_WAIT_MS = 8000;

/** `wait` da consulta de eventos: inteiro de 0 a MAX_WAIT_MS; ausente ou inválido = 0 (resposta imediata). */
export function parseWait(raw: string | null | undefined): number {
  if (!raw || !/^\d+$/.test(raw)) return 0;
  return Math.min(Number(raw), MAX_WAIT_MS);
}

async function readBody(req: Request): Promise<Body | null> {
  try {
    const text = await req.text();
    if (text.length > MAX_BODY) return null;
    const body: unknown = JSON.parse(text);
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

/**
 * POST com corpo JSON: valida sala e corpo, executa o handler e mapeia erros do store.
 * Com `idField`, exige `token` e autentica o peer (body[idField]) antes de tudo; token errado
 * e peer inexistente dão o mesmo 410 para não revelar qual falhou.
 */
export function postRoute(
  handler: (store: RoomStore, room: string, body: Body) => Response | Promise<Response>,
  idField?: 'from' | 'peerId',
) {
  return async (req: Request, ctx: RoomContext): Promise<Response> => {
    const room = normalizeRoom((await ctx.params).room);
    const body = await readBody(req);
    if (!room || !body) return invalid();
    if (idField && (!isString(body[idField]) || !isString(body.token))) return invalid();
    try {
      const store = getStore();
      if (idField) await store.authenticate(room, body[idField] as string, body.token as string);
      return await handler(store, room, body);
    } catch (e) {
      return storeErrorResponse(e);
    }
  };
}
