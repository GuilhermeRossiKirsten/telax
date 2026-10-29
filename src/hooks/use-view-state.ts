'use client';

import { useEffect, useMemo, useReducer } from 'react';
import { buildTiles, initialView, viewReducer, type Tile, type ViewAction } from '@/lib/view-state';

type Person = { id: string; name: string; sharing: boolean; conn: string };

/**
 * Estado de exibição das telas deste usuário. O estado "sincronizado" é calculado no próprio render
 * (o reducer é puro e idempotente), assim uma tela remota nova já nasce oculta, sem piscar.
 */
export function useViewState(participants: ReadonlyArray<Person>) {
  const [state, dispatch] = useReducer(viewReducer, undefined, initialView);
  const tiles = useMemo<Tile[]>(() => buildTiles(participants), [participants]);
  const view = useMemo(() => viewReducer(state, { type: 'sync', tiles }), [state, tiles]);

  useEffect(() => {
    dispatch({ type: 'sync', tiles });
  }, [tiles]);

  const hasSelection = view.selected.length > 0;
  useEffect(() => {
    if (!hasSelection) return;
    const onKey = (e: KeyboardEvent) => {
      // Esc enquanto se digita (chat) ou se escolhe num select não deve soltar a seleção
      const el = e.target instanceof HTMLElement ? e.target : null;
      if (el && (el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName))) return;
      if (e.key === 'Escape') dispatch({ type: 'select', id: null });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hasSelection]);

  return { tiles, view, dispatch: dispatch as (a: ViewAction) => void };
}

export type ViewApi = ReturnType<typeof useViewState>;
