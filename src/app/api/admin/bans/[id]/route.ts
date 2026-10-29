import { adminRoute, invalidInput, ok } from '@/server/admin-route';

export const dynamic = 'force-dynamic';

const BAN_ID = /^(ip|device)-[0-9a-f]{20}$/;

export const DELETE = adminRoute<{ id: string }>(async ({ store, params }) => {
  if (!BAN_ID.test(params.id)) return invalidInput();
  return ok({ ok: await store.unban(params.id) });
});
