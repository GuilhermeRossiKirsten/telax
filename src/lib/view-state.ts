/**
 * Preferências de exibição, só do lado do usuário: o que ele fecha, silencia, ajusta de volume, abre ou
 * seleciona não muda nada para os outros e não passa pelo servidor.
 *
 * Há UM tile por participante. A tela compartilhada de menor slot ocupa o lugar do avatar/câmera nesse mesmo
 * tile; cada tela adicional vira um tile extra (`peerId#slot`). Uma tela é identificada por `peerId#slot`.
 */

import { screenLabel, slotsFromMask } from './screens';

export type Layout = 'grid' | 'spotlight';
export type TileKind = 'person' | 'screen';

/**
 * `id` é o peerId (tile da pessoa) ou `peerId#slot` (tile extra de tela).
 * `slot` é a tela que o tile mostra (a de menor slot, no tile da pessoa); `null` se a pessoa não compartilha.
 */
export type Tile = { id: string; kind: TileKind; peerId: string; name: string; self: boolean; slot: number | null };

export type ViewState = {
  /** todos os tiles existentes (inclui os escondidos), na ordem de chegada */
  order: string[];
  /** escondidos pelo usuário: saem do palco (o som segue o mesmo, a menos que também silenciados) */
  hidden: string[];
  /** chaves de áudio silenciadas: `camera:<peer>` (voz) e `screen:<peer>#<slot>` (som da aba de uma tela) */
  muted: string[];
  /** volume de 0 a 1 por chave de áudio; sem entrada vale 1 */
  volume: Record<string, number>;
  /** tiles selecionados (clique no tile): formam, juntos, a grade principal; os demais ficam na faixa embaixo */
  selected: string[];
  /** telas de outras pessoas que o usuário abriu (ids `peer#slot`) */
  screens: string[];
  /** telas sendo compartilhadas agora (ids `peer#slot`), para detectar um novo compartilhamento */
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

/** Toda tela de outra pessoa começa fechada e com o som da aba mutado: cada um abre e ativa a que quer. */
export const START_REMOTE_SCREENS_OFF = true;

export const screenId = (peerId: string, slot: number) => `${peerId}#${slot}`;
export const voiceKey = (peerId: string) => `camera:${peerId}`;
export const screenKey = (sid: string) => `screen:${sid}`;

/** A tela que o tile mostra (`peer#slot`), ou null. */
export const screenIdOf = (t: Pick<Tile, 'peerId' | 'slot'>) => (t.slot === null ? null : screenId(t.peerId, t.slot));

/** Nome mostrado no tile e nos botões. */
export function tileLabel(t: Pick<Tile, 'kind' | 'name' | 'self' | 'slot'>) {
  if (t.kind === 'screen' && t.slot !== null) return screenLabel(t.name, t.slot);
  return t.self ? `${t.name} (você)` : t.name;
}

type PersonInput = { id: string; name: string; conn: string; screenSlots?: number; sharing?: boolean };

export function buildTiles(participants: ReadonlyArray<PersonInput>): Tile[] {
  const tiles: Tile[] = [];
  for (const p of participants) {
    const self = p.conn === 'self';
    // sem `screenSlots` (cliente/servidor antigo), o booleano `sharing` vale como a tela 0
    const slots = slotsFromMask(p.screenSlots ?? (p.sharing ? 1 : 0));
    tiles.push({ id: p.id, kind: 'person', peerId: p.id, name: p.name, self, slot: slots[0] ?? null });
    for (const slot of slots.slice(1)) {
      tiles.push({ id: screenId(p.id, slot), kind: 'screen', peerId: p.id, name: p.name, self, slot });
    }
  }
  return tiles;
}

export const initialView = (): ViewState => ({ order: [], hidden: [], muted: [], volume: {}, selected: [], screens: [], sharing: [] });

export const volumeOf = (state: ViewState, key: string) => state.volume[key] ?? 1;

/** O tile está mostrando uma tela (a própria sempre; a dos outros só depois de aberta). */
export function showsScreen(t: Tile, state: ViewState): boolean {
  const sid = screenIdOf(t);
  return sid !== null && (t.self || state.screens.includes(sid));
}

const sameList = (a: string[], b: string[]) => a.length === b.length && a.every((v, i) => v === b[i]);
const toggle = (list: string[], id: string) => (list.includes(id) ? list.filter((x) => x !== id) : [...list, id]);
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));
const peerOfScreen = (sid: string) => sid.split('#')[0];

/** `camera:<peer>` vale para quem está na sala; `screen:<peer>#<slot>` só para telas compartilhadas agora. */
function keyAlive(key: string, peers: ReadonlySet<string>, live: ReadonlyArray<string>): boolean {
  const i = key.indexOf(':');
  const kind = key.slice(0, i);
  const rest = key.slice(i + 1);
  if (kind === 'camera') return peers.has(rest);
  if (kind === 'screen') return live.includes(rest);
  return false;
}

