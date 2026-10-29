import { invalid, isString, json, postRoute } from '@/server/http';
import { parseSignal, parseSignalItems } from '@/server/signal-validation';

export const dynamic = 'force-dynamic';

/**
 * Dois formatos (nunca misturados): um sinal `{ from, token, to, data }` ou um lote `{ from, token, items: [{ to, data }] }`
 * de 1 a 50 itens. O lote é validado inteiro ANTES de aplicar qualquer item (tudo ou nada) e vira uma invocação só,
 * em vez de uma por candidato ICE.
 */
export const POST = postRoute(async (store, room, body) => {
  if ('items' in body) {
    if ('to' in body || 'data' in body) return invalid();
    const items = parseSignalItems(body.items);
    if (!items) return invalid();
    for (const item of items) await store.signal(room, body.from as string, item.to, item.data);
    return json({ ok: true });
  }
  const data = parseSignal(body.data);
  if (!isString(body.to) || !data) return invalid();
  await store.signal(room, body.from as string, body.to, data);
  return json({ ok: true });
}, 'from');
