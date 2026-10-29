import type { Metadata } from 'next';
import { AdminApp } from '@/components/admin/AdminApp';
import { loginErrorMessage } from '@/lib/admin-ui';

export const metadata: Metadata = {
  title: 'telaX · Administração',
  // o painel é privado: fora dos buscadores
  robots: { index: false, follow: false },
};

export default async function AdminPage({ searchParams }: { searchParams: Promise<{ error?: string | string[] }> }) {
  const { error } = await searchParams;
  // só mensagens conhecidas chegam à tela: nada vindo da URL é exibido cru
  const loginError = loginErrorMessage(typeof error === 'string' ? error : undefined);
  return <AdminApp loginError={loginError} />;
}
