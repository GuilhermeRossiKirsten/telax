import { adminRoute, ok } from '@/server/admin-route';

export const dynamic = 'force-dynamic';

export const GET = adminRoute(({ admin }) => ok({ login: admin.login, id: admin.id }));
