import { describe, expect, it } from 'vitest';
import { maskFromSlots } from './screens';
import {
  buildTiles,
  effectiveLayout,
  initialView,
  orderedTiles,
  primaryTile,
  screenIdOf,
  screenKey,
  showsScreen,
  tileLabel,
  viewReducer,
  visibleTiles,
  voiceKey,
  volumeOf,
  type Tile,
  type ViewState,
} from './view-state';

const person = (id: string, over: Partial<{ name: string; slots: number[]; conn: 'self' | 'connected' }> = {}) => ({
  id,
  name: over.name ?? id.toUpperCase(),
  screenSlots: maskFromSlots(over.slots ?? []),
  conn: over.conn ?? ('connected' as const),
});

const synced = (tiles: Tile[], from: ViewState = initialView()) => viewReducer(from, { type: 'sync', tiles });
const ids = (tiles: Tile[]) => tiles.map((t) => t.id);

describe('buildTiles', () => {
  it('um tile por participante; a tela de menor slot ocupa o tile da pessoa', () => {
    const tiles = buildTiles([person('a', { conn: 'self' }), person('b', { slots: [0] })]);
    expect(ids(tiles)).toEqual(['a', 'b']);
    expect(tiles.map((t) => t.kind)).toEqual(['person', 'person']);
    expect(tiles.map((t) => t.slot)).toEqual([null, 0]);
    expect(tiles.map((t) => t.self)).toEqual([true, false]);
  });

  it('cada tela adicional vira um tile extra logo depois do tile da pessoa', () => {
    const tiles = buildTiles([person('b', { slots: [0, 2] }), person('c')]);
    expect(ids(tiles)).toEqual(['b', 'b#2', 'c']);
    expect(tiles[0]).toMatchObject({ kind: 'person', slot: 0 });
    expect(tiles[1]).toMatchObject({ kind: 'screen', slot: 2, peerId: 'b' });
  });

  it('se o slot 0 parou, o menor slot ativo assume o tile da pessoa', () => {
    const tiles = buildTiles([person('b', { slots: [1, 2] })]);
    expect(ids(tiles)).toEqual(['b', 'b#2']);
    expect(tiles[0].slot).toBe(1);
  });

  it('sem screenSlots usa o booleano sharing (compatibilidade)', () => {
    const [t] = buildTiles([{ id: 'x', name: 'X', conn: 'connected', sharing: true }]);
    expect(t.slot).toBe(0);
  });
});

describe('rótulos e chaves', () => {
  it('rótulo do tile da pessoa, da própria pessoa e das telas', () => {
    const tiles = buildTiles([person('a', { name: 'Ana', conn: 'self' }), person('b', { name: 'Beto', slots: [0, 1] })]);
    expect(ids(tiles)).toEqual(['a', 'b', 'b#1']);
    const [eu, outro, extra] = tiles;
    expect(tileLabel(eu)).toBe('Ana (você)');
    expect(tileLabel(outro)).toBe('Beto');
    expect(tileLabel(extra)).toBe('Tela 2 de Beto');
  });
  it('chaves de áudio: voz por pessoa, som da aba por tela', () => {
    expect(voiceKey('b')).toBe('camera:b');
    expect(screenKey('b#1')).toBe('screen:b#1');
  });
  it('identidade da tela mostrada por um tile', () => {
    const tiles = buildTiles([person('b', { slots: [1, 2] })]);
    expect(screenIdOf(tiles[0])).toBe('b#1');
    expect(screenIdOf(tiles[1])).toBe('b#2');
    expect(screenIdOf(buildTiles([person('c')])[0])).toBeNull();
  });
});

