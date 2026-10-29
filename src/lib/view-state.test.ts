import { describe, expect, it } from 'vitest';
import {
  audioKey,
  buildTiles,
  effectiveLayout,
  initialView,
  orderedTiles,
  primaryTile,
  showsScreen,
  tileLabel,
  viewReducer,
  visibleTiles,
  volumeOf,
  type Tile,
  type ViewState,
} from './view-state';

const person = (id: string, over: Partial<{ name: string; sharing: boolean; conn: 'self' | 'connected' }> = {}) => ({
  id,
  name: over.name ?? id.toUpperCase(),
  sharing: over.sharing ?? false,
  conn: over.conn ?? ('connected' as const),
});

const synced = (tiles: Tile[], from: ViewState = initialView()) => viewReducer(from, { type: 'sync', tiles });
const ids = (tiles: Tile[]) => tiles.map((t) => t.id);

describe('buildTiles', () => {
  it('um único tile por participante, mesmo quando compartilha a tela', () => {
    const tiles = buildTiles([person('a', { conn: 'self' }), person('b', { sharing: true })]);
    expect(ids(tiles)).toEqual(['a', 'b']);
    expect(tiles.map((t) => t.self)).toEqual([true, false]);
    expect(tiles.map((t) => t.sharing)).toEqual([false, true]);
  });
});

describe('tileLabel e audioKey', () => {
  it('a própria pessoa leva "(você)"; os outros só o nome', () => {
    const [eu, outro] = buildTiles([person('a', { name: 'Ana', conn: 'self' }), person('b', { name: 'Beto' })]);
    expect(tileLabel(eu)).toBe('Ana (você)');
    expect(tileLabel(outro)).toBe('Beto');
  });
  it('a voz e o som da aba têm chaves próprias', () => {
    expect(audioKey('b', 'camera')).toBe('camera:b');
    expect(audioKey('b', 'screen')).toBe('screen:b');
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
    const tiles = buildTiles([person('a'), person('b', { sharing: true })]);
    const s = synced(tiles);
    expect(synced(tiles, s)).toBe(s);
  });

  it('a tela de outra pessoa começa FECHADA e com o som da aba MUTADO; o tile segue visível', () => {
    const tiles = buildTiles([person('eu', { conn: 'self', sharing: true }), person('b', { sharing: true })]);
    const s = synced(tiles);
    expect(s.screens).toEqual([]);
    expect(s.muted).toEqual(['screen:b']);
    expect(s.hidden).toEqual([]);
    expect(showsScreen(tiles[1], s)).toBe(false);
  });

  it('a própria tela é mostrada direto, sem precisar abrir nem mutar', () => {
    const tiles = buildTiles([person('eu', { conn: 'self', sharing: true })]);
    const s = synced(tiles);
    expect(showsScreen(tiles[0], s)).toBe(true);
    expect(s.muted).toEqual([]);
  });

  it('se a pessoa para de compartilhar e volta, a tela volta fechada e mutada (mesmo que tivesse sido aberta)', () => {
    const on = buildTiles([person('b', { sharing: true })]);
    let s = synced(on);
    s = viewReducer(s, { type: 'openScreen', id: 'b' });
    s = viewReducer(s, { type: 'toggleMuted', key: 'screen:b' });
    expect(s.screens).toEqual(['b']);
    expect(s.muted).toEqual([]);
    s = synced(buildTiles([person('b')]), s);
    expect(s.screens).toEqual([]);
    s = synced(on, s);
    expect(s.screens).toEqual([]);
    expect(s.muted).toEqual(['screen:b']);
  });

  it('quem sai não deixa estado órfão', () => {
    const tiles = buildTiles([person('a'), person('b', { sharing: true })]);
    let s = synced(tiles);
    s = viewReducer(s, { type: 'openScreen', id: 'b' });
    s = viewReducer(s, { type: 'toggleHidden', id: 'a' });
    s = viewReducer(s, { type: 'volume', key: 'camera:b', volume: 0.4 });
    s = viewReducer(s, { type: 'volume', key: 'screen:b', volume: 0.2 });
    s = viewReducer(s, { type: 'select', id: 'b' });
    s = synced(buildTiles([]), s);
    expect(s).toMatchObject({ order: [], hidden: [], muted: [], volume: {}, selected: null, screens: [], sharing: [] });
  });
});

