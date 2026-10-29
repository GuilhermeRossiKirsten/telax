import { ADMIN_MESSAGE_MAX } from '@/lib/admin-types';
import { adminRoute, invalidInput, ok, readJsonBody, textField } from '@/server/admin-route';

export const dynamic = 'force-dynamic';

/** Mensagem a TODAS as salas. */
export const POST = adminRoute(async ({ req, store }) => {
  const body = await readJsonBody(req);
  const text = body && textField(body, 'text', ADMIN_MESSAGE_MAX);
  if (!text) return invalidInput();
  return ok({ delivered: await store.broadcast(null, text) });
});
