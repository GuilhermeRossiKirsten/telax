import { adminRoute, ok } from '@/server/admin-route';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(async ({ store }) => ok({ rooms: await store.listRooms() }));
