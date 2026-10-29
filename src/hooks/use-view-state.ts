'use client';

import { useCallback, useEffect, useMemo, useReducer } from 'react';
import { buildTiles, initialView, viewReducer, type Tile, type ViewAction, type ViewState } from '@/lib/view-state';

const KEY = 'telax:view';

type Prefs = { layout?: unknown; columns?: unknown };

function loadPrefs(): Prefs {
  try {
    const raw = JSON.parse(window.localStorage.getItem(KEY) ?? 'null');
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {}; // sem localStorage (janela privada, bloqueado) ou JSON inválido: segue com o padrão
  }
}

function savePrefs(patch: Prefs) {
  try {
    window.localStorage.setItem(KEY, JSON.stringify({ ...loadPrefs(), ...patch }));
  } catch {
    /* sem armazenamento: a escolha vale só nesta sessão */
  }
}

type Person = { id: string; name: string; sharing: boolean; conn: string };

/**
 * Estado de exibição das telas deste usuário. O estado "sincronizado" é calculado no próprio render
 * (o reducer é puro e idempotente), assim uma tela remota nova já nasce oculta, sem piscar.
 */
export function useViewState(participants: ReadonlyArray<Person>) {
  const [state, dispatch] = useReducer(viewReducer, undefined, () => initialView());
  const tiles = useMemo<Tile[]>(() => buildTiles(participants), [participants]);
  const view = useMemo(() => viewReducer(state, { type: 'sync', tiles }), [state, tiles]);

  useEffect(() => {
    dispatch({ type: 'sync', tiles });
  }, [tiles]);

  // preferências salvas entram depois da montagem (o primeiro render do servidor não conhece o localStorage)
  useEffect(() => {
    const prefs = loadPrefs();
    dispatch({ type: 'layout', layout: prefs.layout as ViewState['layout'] });
    dispatch({ type: 'columns', columns: prefs.columns as number });
  }, []);

  // só as escolhas do usuário são gravadas (gravar em efeito sobrescreveria o que acabou de ser lido)
  const act = useCallback((a: ViewAction) => {
    dispatch(a);
    if (a.type === 'layout') savePrefs({ layout: a.layout });
    if (a.type === 'columns') savePrefs({ columns: a.columns });
  }, []);

  const maximized = view.maximized;
  useEffect(() => {
    if (!maximized) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dispatch({ type: 'maximize', id: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [maximized]);

  return { tiles, view, dispatch: act };
}

export type ViewApi = ReturnType<typeof useViewState>;
