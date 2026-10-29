/**
 * Preferências de exibição das telas, só do lado do usuário: o que ele oculta, silencia, reordena ou
 * maximiza não muda nada para os outros e não passa pelo servidor.
 */

export type TileKind = 'camera' | 'screen';
export type Layout = 'auto' | 'grid' | 'spotlight' | 'sidebar';
export type ShownLayout = Exclude<Layout, 'auto'>;

export type Tile = { id: string; kind: TileKind; peerId: string; name: string; self: boolean };

export type ViewState = {
  layout: Layout;
  /** 0 = automático */
  columns: number;
  /** todos os tiles existentes, na ordem escolhida (inclui os ocultos) */
  order: string[];
  hidden: string[];
  muted: string[];
  maximized: string | null;
};

export type ViewAction =
  | { type: 'sync'; tiles: Tile[] }
  | { type: 'layout'; layout: Layout }
  | { type: 'columns'; columns: number }
  | { type: 'move'; id: string; dir: 'up' | 'down' }
  | { type: 'toggleHidden'; id: string }
  | { type: 'toggleMuted'; id: string }
  | { type: 'maximize'; id: string | null };

/** Telas compartilhadas por outras pessoas começam ocultas e silenciadas: cada um escolhe a que quer ver e ouvir. */
export const HIDE_NEW_REMOTE_SCREENS = true;

export const LAYOUTS: ReadonlyArray<Layout> = ['auto', 'grid', 'spotlight', 'sidebar'];
export const MAX_COLUMNS = 4;

const isLayout = (v: unknown): v is Layout => LAYOUTS.includes(v as Layout);
const isColumns = (v: unknown): v is number => Number.isInteger(v) && (v as number) >= 0 && (v as number) <= MAX_COLUMNS;

export const tileId = (kind: TileKind, peerId: string) => `${kind}:${peerId}`;

/** Nome mostrado no tile, nos botões e no painel. */
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

export function initialView(prefs: { layout?: unknown; columns?: unknown } = {}): ViewState {
  return {
    layout: isLayout(prefs.layout) ? prefs.layout : 'auto',
    columns: isColumns(prefs.columns) ? prefs.columns : 0,
    order: [],
    hidden: [],
    muted: [],
    maximized: null,
  };
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);

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
      const maximized = state.maximized && alive.has(state.maximized) ? state.maximized : null;
      if (sameList(order, state.order) && sameList(hidden, state.hidden) && sameList(muted, state.muted) && maximized === state.maximized) {
        return state;
      }
      return { ...state, order, hidden, muted, maximized };
    }
    case 'layout':
      return isLayout(action.layout) && action.layout !== state.layout ? { ...state, layout: action.layout } : state;
    case 'columns':
      return isColumns(action.columns) && action.columns !== state.columns ? { ...state, columns: action.columns } : state;
    case 'move': {
      const i = state.order.indexOf(action.id);
      const j = action.dir === 'up' ? i - 1 : i + 1;
      if (i < 0 || j < 0 || j >= state.order.length) return state;
      const order = [...state.order];
      [order[i], order[j]] = [order[j], order[i]];
      return { ...state, order };
    }
    case 'toggleHidden': {
      if (!state.order.includes(action.id)) return state;
      return {
        ...state,
        hidden: toggle(state.hidden, action.id),
        maximized: state.maximized === action.id ? null : state.maximized,
      };
    }
    case 'toggleMuted':
      return state.order.includes(action.id) ? { ...state, muted: toggle(state.muted, action.id) } : state;
    case 'maximize': {
      if (action.id === null) return state.maximized === null ? state : { ...state, maximized: null };
      if (!state.order.includes(action.id)) return state;
      if (state.maximized === action.id) return { ...state, maximized: null };
      return { ...state, maximized: action.id, hidden: state.hidden.filter((id) => id !== action.id) };
    }
  }
}

/** Todos os tiles na ordem do usuário; os que ainda não foram sincronizados vão para o fim. */
export function orderedTiles(tiles: Tile[], state: ViewState): Tile[] {
  const byId = new Map(tiles.map((t) => [t.id, t]));
  const known = state.order.flatMap((id) => byId.get(id) ?? []);
  const seen = new Set(state.order);
  return [...known, ...tiles.filter((t) => !seen.has(t.id))];
}

export const visibleTiles = (tiles: Tile[], state: ViewState): Tile[] =>
  orderedTiles(tiles, state).filter((t) => !state.hidden.includes(t.id));

/** `auto` é grade, mas vira destaque quando há uma tela compartilhada visível; com um tile só não há o que separar. */
export function effectiveLayout(visible: Tile[], state: ViewState): ShownLayout {
  const wanted: ShownLayout =
    state.layout === 'auto' ? (visible.some((t) => t.kind === 'screen') ? 'spotlight' : 'grid') : state.layout;
  return visible.length < 2 ? 'grid' : wanted;
}

/**
 * O tile grande dos layouts destaque/lateral: no `auto`, a primeira tela visível; nos demais, o primeiro
 * visível que não seja a própria câmera (ninguém quer o próprio rosto grande por padrão).
 */
export function primaryTile(visible: Tile[], state: ViewState): Tile | undefined {
  if (state.layout === 'auto') return visible.find((t) => t.kind === 'screen') ?? visible[0];
  return visible.find((t) => !(t.self && t.kind === 'camera')) ?? visible[0];
}
