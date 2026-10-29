/**
 * Preferências de exibição das telas, só do lado do usuário: o que ele fecha, silencia, ajusta de volume ou
 * seleciona não muda nada para os outros e não passa pelo servidor.
 */

export type TileKind = 'camera' | 'screen';
export type Layout = 'grid' | 'spotlight';

export type Tile = { id: string; kind: TileKind; peerId: string; name: string; self: boolean };

export type ViewState = {
  /** todos os tiles existentes (inclui os fechados), na ordem de chegada */
  order: string[];
  /** fechados: não aparecem no palco (o som segue o mesmo, a menos que também silenciados) */
  hidden: string[];
  muted: string[];
  /** volume de 0 a 1 por tile; sem entrada vale 1 */
  volume: Record<string, number>;
  /** o tile em destaque: fica grande e os demais (inclusive os participantes) ficam embaixo */
  selected: string | null;
};

export type ViewAction =
  | { type: 'sync'; tiles: Tile[] }
  | { type: 'toggleHidden'; id: string }
  | { type: 'toggleMuted'; id: string }
  | { type: 'select'; id: string | null }
  | { type: 'volume'; id: string; volume: number };

/** Telas compartilhadas por outras pessoas começam ocultas e silenciadas: cada um escolhe a que quer ver e ouvir. */
export const HIDE_NEW_REMOTE_SCREENS = true;

export const tileId = (kind: TileKind, peerId: string) => `${kind}:${peerId}`;

/** Nome mostrado no tile, nos botões e na faixa de fechadas. */
export const tileLabel = (t: Pick<Tile, 'kind' | 'name' | 'self'>) =>
  t.kind === 'screen' ? `Tela de ${t.name}` : t.self ? `${t.name} (você)` : t.name;

export function buildTiles(participants: ReadonlyArray<{ id: string; name: string; sharing: boolean; conn: string }>): Tile[] {
  const tiles: Tile[] = [];
  for (const p of participants) {
    const self = p.conn === 'self';
    tiles.push({ id: tileId('camera', p.id), kind: 'camera', peerId: p.id, name: p.name, self });
    if (p.sharing) tiles.push({ id: tileId('screen', p.id), kind: 'screen', peerId: p.id, name: p.name, self });
  }
  return tiles;
}

export const initialView = (): ViewState => ({ order: [], hidden: [], muted: [], volume: {}, selected: null });

export const volumeOf = (state: ViewState, id: string) => state.volume[id] ?? 1;

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

export function viewReducer(state: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case 'sync': {
      const alive = new Set(action.tiles.map((t) => t.id));
      const known = new Set(state.order);
      const fresh = action.tiles.filter((t) => !known.has(t.id));
      const order = [...state.order.filter((id) => alive.has(id)), ...fresh.map((t) => t.id)];
      const freshRemoteScreens = HIDE_NEW_REMOTE_SCREENS
        ? fresh.filter((t) => t.kind === 'screen' && !t.self).map((t) => t.id)
        : [];
      const hidden = [...state.hidden.filter((id) => alive.has(id)), ...freshRemoteScreens];
      // a tela traz o som da aba: só toca quando a pessoa ativa, junto com mostrar
      const muted = [...state.muted.filter((id) => alive.has(id)), ...freshRemoteScreens];
      const keptVolume = Object.keys(state.volume).filter((id) => alive.has(id));
      const volumeChanged = keptVolume.length !== Object.keys(state.volume).length;
      const selected = state.selected && alive.has(state.selected) ? state.selected : null;
      if (
        sameList(order, state.order) &&
        sameList(hidden, state.hidden) &&
        sameList(muted, state.muted) &&
        !volumeChanged &&
        selected === state.selected
      ) {
        return state;
      }
      const volume = Object.fromEntries(keptVolume.map((id) => [id, state.volume[id]]));
      return { ...state, order, hidden, muted, volume, selected };
    }
    case 'toggleHidden': {
      if (!state.order.includes(action.id)) return state;
      return {
        ...state,
        hidden: toggle(state.hidden, action.id),
        selected: state.selected === action.id ? null : state.selected,
      };
    }
    case 'toggleMuted':
      return state.order.includes(action.id) ? { ...state, muted: toggle(state.muted, action.id) } : state;
    case 'select': {
      if (action.id === null) return state.selected === null ? state : { ...state, selected: null };
      if (!state.order.includes(action.id)) return state;
      if (state.selected === action.id) return { ...state, selected: null };
      return { ...state, selected: action.id, hidden: state.hidden.filter((id) => id !== action.id) };
    }
    case 'volume': {
      if (!state.order.includes(action.id) || !Number.isFinite(action.volume)) return state;
      const volume = clamp01(action.volume);
      return volume === volumeOf(state, action.id) ? state : { ...state, volume: { ...state.volume, [action.id]: volume } };
    }
  }
}

/** Todos os tiles na ordem de chegada; os que ainda não foram sincronizados vão para o fim. */
export function orderedTiles(tiles: Tile[], state: ViewState): Tile[] {
  const byId = new Map(tiles.map((t) => [t.id, t]));
  const known = state.order.flatMap((id) => byId.get(id) ?? []);
  const seen = new Set(state.order);
  return [...known, ...tiles.filter((t) => !seen.has(t.id))];
}

export const visibleTiles = (tiles: Tile[], state: ViewState): Tile[] =>
  orderedTiles(tiles, state).filter((t) => !state.hidden.includes(t.id));

/** O tile grande do destaque: o selecionado; senão a primeira tela compartilhada visível. */
export function primaryTile(visible: Tile[], state: ViewState): Tile | undefined {
  return visible.find((t) => t.id === state.selected) ?? visible.find((t) => t.kind === 'screen');
}

/** Destaque quando há um selecionado ou uma tela visível (com ao menos 2 tiles); senão, grade. */
export function effectiveLayout(visible: Tile[], state: ViewState): Layout {
  return visible.length >= 2 && primaryTile(visible, state) ? 'spotlight' : 'grid';
}
