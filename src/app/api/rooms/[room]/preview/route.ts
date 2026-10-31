import { normalizeRoom } from '@/lib/validation';
import { invalid, type RoomContext } from '@/server/http';
import { getStore } from '@/server/store';

export const dynamic = 'force-dynamic';

/**
 * Preview PÚBLICO de propósito (a tela inicial o usa antes de qualquer login): só `count`, `closed` e `protected`. Não autentica,
 * não escreve e nunca devolve nomes, ids, ips nem tokens, só os dois campos escolhidos aqui.
 */
export async function GET(_req: Request, ctx: RoomContext): Promise<Response> {
  const room = normalizeRoom((await ctx.params).room);
  if (!room) return invalid();
  const { count, closed, protected: isProtected } = await getStore().roomPreview(room);
  return new Response(JSON.stringify({ count, closed, protected: isProtected === true }), {
    status: 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  });
}
