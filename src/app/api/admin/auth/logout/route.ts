import { logoutHandler } from '@/server/admin-auth-handlers';

export const dynamic = 'force-dynamic';

// Exceção declarada ao adminRoute: encerra a sessão, com checagem de origem (ver admin-guard.test.ts).
export const POST = logoutHandler();
