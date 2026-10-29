'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminApiError } from '@/lib/admin-client';
import { pollIntervalMs, secondsSince } from '@/lib/admin-ui';

/** A aba está oculta? (para pausar a atualização automática: cada consulta é uma invocação da Vercel) */
export function usePageHidden(): boolean {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const sync = () => setHidden(document.visibilityState === 'hidden');
    sync();
    document.addEventListener('visibilitychange', sync);
    return () => document.removeEventListener('visibilitychange', sync);
  }, []);
  return hidden;
}

/** Relógio local (só para rótulos como "há 5 min"): não faz nenhuma chamada à API. */
export function useNow(everyMs = 1000): number {
  const hidden = usePageHidden();
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (hidden) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), everyMs);
    return () => clearInterval(id);
  }, [hidden, everyMs]);
  return now;
}

type PollOptions = {
  /** chamado quando a API responde 401: a sessão acabou */
  onExpired(): void;
  /** `null` = sem atualização automática (só `reload`) */
  intervalMs?: number | null;
  /** `false` = não consulta (ex.: sala fechada) */
  enabled?: boolean;
};

/**
 * Busca um dado de admin e o mantém atualizado: pausa com a aba oculta (e refaz a consulta ao voltar),
 * nunca deixa duas consultas em voo e trata 401 como "sessão expirou".
 */
export function useAdminPoll<T>(fetcher: () => Promise<T>, { onExpired, intervalMs = 5000, enabled = true }: PollOptions) {
  const hidden = usePageHidden();
  const now = useNow(1000);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const inFlight = useRef(false);
  const fetcherRef = useRef(fetcher);
  const expiredRef = useRef(onExpired);
  useEffect(() => {
    fetcherRef.current = fetcher;
    expiredRef.current = onExpired;
  });

  const reload = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      setData(await fetcherRef.current());
      setUpdatedAt(Date.now());
      setError(null);
    } catch (e) {
      if (e instanceof AdminApiError && e.status === 401) expiredRef.current();
      else setError(e instanceof AdminApiError ? e.message : 'Algo deu errado. Tente de novo em instantes.');
    } finally {
      inFlight.current = false;
    }
  }, []);

  useEffect(() => {
    if (!enabled) return;
    void reload();
    const ms = intervalMs === null ? null : pollIntervalMs(hidden, intervalMs);
    if (ms === null) return;
    const id = setInterval(() => void reload(), ms);
    return () => clearInterval(id);
  }, [enabled, hidden, intervalMs, reload]);

  return { data, error, updatedAt, secondsAgo: secondsSince(updatedAt, now), reload };
}
