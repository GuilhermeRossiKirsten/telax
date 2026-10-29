import { describe, expect, it } from 'vitest';
import {
  buildTiles,
  effectiveLayout,
  initialView,
  orderedTiles,
  primaryTile,
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
  it('uma câmera por participante e uma tela extra para quem compartilha', () => {
    const tiles = buildTiles([person('a', { conn: 'self' }), person('b', { sharing: true })]);
    expect(ids(tiles)).toEqual(['camera:a', 'camera:b', 'screen:b']);
    expect(tiles.map((t) => t.self)).toEqual([true, false, false]);
    expect(tiles[2]).toMatchObject({ kind: 'screen', peerId: 'b', name: 'B' });
  });
});

describe('tileLabel', () => {
  it('tela de quem compartilha, câmera própria com "(você)" e câmera dos outros só com o nome', () => {
    const [eu, outro, tela] = buildTiles([person('a', { name: 'Ana', conn: 'self' }), person('b', { name: 'Beto', sharing: true })]);
    expect(tileLabel(eu)).toBe('Ana (você)');
    expect(tileLabel(outro)).toBe('Beto');
    expect(tileLabel(tela)).toBe('Tela de Beto');
  });
});

describe('sync', () => {
  it('tiles novos entram no fim e a ordem existente é preservada', () => {
    let s = synced(buildTiles([person('a'), person('b')]));
    expect(s.order).toEqual(['camera:a', 'camera:b']);
    s = synced(buildTiles([person('a'), person('b'), person('c')]), s);
    expect(s.order).toEqual(['camera:a', 'camera:b', 'camera:c']);
  });

  it('é idempotente: sincronizar a mesma lista devolve o mesmo estado (sem re-render em loop)', () => {
    const tiles = buildTiles([person('a'), person('b')]);
    const s = synced(tiles);
    expect(synced(tiles, s)).toBe(s);
  });

  it('a tela compartilhada de outra pessoa entra oculta e silenciada; a própria e as câmeras entram normais', () => {
    const tiles = buildTiles([person('eu', { conn: 'self', sharing: true }), person('b', { sharing: true })]);
    const s = synced(tiles);
    expect(s.hidden).toEqual(['screen:b']);
    expect(s.muted).toEqual(['screen:b']); // o som da aba só toca quando a pessoa ativa
    expect(ids(visibleTiles(tiles, s))).toEqual(['camera:eu', 'screen:eu', 'camera:b']);
  });

  it('se a pessoa mostra a tela e depois ela para de compartilhar, um novo compartilhamento volta oculto', () => {
    const on = buildTiles([person('b', { sharing: true })]);
    let s = synced(on);
    s = viewReducer(s, { type: 'toggleHidden', id: 'screen:b' });
    expect(s.hidden).toEqual([]);
    s = synced(buildTiles([person('b')]), s);
    s = synced(on, s);
    expect(s.hidden).toEqual(['screen:b']);
  });

  it('quem sai não deixa estado órfão: some de ordem, ocultas, silenciadas, volume e selecionada', () => {
    const tiles = buildTiles([person('a'), person('b')]);
    let s = synced(tiles);
    s = viewReducer(s, { type: 'toggleHidden', id: 'camera:b' });
    s = viewReducer(s, { type: 'toggleMuted', id: 'camera:b' });
    s = viewReducer(s, { type: 'volume', id: 'camera:b', volume: 0.4 });
    s = viewReducer(s, { type: 'select', id: 'camera:a' });
    s = synced(buildTiles([]), s);
    expect(s).toMatchObject({ order: [], hidden: [], muted: [], volume: {}, selected: null });
  });
});