describe('sync', () => {
  it('tiles novos entram no fim e a ordem existente é preservada', () => {
    let s = synced(buildTiles([person('a'), person('b')]));
    expect(s.order).toEqual(['a', 'b']);
    s = synced(buildTiles([person('a'), person('b'), person('c')]), s);
    expect(s.order).toEqual(['a', 'b', 'c']);
  });

  it('é idempotente: sincronizar a mesma lista devolve o mesmo estado (sem re-render em loop)', () => {
    const tiles = buildTiles([person('a'), person('b', { slots: [0, 1] })]);
    const s = synced(tiles);
    expect(synced(tiles, s)).toBe(s);
  });

  it('toda tela de outra pessoa começa FECHADA e com o som da aba MUTADO; os tiles seguem visíveis', () => {
    const tiles = buildTiles([person('eu', { conn: 'self', slots: [0] }), person('b', { slots: [0, 1] })]);
    const s = synced(tiles);
    expect(s.screens).toEqual([]);
    expect(s.muted.sort()).toEqual(['screen:b#0', 'screen:b#1']);
    expect(s.hidden).toEqual([]);
    expect(showsScreen(tiles.find((t) => t.id === 'b')!, s)).toBe(false);
  });

  it('as próprias telas são mostradas direto, sem abrir nem mutar', () => {
    const tiles = buildTiles([person('eu', { conn: 'self', slots: [0, 1] })]);
    const s = synced(tiles);
    expect(tiles.every((t) => showsScreen(t, s))).toBe(true);
    expect(s.muted).toEqual([]);
  });

  it('uma tela que para e volta recomeça fechada e mutada, mesmo se tinha sido aberta', () => {
    const on = buildTiles([person('b', { slots: [0] })]);
    let s = synced(on);
    s = viewReducer(s, { type: 'openScreen', id: 'b#0' });
    s = viewReducer(s, { type: 'toggleMuted', key: 'screen:b#0' });
    expect(s.screens).toEqual(['b#0']);
    expect(s.muted).toEqual([]);
    s = synced(buildTiles([person('b')]), s);
    expect(s.screens).toEqual([]);
    s = synced(on, s);
    expect(s.screens).toEqual([]);
    expect(s.muted).toEqual(['screen:b#0']);
  });

  it('parar o slot 0 não mexe nas outras telas: o estado do slot 1 (aberta, volume) é preservado', () => {
    const both = buildTiles([person('b', { slots: [0, 1] })]);
    let s = synced(both);
    s = viewReducer(s, { type: 'openScreen', id: 'b#1' });
    s = viewReducer(s, { type: 'toggleMuted', key: 'screen:b#1' });
    s = viewReducer(s, { type: 'volume', key: 'screen:b#1', volume: 0.3 });
    const onlySlot1 = buildTiles([person('b', { slots: [1] })]);
    s = synced(onlySlot1, s);
    expect(s.screens).toEqual(['b#1']);
    expect(s.muted).toEqual([]);
    expect(volumeOf(s, 'screen:b#1')).toBe(0.3);
    expect(s.order).toEqual(['b']); // o tile extra sumiu; a tela 2 agora ocupa o tile da pessoa
    expect(showsScreen(onlySlot1[0], s)).toBe(true);
  });

  it('quem sai não deixa estado órfão', () => {
    const tiles = buildTiles([person('a'), person('b', { slots: [0, 1] })]);
    let s = synced(tiles);
    s = viewReducer(s, { type: 'openScreen', id: 'b#0' });
    s = viewReducer(s, { type: 'toggleHidden', id: 'a' });
    s = viewReducer(s, { type: 'volume', key: 'camera:b', volume: 0.4 });
    s = viewReducer(s, { type: 'volume', key: 'screen:b#1', volume: 0.2 });
    s = viewReducer(s, { type: 'select', id: 'b#1' });
    s = synced(buildTiles([]), s);
    expect(s).toMatchObject({ order: [], hidden: [], muted: [], volume: {}, selected: null, screens: [], sharing: [] });
  });
});

