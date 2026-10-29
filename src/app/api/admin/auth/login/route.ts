import { loginHandler } from '@/server/admin-auth-handlers';

export const dynamic = 'force-dynamic';

// Exceção declarada ao adminRoute: cria a sessão (ver admin-guard.test.ts).
export const GET = loginHandler();
