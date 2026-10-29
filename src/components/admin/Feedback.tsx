'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AdminApiError } from '@/lib/admin-client';
import './admin.css';

export type FeedbackState = { kind: 'ok' | 'error'; text: string } | null;

/** Resultado da última ação (sucesso ou erro amigável); some sozinho depois de alguns segundos. */
export function useFeedback(onExpired?: () => void) {
  const [feedback, setFeedback] = useState<FeedbackState>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const show = useCallback((next: FeedbackState) => {
    clearTimeout(timer.current);
    setFeedback(next);
    if (next) timer.current = setTimeout(() => setFeedback(null), 7000);
  }, []);

  /** Roda uma ação: mostra `okText` ao concluir, ou o erro; 401 leva ao login. Devolve se deu certo. */
  const run = useCallback(
    async (action: () => Promise<unknown>, okText: string | ((result: unknown) => string)): Promise<boolean> => {
      try {
        const result = await action();
        show({ kind: 'ok', text: typeof okText === 'function' ? okText(result) : okText });
        return true;
      } catch (e) {
        if (e instanceof AdminApiError && e.status === 401) onExpired?.();
        else show({ kind: 'error', text: e instanceof AdminApiError ? e.message : 'Não foi possível concluir a ação.' });
        return false;
      }
    },
    [onExpired, show],
  );

  return { feedback, show, run };
}

export function Feedback({ feedback }: { feedback: FeedbackState }) {
  if (!feedback) return null;
  return (
    <p className="adm-feedback" data-kind={feedback.kind} role={feedback.kind === 'error' ? 'alert' : 'status'}>
      {feedback.text}
    </p>
  );
}
