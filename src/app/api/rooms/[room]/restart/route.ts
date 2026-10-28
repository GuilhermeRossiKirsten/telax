import { json, postRoute } from '@/server/http';

export const dynamic = 'force-dynamic';

export const POST = postRoute(
  async (store, room, body) => json({ gen: await store.restart(room, body.from as string) }),
  'from',
);