describe('ações', () => {
  const tiles = buildTiles([person('a'), person('b'), person('c')]);
  const base = () => synced(tiles);

  it('fechar (ocultar) e mostrar alternam; silenciar e reativar alternam', () => {
    let s = viewReducer(base(), { type: 'toggleHidden', id: 'camera:b' });
    expect(ids(visibleTiles(tiles, s))).toEqual(['camera:a', 'camera:c']);
    s = viewReducer(s, { type: 'toggleHidden', id: 'camera:b' });
    expect(ids(visibleTiles(tiles, s))).toEqual(['camera:a', 'camera:b', 'camera:c']);
    s = viewReducer(s, { type: 'toggleMuted', id: 'camera:c' });
    expect(s.muted).toEqual(['camera:c']);
    s = viewReducer(s, { type: 'toggleMuted', id: 'camera:c' });
    expect(s.muted).toEqual([]);
  });

  it('selecionar um tile oculto o mostra; fechar o selecionado desfaz a seleção', () => {
    let s = viewReducer(base(), { type: 'toggleHidden', id: 'camera:b' });
    s = viewReducer(s, { type: 'select', id: 'camera:b' });
    expect(s).toMatchObject({ selected: 'camera:b', hidden: [] });
    s = viewReducer(s, { type: 'toggleHidden', id: 'camera:b' });
    expect(s.selected).toBeNull();
    expect(s.hidden).toEqual(['camera:b']);
  });

  it('selecionar o que já está selecionado solta; null solta; trocar de seleção troca', () => {
    let s = viewReducer(base(), { type: 'select', id: 'camera:a' });
    s = viewReducer(s, { type: 'select', id: 'camera:b' });
    expect(s.selected).toBe('camera:b');
    s = viewReducer(s, { type: 'select', id: 'camera:b' });
    expect(s.selected).toBeNull();
    s = viewReducer(s, { type: 'select', id: 'camera:a' });
    s = viewReducer(s, { type: 'select', id: null });
    expect(s.selected).toBeNull();
  });

  it('volume: guarda por tile, limita a 0–1 e ignora lixo; o padrão é 1', () => {
    let s = viewReducer(base(), { type: 'volume', id: 'camera:b', volume: 0.35 });
    expect(volumeOf(s, 'camera:b')).toBe(0.35);
    expect(volumeOf(s, 'camera:c')).toBe(1);
    s = viewReducer(s, { type: 'volume', id: 'camera:b', volume: 7 });
    expect(volumeOf(s, 'camera:b')).toBe(1);
    s = viewReducer(s, { type: 'volume', id: 'camera:b', volume: -3 });
    expect(volumeOf(s, 'camera:b')).toBe(0);
    const same = viewReducer(s, { type: 'volume', id: 'camera:b', volume: Number.NaN });
    expect(same).toBe(s);
  });

  it('ignora ids que não existem', () => {
    const s = base();
    expect(viewReducer(s, { type: 'toggleHidden', id: 'camera:zzz' })).toBe(s);
    expect(viewReducer(s, { type: 'toggleMuted', id: 'camera:zzz' })).toBe(s);
    expect(viewReducer(s, { type: 'select', id: 'camera:zzz' })).toBe(s);
    expect(viewReducer(s, { type: 'volume', id: 'camera:zzz', volume: 0.5 })).toBe(s);
  });
});

describe('exibição', () => {
  it('orderedTiles segue a ordem do estado e põe no fim o que ainda não foi sincronizado', () => {
    const tiles = buildTiles([person('a'), person('b'), person('c')]);
    const s = synced(buildTiles([person('a'), person('b')]));
    expect(ids(orderedTiles(tiles, s))).toEqual(['camera:a', 'camera:b', 'camera:c']);
  });

  it('sem seleção nem tela visível é grade', () => {
    const tiles = buildTiles([person('a'), person('b')]);
    const s = synced(tiles);
    expect(effectiveLayout(visibleTiles(tiles, s), s)).toBe('grid');
  });

  it('com uma tela compartilhada visível vira destaque, com ela como principal', () => {
    const tiles = buildTiles([person('a'), person('b', { sharing: true })]);
    let s = synced(tiles);
    expect(effectiveLayout(visibleTiles(tiles, s), s)).toBe('grid'); // a tela remota começa oculta
    s = viewReducer(s, { type: 'toggleHidden', id: 'screen:b' });
    const vis = visibleTiles(tiles, s);
    expect(effectiveLayout(vis, s)).toBe('spotlight');
    expect(primaryTile(vis, s)?.id).toBe('screen:b');
  });

  it('o tile selecionado vira o principal e os demais (inclusive os participantes) ficam visíveis embaixo', () => {
    const tiles = buildTiles([person('a', { conn: 'self' }), person('b'), person('c')]);
    let s = synced(tiles);
    s = viewReducer(s, { type: 'select', id: 'camera:c' });
    const vis = visibleTiles(tiles, s);
    expect(effectiveLayout(vis, s)).toBe('spotlight');
    expect(primaryTile(vis, s)?.id).toBe('camera:c');
    expect(ids(vis.filter((t) => t.id !== 'camera:c'))).toEqual(['camera:a', 'camera:b']);
  });

  it('a seleção tem prioridade sobre a tela compartilhada', () => {
    const tiles = buildTiles([person('a'), person('b', { sharing: true })]);
    let s = synced(tiles);
    s = viewReducer(s, { type: 'toggleHidden', id: 'screen:b' });
    s = viewReducer(s, { type: 'select', id: 'camera:a' });
    expect(primaryTile(visibleTiles(tiles, s), s)?.id).toBe('camera:a');
  });

  it('com um único tile visível não há o que separar: grade', () => {
    const tiles = buildTiles([person('a')]);
    const s = viewReducer(synced(tiles), { type: 'select', id: 'camera:a' });
    expect(effectiveLayout(visibleTiles(tiles, s), s)).toBe('grid');
  });
});
