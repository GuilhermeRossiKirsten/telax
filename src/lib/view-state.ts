/**
 * Preferências de exibição, só do lado do usuário: o que ele fecha, silencia, ajusta de volume, abre ou
 * seleciona não muda nada para os outros e não passa pelo servidor.
 *
 * Há UM tile por participante. Quando a pessoa compartilha a tela, a tela ocupa o lugar do avatar/câmera
 * dentro do mesmo tile (nada de um segundo componente).
 */

export type Layout = 'grid' | 'spotlight';
export type AudioKind = 'camera' | 'screen';

/** `id` é o peerId do participante. */
export type Tile = { id: string; peerId: string; name: string; self: boolean; sharing: boolean };

export type ViewState = {
  /** todos os tiles existentes (inclui os escondidos), na ordem de chegada */
  order: string[];
  /** escondidos pelo usuário: saem do palco (o som segue o mesmo, a menos que também silenciados) */
  hidden: string[];
  /** chaves de áudio silenciadas: `camera:<peer>` (voz) e `screen:<peer>` (som da aba compartilhada) */
  muted: string[];
  /** volume de 0 a 1 por chave de áudio; sem entrada vale 1 */
  volume: Record<string, number>;
  /** o tile em destaque: fica grande e os demais ficam embaixo */
  selected: string | null;
  /** participantes cuja tela compartilhada (de outra pessoa) o usuário abriu */
  screens: string[];
  /** participantes que compartilham a tela agora (para detectar um novo compartilhamento) */
  sharing: string[];
};

export type ViewAction =
  | { type: 'sync'; tiles: Tile[] }
  | { type: 'toggleHidden'; id: string }
  | { type: 'toggleMuted'; key: string }
  | { type: 'select'; id: string | null }
  | { type: 'volume'; key: string; volume: number }
  | { type: 'openScreen'; id: string }
  | { type: 'closeScreen'; id: string };

/** A tela compartilhada por outra pessoa começa fechada e com o som da aba mutado: cada um abre e ativa a que quer. */
export const START_REMOTE_SCREENS_OFF = true;

export const audioKey = (peerId: string, kind: AudioKind) => `${kind}:${peerId}`;

/** Nome mostrado no tile e nos botões. */
export const tileLabel = (t: Pick<Tile, 'name' | 'self'>) => (t.self ? `${t.name} (você)` : t.name);

export function buildTiles(participants: ReadonlyArray<{ id: string; name: string; sharing: boolean; conn: string }>): Tile[] {
  return participants.map((p) => ({ id: p.id, peerId: p.id, name: p.name, self: p.conn === 'self', sharing: p.sharing }));
}

export const initialView = (): ViewState => ({ order: [], hidden: [], muted: [], volume: {}, selected: null, screens: [], sharing: [] });

export const volumeOf = (state: ViewState, key: string) => state.volume[key] ?? 1;

/** O tile está mostrando a tela compartilhada (a própria sempre; a dos outros só depois de aberta). */
export const showsScreen = (t: Tile, state: ViewState) => t.sharing && (t.self || state.screens.includes(t.id));

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** `camera:<peer>` vale para qualquer tile; `screen:<peer>` só para quem compartilha agora. */
function validKey(state: ViewState, key: string): boolean {
  const [kind, ...rest] = key.split(':');
  const id = rest.join(':');
  if (!state.order.includes(id)) return false;
  return kind === 'camera' || (kind === 'screen' && state.sharing.includes(id));
}

export function viewReducer(state: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case 'sync': {
      const alive = new Set(action.tiles.map((t) => t.id));
      const known = new Set(state.order);
      const order = [...state.order.filter((id) => alive.has(id)), ...action.tiles.filter((t) => !known.has(t.id)).map((t) => t.id)];
      const sharing = action.tiles.filter((t) => t.sharing).map((t) => t.id);
      const freshRemote = action.tiles.filter((t) => t.sharing && !t.self && !state.sharing.includes(t.id)).map((t) => t.id);
      const keyOk = (key: string) => {
        const [kind, ...rest] = key.split(':');
        const id = rest.join(':');
        return alive.has(id) && (kind === 'camera' || (kind === 'screen' && sharing.includes(id)));
      };
      const hidden = state.hidden.filter((id) => alive.has(id));
      const screens = state.screens.filter((id) => sharing.includes(id));
      const muted = [
        ...state.muted.filter(keyOk),
        // o som da aba só toca quando a pessoa ativa
        ...(START_REMOTE_SCREENS_OFF ? freshRemote.map((id) => audioKey(id, 'screen')) : []),
      ];
      const keptVolume = Object.keys(state.volume).filter(keyOk);
      const selected = state.selected && alive.has(state.selected) ? state.selected : null;
      if (
        sameList(order, state.order) &&
        sameList(hidden, state.hidden) &&
        sameList(muted, state.muted) &&
        sameList(screens, state.screens) &&
        sameList(sharing, state.sharing) &&
        keptVolume.length === Object.keys(state.volume).length &&
        selected === state.selected
      ) {
        return state;
      }
      const volume = Object.fromEntries(keptVolume.map((k) => [k, state.volume[k]]));
      return { ...state, order, hidden, muted, volume, screens, sharing, selected };
    }
    case 'toggleHidden': {
      if (!state.order.includes(action.id)) return state;
      return { ...state, hidden: toggle(state.hidden, action.id), selected: state.selected === action.id ? null : state.selected };
    }
    case 'toggleMuted':
      return validKey(state, action.key) ? { ...state, muted: toggle(state.muted, action.key) } : state;
    case 'select': {
      if (action.id === null) return state.selected === null ? state : { ...state, selected: null };
      if (!state.order.includes(action.id)) return state;
      if (state.selected === action.id) return { ...state, selected: null };
      return { ...state, selected: action.id, hidden: state.hidden.filter((id) => id !== action.id) };
    }
    case 'volume': {
      if (!validKey(state, action.key) || !Number.isFinite(action.volume)) return state;
      const volume = clamp01(action.volume);
      return volume === volumeOf(state, action.key) ? state : { ...state, volume: { ...state.volume, [action.key]: volume } };
    }
    case 'openScreen': {
      if (!state.sharing.includes(action.id) || state.screens.includes(action.id)) return state;
      return { ...state, screens: [...state.screens, action.id], hidden: state.hidden.filter((id) => id !== action.id) };
    }
    case 'closeScreen':
      return state.screens.includes(action.id) ? { ...state, screens: state.screens.filter((id) => id !== action.id) } : state;
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

/** O tile grande do destaque: o selecionado; senão o primeiro que está mostrando uma tela compartilhada. */
export function primaryTile(visible: Tile[], state: ViewState): Tile | undefined {
  return visible.find((t) => t.id === state.selected) ?? visible.find((t) => showsScreen(t, state));
}

/** Destaque quando há um selecionado ou uma tela aberta (com ao menos 2 tiles); senão, grade. */
export function effectiveLayout(visible: Tile[], state: ViewState): Layout {
  return visible.length >= 2 && primaryTile(visible, state) ? 'spotlight' : 'grid';
}
