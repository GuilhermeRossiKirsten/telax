'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AdminApiError, createAdminClient, type AdminClient } from '@/lib/admin-client';

export type SessionState =
  | { kind: 'loading' }
  | { kind: 'anon' }
  /** o servidor não tem as variáveis do admin: painel desativado */
  | { kind: 'disabled' }
  | { kind: 'error'; message: string }
  | { kind: 'authed'; login: string };

/** Sessão do administrador: pergunta `/api/admin/me` uma vez e deixa o resto do painel reagir a 401 (`expire`). */
export function useAdminSession() {
  const api: AdminClient = useMemo(() => createAdminClient(), []);
  const [state, setState] = useState<SessionState>({ kind: 'loading' });

  const check = useCallback(async () => {
    setState({ kind: 'loading' });
    try {
      const me = await api.me();
      setState({ kind: 'authed', login: me.login });
    } catch (e) {
      if (e instanceof AdminApiError && e.status === 401) setState({ kind: 'anon' });
      else if (e instanceof AdminApiError && e.status === 503 && e.code === 'admin_disabled') setState({ kind: 'disabled' });
      else setState({ kind: 'error', message: e instanceof AdminApiError ? e.message : 'Não foi possível verificar a sessão.' });
    }
  }, [api]);

  useEffect(() => {
    void check();
  }, [check]);

  const expire = useCallback(() => setState({ kind: 'anon' }), []);

  const logout = useCallback(async () => {
    try {
      await api.logout();
    } catch {
      /* mesmo que falhe, a tela volta ao login; a sessão expira sozinha */
    }
    setState({ kind: 'anon' });
  }, [api]);

  return { api, state, check, expire, logout };
}