export function viewReducer(state: ViewState, action: ViewAction): ViewState {
  switch (action.type) {
    case 'sync': {
      const alive = new Set(action.tiles.map((t) => t.id));
      const peers = new Set(action.tiles.filter((t) => t.kind === 'person').map((t) => t.id));
      const known = new Set(state.order);
      const order = [...state.order.filter((id) => alive.has(id)), ...action.tiles.filter((t) => !known.has(t.id)).map((t) => t.id)];
      const sharing = action.tiles.flatMap((t) => screenIdOf(t) ?? []);
      const freshRemote = action.tiles.filter((t) => !t.self).flatMap((t) => screenIdOf(t) ?? []).filter((sid) => !state.sharing.includes(sid));
      const hidden = state.hidden.filter((id) => alive.has(id));
      const screens = state.screens.filter((sid) => sharing.includes(sid));
      const alivekey = (k: string) => keyAlive(k, peers, sharing);
      const muted = [
        ...state.muted.filter(alivekey),
        // o som da aba só toca quando a pessoa ativa
        ...(START_REMOTE_SCREENS_OFF ? freshRemote.map(screenKey) : []),
      ];
      const keptVolume = Object.keys(state.volume).filter(alivekey);
      const selected = state.selected.filter((id) => alive.has(id));
      if (
        sameList(order, state.order) &&
        sameList(hidden, state.hidden) &&
        sameList(muted, state.muted) &&
        sameList(screens, state.screens) &&
        sameList(sharing, state.sharing) &&
        keptVolume.length === Object.keys(state.volume).length &&
        sameList(selected, state.selected)
      ) {
        return state;
      }
      const volume = Object.fromEntries(keptVolume.map((k) => [k, state.volume[k]]));
      return { ...state, order, hidden, muted, volume, screens, sharing, selected };
    }
    case 'toggleHidden': {
      if (!state.order.includes(action.id)) return state;
      return { ...state, hidden: toggle(state.hidden, action.id), selected: state.selected.filter((id) => id !== action.id) };
    }
    case 'toggleMuted': {
      const peers = new Set(state.order.filter((id) => !id.includes('#')));
      return keyAlive(action.key, peers, state.sharing) ? { ...state, muted: toggle(state.muted, action.key) } : state;
    }
    case 'select': {
      // seleção múltipla e independente: clicar alterna só aquele tile; null limpa tudo
      if (action.id === null) return state.selected.length === 0 ? state : { ...state, selected: [] };
      if (!state.order.includes(action.id)) return state;
      if (state.selected.includes(action.id)) return { ...state, selected: state.selected.filter((id) => id !== action.id) };
      return { ...state, selected: [...state.selected, action.id], hidden: state.hidden.filter((id) => id !== action.id) };
    }
    case 'volume': {
      const peers = new Set(state.order.filter((id) => !id.includes('#')));
      if (!keyAlive(action.key, peers, state.sharing) || !Number.isFinite(action.volume)) return state;
      const volume = clamp01(action.volume);
      return volume === volumeOf(state, action.key) ? state : { ...state, volume: { ...state.volume, [action.key]: volume } };
    }
    case 'openScreen': {
      if (!state.sharing.includes(action.id) || state.screens.includes(action.id)) return state;
      // abrir a tela mostra o tile que a exibe (o extra ou o da pessoa)
      const unhide = new Set([action.id, peerOfScreen(action.id)]);
      return { ...state, screens: [...state.screens, action.id], hidden: state.hidden.filter((id) => !unhide.has(id)) };
    }
    case 'closeScreen':
      return state.screens.includes(action.id) ? { ...state, screens: state.screens.filter((sid) => sid !== action.id) } : state;
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

/**
 * Os tiles do palco (a grade principal): os selecionados; sem seleção, os que estão mostrando uma tela
 * (aberta, ou a própria). Vazio = não há palco, só a grade normal. Mantém a ordem dos tiles, não a dos cliques.
 */
export function stageTiles(visible: Tile[], state: ViewState): Tile[] {
  const picked = visible.filter((t) => state.selected.includes(t.id));
  return picked.length > 0 ? picked : visible.filter((t) => showsScreen(t, state));
}

/** Destaque quando há palco e ainda sobram tiles para a faixa; se o palco é tudo (ou não há palco), grade normal. */
export function effectiveLayout(visible: Tile[], state: ViewState): Layout {
  const stage = stageTiles(visible, state);
  return stage.length > 0 && stage.length < visible.length ? 'spotlight' : 'grid';
}

/** Colunas da grade do palco: raiz quadrada arredondada para cima (1→1, 2→2, 3–4→2, 5–9→3). */
export const stageColumns = (n: number) => Math.max(1, Math.ceil(Math.sqrt(n)));

/** Ajusta o volume de uma fonte de áudio; mexer em quem está silenciado volta a ouvir. */
export function applyVolume(state: ViewState, dispatch: (a: ViewAction) => void, key: string, volume: number) {
  dispatch({ type: 'volume', key, volume });
  if (volume > 0 && state.muted.includes(key)) dispatch({ type: 'toggleMuted', key });
}