describe('ações', () => {
  const tiles = buildTiles([person('a'), person('b', { slots: [0, 1] }), person('c')]);
  const base = () => synced(tiles);

  it('esconder e mostrar o tile alternam', () => {
    let s = viewReducer(base(), { type: 'toggleHidden', id: 'b' });
    expect(ids(visibleTiles(tiles, s))).toEqual(['a', 'b#1', 'c']);
    s = viewReducer(s, { type: 'toggleHidden', id: 'b' });
    expect(ids(visibleTiles(tiles, s))).toEqual(['a', 'b', 'b#1', 'c']);
  });

  it('abrir uma tela a mostra no tile dela (e o desesconde); fechar volta sem esconder o tile', () => {
    let s = viewReducer(base(), { type: 'toggleHidden', id: 'b#1' });
    s = viewReducer(s, { type: 'openScreen', id: 'b#1' });
    expect(s.hidden).toEqual([]);
    expect(showsScreen(tiles[2], s)).toBe(true);
    s = viewReducer(s, { type: 'closeScreen', id: 'b#1' });
    expect(showsScreen(tiles[2], s)).toBe(false);
    expect(ids(visibleTiles(tiles, s))).toEqual(['a', 'b', 'b#1', 'c']);
  });

  it('só dá para abrir telas que estão sendo compartilhadas', () => {
    const s = base();
    expect(viewReducer(s, { type: 'openScreen', id: 'a#0' })).toBe(s);
    expect(viewReducer(s, { type: 'openScreen', id: 'b#2' })).toBe(s);
    expect(viewReducer(s, { type: 'openScreen', id: 'zzz' })).toBe(s);
    expect(viewReducer(s, { type: 'closeScreen', id: 'b#0' })).toBe(s);
  });

  it('silenciar e reativar: voz e som de cada aba são chaves independentes', () => {
    let s = viewReducer(base(), { type: 'toggleMuted', key: 'camera:c' });
    expect(s.muted).toEqual(expect.arrayContaining(['camera:c', 'screen:b#0', 'screen:b#1']));
    s = viewReducer(s, { type: 'toggleMuted', key: 'screen:b#1' });
    expect(s.muted).toEqual(expect.arrayContaining(['camera:c', 'screen:b#0']));
    expect(s.muted).not.toContain('screen:b#1');
    s = viewReducer(s, { type: 'toggleMuted', key: 'camera:c' });
    expect(s.muted).toEqual(['screen:b#0']);
  });

  it('chaves inexistentes são ignoradas', () => {
    const s = base();
    expect(viewReducer(s, { type: 'toggleMuted', key: 'screen:a#0' })).toBe(s);
    expect(viewReducer(s, { type: 'toggleMuted', key: 'screen:b#2' })).toBe(s);
    expect(viewReducer(s, { type: 'toggleMuted', key: 'camera:zzz' })).toBe(s);
    expect(viewReducer(s, { type: 'toggleMuted', key: 'lixo' })).toBe(s);
    expect(viewReducer(s, { type: 'volume', key: 'screen:a#0', volume: 0.5 })).toBe(s);
    expect(viewReducer(s, { type: 'toggleHidden', id: 'zzz' })).toBe(s);
    expect(viewReducer(s, { type: 'select', id: 'zzz' })).toBe(s);
  });

  it('selecionar um tile escondido o mostra; esconder o selecionado desfaz a seleção', () => {
    let s = viewReducer(base(), { type: 'toggleHidden', id: 'c' });
    s = viewReducer(s, { type: 'select', id: 'c' });
    expect(s).toMatchObject({ selected: 'c', hidden: [] });
    s = viewReducer(s, { type: 'toggleHidden', id: 'c' });
    expect(s.selected).toBeNull();
  });

  it('selecionar o que já está selecionado solta; null solta; trocar de seleção troca', () => {
    let s = viewReducer(base(), { type: 'select', id: 'a' });
    s = viewReducer(s, { type: 'select', id: 'b#1' });
    expect(s.selected).toBe('b#1');
    s = viewReducer(s, { type: 'select', id: 'b#1' });
    expect(s.selected).toBeNull();
    s = viewReducer(s, { type: 'select', id: 'a' });
    s = viewReducer(s, { type: 'select', id: null });
    expect(s.selected).toBeNull();
  });

  it('volume: por chave, limitado a 0–1, ignora lixo; o padrão é 1', () => {
    let s = viewReducer(base(), { type: 'volume', key: 'camera:c', volume: 0.35 });
    expect(volumeOf(s, 'camera:c')).toBe(0.35);
    expect(volumeOf(s, 'camera:a')).toBe(1);
    s = viewReducer(s, { type: 'volume', key: 'camera:c', volume: 7 });
    expect(volumeOf(s, 'camera:c')).toBe(1);
    s = viewReducer(s, { type: 'volume', key: 'camera:c', volume: -3 });
    expect(volumeOf(s, 'camera:c')).toBe(0);
    expect(viewReducer(s, { type: 'volume', key: 'camera:c', volume: Number.NaN })).toBe(s);
  });
});

describe('exibição', () => {
  it('orderedTiles segue a ordem do estado e põe no fim o que ainda não foi sincronizado', () => {
    const tiles = buildTiles([person('a'), person('b'), person('c')]);
    const s = synced(buildTiles([person('a'), person('b')]));
    expect(ids(orderedTiles(tiles, s))).toEqual(['a', 'b', 'c']);
  });

  it('com telas fechadas e sem seleção é grade', () => {
    const tiles = buildTiles([person('a'), person('b', { slots: [0, 1] })]);
    const s = synced(tiles);
    expect(effectiveLayout(visibleTiles(tiles, s), s)).toBe('grid');
  });

  it('abrir uma tela vira destaque, com o tile que a mostra como principal', () => {
    const tiles = buildTiles([person('a'), person('b', { slots: [0, 1] })]);
    let s = synced(tiles);
    s = viewReducer(s, { type: 'openScreen', id: 'b#1' });
    const vis = visibleTiles(tiles, s);
    expect(effectiveLayout(vis, s)).toBe('spotlight');
    expect(primaryTile(vis, s)?.id).toBe('b#1');
  });

  it('as próprias telas também vão para o destaque', () => {
    const tiles = buildTiles([person('eu', { conn: 'self', slots: [0] }), person('b')]);
    const s = synced(tiles);
    expect(primaryTile(visibleTiles(tiles, s), s)?.id).toBe('eu');
    expect(effectiveLayout(visibleTiles(tiles, s), s)).toBe('spotlight');
  });

  it('a seleção vence a tela aberta e os demais continuam visíveis embaixo', () => {
    const tiles = buildTiles([person('a', { conn: 'self' }), person('b', { slots: [0] }), person('c')]);
    let s = synced(tiles);
    s = viewReducer(s, { type: 'openScreen', id: 'b#0' });
    s = viewReducer(s, { type: 'select', id: 'c' });
    const vis = visibleTiles(tiles, s);
    expect(primaryTile(vis, s)?.id).toBe('c');
    expect(ids(vis.filter((t) => t.id !== 'c'))).toEqual(['a', 'b']);
  });

  it('com um único tile visível não há o que separar: grade', () => {
    const tiles = buildTiles([person('a')]);
    const s = viewReducer(synced(tiles), { type: 'select', id: 'a' });
    expect(effectiveLayout(visibleTiles(tiles, s), s)).toBe('grid');
  });
});
