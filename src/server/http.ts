import { normalizeRoom } from '@/lib/validation';
import { ADMIN_REASON_MAX } from '@/lib/admin-types';
import { BannedError, RoomClosedError, RoomFullError, UnknownPeerError, type RoomStore } from './room-store';
import { getStore } from './store';

export type RoomContext = { params: Promise<{ room: string }> };
export type Body = Record<string, unknown>;

export const json = (body: unknown, status = 200) => Response.json(body, { status });
export const invalid = () => json({ error: 'invalid' }, 400);

/** Trancado por erros de senha: `retryAfter` em segundos, no corpo e no cabeçalho `Retry-After`. */
export function tooManyAttempts(retryAfterMs: number): Response {
  const retryAfter = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return new Response(JSON.stringify({ error: 'too_many_attempts', retryAfter }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': String(retryAfter) },
  });
}

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
  // banido: sem revelar o detalhe (IP/dispositivo) a quem tenta entrar
  if (e instanceof BannedError) return json({ error: 'banned' }, 403);
  if (e instanceof RoomClosedError) return json(e.reason ? { error: 'room_closed', reason: e.reason } : { error: 'room_closed' }, 403);
  // removido pelo admin há pouco: o motivo deixa o cliente mostrar o aviso certo e não reentrar
  if (e instanceof UnknownPeerError) {
    if (!e.reason) return json({ error: 'gone' }, 410);
    // o texto livre do admin só acompanha um motivo (quem foi removido por ele); nunca passa do limite
    const detail = typeof e.detail === 'string' && e.detail ? e.detail.slice(0, ADMIN_REASON_MAX) : undefined;
    return json(detail ? { error: 'gone', reason: e.reason, detail } : { error: 'gone', reason: e.reason }, 410);
  }
  throw e;
}

/**
 * POST com corpo JSON: valida sala e corpo, executa o handler e mapeia erros do store.
 * Com `idField`, exige `token` e autentica o peer (body[idField]) antes de tudo; token errado
 * e peer inexistente dão o mesmo 410 para não revelar qual falhou.
 */
export function postRoute(
  handler: (store: RoomStore, room: string, body: Body, req: Request) => Response | Promise<Response>,
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
      return await handler(store, room, body, req);
    } catch (e) {
      return storeErrorResponse(e);
    }
  };
}