describe('ações', () => {
  const tiles = buildTiles([person('a'), person('b', { sharing: true }), person('c')]);
  const base = () => synced(tiles);

  it('fechar (esconder) e mostrar o tile alternam', () => {
    let s = viewReducer(base(), { type: 'toggleHidden', id: 'b' });
    expect(ids(visibleTiles(tiles, s))).toEqual(['a', 'c']);
    s = viewReducer(s, { type: 'toggleHidden', id: 'b' });
    expect(ids(visibleTiles(tiles, s))).toEqual(['a', 'b', 'c']);
  });

  it('abrir a tela mostra a tela no mesmo tile (e o desesconde); fechar a tela volta à câmera sem esconder o tile', () => {
    let s = viewReducer(base(), { type: 'toggleHidden', id: 'b' });
    s = viewReducer(s, { type: 'openScreen', id: 'b' });
    expect(s.hidden).toEqual([]);
    expect(showsScreen(tiles[1], s)).toBe(true);
    s = viewReducer(s, { type: 'closeScreen', id: 'b' });
    expect(showsScreen(tiles[1], s)).toBe(false);
    expect(ids(visibleTiles(tiles, s))).toEqual(['a', 'b', 'c']);
  });

  it('só dá para abrir a tela de quem está compartilhando', () => {
    const s = base();
    expect(viewReducer(s, { type: 'openScreen', id: 'a' })).toBe(s);
    expect(viewReducer(s, { type: 'openScreen', id: 'zzz' })).toBe(s);
    expect(viewReducer(s, { type: 'closeScreen', id: 'a' })).toBe(s);
  });

  it('silenciar e reativar: voz e som da aba são chaves independentes', () => {
    let s = viewReducer(base(), { type: 'toggleMuted', key: 'camera:c' });
    expect(s.muted).toContain('camera:c');
    expect(s.muted).toContain('screen:b'); // começou mutado
    s = viewReducer(s, { type: 'toggleMuted', key: 'screen:b' });
    expect(s.muted).not.toContain('screen:b');
    expect(s.muted).toContain('camera:c');
    s = viewReducer(s, { type: 'toggleMuted', key: 'camera:c' });
    expect(s.muted).toEqual([]);
  });

  it('chaves inexistentes são ignoradas (som da aba de quem não compartilha, tile que não existe)', () => {
    const s = base();
    expect(viewReducer(s, { type: 'toggleMuted', key: 'screen:a' })).toBe(s);
    expect(viewReducer(s, { type: 'toggleMuted', key: 'camera:zzz' })).toBe(s);
    expect(viewReducer(s, { type: 'toggleMuted', key: 'lixo' })).toBe(s);
    expect(viewReducer(s, { type: 'volume', key: 'screen:a', volume: 0.5 })).toBe(s);
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
    s = viewReducer(s, { type: 'select', id: 'b' });
    expect(s.selected).toBe('b');
    s = viewReducer(s, { type: 'select', id: 'b' });
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

  it('sem seleção nem tela aberta é grade, mesmo com alguém compartilhando (a tela está fechada)', () => {
    const tiles = buildTiles([person('a'), person('b', { sharing: true })]);
    const s = synced(tiles);
    expect(effectiveLayout(visibleTiles(tiles, s), s)).toBe('grid');
  });

  it('abrir a tela de alguém vira destaque, com o tile dessa pessoa como principal', () => {
    const tiles = buildTiles([person('a'), person('b', { sharing: true })]);
    let s = synced(tiles);
    s = viewReducer(s, { type: 'openScreen', id: 'b' });
    const vis = visibleTiles(tiles, s);
    expect(effectiveLayout(vis, s)).toBe('spotlight');
    expect(primaryTile(vis, s)?.id).toBe('b');
  });

  it('a própria tela compartilhada também vira destaque', () => {
    const tiles = buildTiles([person('eu', { conn: 'self', sharing: true }), person('b')]);
    const s = synced(tiles);
    expect(primaryTile(visibleTiles(tiles, s), s)?.id).toBe('eu');
    expect(effectiveLayout(visibleTiles(tiles, s), s)).toBe('spotlight');
  });

  it('o tile selecionado é o principal e os demais continuam visíveis embaixo; a seleção vence a tela aberta', () => {
    const tiles = buildTiles([person('a', { conn: 'self' }), person('b', { sharing: true }), person('c')]);
    let s = synced(tiles);
    s = viewReducer(s, { type: 'openScreen', id: 'b' });
    s = viewReducer(s, { type: 'select', id: 'c' });
    const vis = visibleTiles(tiles, s);
    expect(effectiveLayout(vis, s)).toBe('spotlight');
    expect(primaryTile(vis, s)?.id).toBe('c');
    expect(ids(vis.filter((t) => t.id !== 'c'))).toEqual(['a', 'b']);
  });

  it('com um único tile visível não há o que separar: grade', () => {
    const tiles = buildTiles([person('a')]);
    const s = viewReducer(synced(tiles), { type: 'select', id: 'a' });
    expect(effectiveLayout(visibleTiles(tiles, s), s)).toBe('grid');
  });
});
