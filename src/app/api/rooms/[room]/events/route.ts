import { normalizeRoom } from '@/lib/validation';
import { invalid, json, parseWait, storeErrorResponse, type RoomContext } from '@/server/http';
import { getStore } from '@/server/store';

export const dynamic = 'force-dynamic';
/** A espera longa (até 8 s) cabe com folga; sem isto, planos com limite curto de duração cortariam a requisição. */
export const maxDuration = 15;

/** De quanto em quanto tempo a espera olha o banco (só leitura). */
const STEP_MS = 700;

/** Dorme `ms`, ou menos se o cliente abortar a requisição. */
const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });

/**
 * Eventos novos desde `since`. Com `wait` (ms, até 8000) e nada de novo, a requisição FICA ABERTA e responde assim que
 * chegar algo (ou no prazo): o cliente deixa de bater de segundo em segundo, e cada ida e volta vira uma invocação
 * só por até 8 s. O batimento (`lastSeen`) é renovado uma vez por requisição; as olhadas durante a espera são só leitura.
 */
export async function GET(req: Request, ctx: RoomContext): Promise<Response> {
  const room = normalizeRoom((await ctx.params).room);
  const url = new URL(req.url);
  const peerId = url.searchParams.get('peerId');
  const token = url.searchParams.get('token');
  const since = Number(url.searchParams.get('since') ?? 0);
  const wait = parseWait(url.searchParams.get('wait'));
  if (!room || !peerId || !token) return invalid();
  const from = Number.isFinite(since) && since > 0 ? since : 0;
  try {
    const store = getStore();
    await store.authenticate(room, peerId, token);
    let result = await store.events(room, peerId, from);
    if (wait > 0 && result.events.length === 0) {
      const deadline = Date.now() + wait;
      while (!req.signal.aborted) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        await sleep(Math.min(STEP_MS, left), req.signal);
        if (req.signal.aborted) break;
        result = await store.peekEvents(room, peerId, from);
        if (result.events.length > 0) break;
      }
    }
    return json(result);
  } catch (e) {
    return storeErrorResponse(e);
  }
}
