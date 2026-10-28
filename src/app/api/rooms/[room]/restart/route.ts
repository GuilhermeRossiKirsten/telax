import { json, postRoute } from '@/server/http';

export const dynamic = 'force-dynamic';

export const POST = postRoute((store, room, body) => json({ gen: store.restart(room, body.from as string) }), 'from');
