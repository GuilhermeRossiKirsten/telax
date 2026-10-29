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
  it('tiles novos entram no fim da ordem e a ordem escolhida é preservada', () => {
    let s = synced(buildTiles([person('a'), person('b')]));
    s = viewReducer(s, { type: 'move', id: 'camera:b', dir: 'up' });
    expect(s.order).toEqual(['camera:b', 'camera:a']);
    s = synced(buildTiles([person('a'), person('b'), person('c')]), s);
    expect(s.order).toEqual(['camera:b', 'camera:a', 'camera:c']);
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

  it('quem sai não deixa estado órfão: some de ordem, ocultas, silenciadas e maximizada', () => {
    const tiles = buildTiles([person('a'), person('b')]);
    let s = synced(tiles);
    s = viewReducer(s, { type: 'toggleHidden', id: 'camera:b' });
    s = viewReducer(s, { type: 'toggleMuted', id: 'camera:b' });
    s = viewReducer(s, { type: 'maximize', id: 'camera:a' });
    s = synced(buildTiles([]), s);
    expect(s).toMatchObject({ order: [], hidden: [], muted: [], maximized: null });
  });
});

describe('ações', () => {
  const tiles = buildTiles([person('a'), person('b'), person('c')]);
  const base = () => synced(tiles);

  it('mover troca com o vizinho e não passa das pontas', () => {
    let s = viewReducer(base(), { type: 'move', id: 'camera:a', dir: 'down' });
    expect(s.order).toEqual(['camera:b', 'camera:a', 'camera:c']);
    s = viewReducer(s, { type: 'move', id: 'camera:b', dir: 'up' });
    expect(s.order).toEqual(['camera:b', 'camera:a', 'camera:c']);
    s = viewReducer(s, { type: 'move', id: 'camera:c', dir: 'down' });
    expect(s.order).toEqual(['camera:b', 'camera:a', 'camera:c']);
  });

  it('ocultar e mostrar alternam; silenciar e reativar alternam', () => {
    let s = viewReducer(base(), { type: 'toggleHidden', id: 'camera:b' });
    expect(ids(visibleTiles(tiles, s))).toEqual(['camera:a', 'camera:c']);
    s = viewReducer(s, { type: 'toggleHidden', id: 'camera:b' });
    expect(ids(visibleTiles(tiles, s))).toEqual(['camera:a', 'camera:b', 'camera:c']);
    s = viewReducer(s, { type: 'toggleMuted', id: 'camera:c' });
    expect(s.muted).toEqual(['camera:c']);
    s = viewReducer(s, { type: 'toggleMuted', id: 'camera:c' });
    expect(s.muted).toEqual([]);
  });

  it('maximizar um tile oculto o mostra; ocultar o maximizado restaura a grade', () => {
    let s = viewReducer(base(), { type: 'toggleHidden', id: 'camera:b' });
    s = viewReducer(s, { type: 'maximize', id: 'camera:b' });
    expect(s).toMatchObject({ maximized: 'camera:b', hidden: [] });
    s = viewReducer(s, { type: 'toggleHidden', id: 'camera:b' });
    expect(s.maximized).toBeNull();
    expect(s.hidden).toEqual(['camera:b']);
  });

  it('maximizar o que já está maximizado restaura; null restaura', () => {
    let s = viewReducer(base(), { type: 'maximize', id: 'camera:a' });
    s = viewReducer(s, { type: 'maximize', id: 'camera:a' });
    expect(s.maximized).toBeNull();
    s = viewReducer(s, { type: 'maximize', id: 'camera:a' });
    s = viewReducer(s, { type: 'maximize', id: null });
    expect(s.maximized).toBeNull();
  });

  it('ignora ids que não existem', () => {
    const s = base();
    expect(viewReducer(s, { type: 'move', id: 'camera:zzz', dir: 'up' })).toBe(s);
    expect(viewReducer(s, { type: 'toggleHidden', id: 'camera:zzz' })).toBe(s);
    expect(viewReducer(s, { type: 'toggleMuted', id: 'camera:zzz' })).toBe(s);
    expect(viewReducer(s, { type: 'maximize', id: 'camera:zzz' })).toBe(s);
  });

  it('layout e colunas: valores inválidos são ignorados', () => {
    let s = viewReducer(base(), { type: 'layout', layout: 'sidebar' });
    s = viewReducer(s, { type: 'columns', columns: 3 });
    expect(s).toMatchObject({ layout: 'sidebar', columns: 3 });
    expect(viewReducer(s, { type: 'columns', columns: 9 })).toBe(s);
    expect(viewReducer(s, { type: 'columns', columns: 1.5 })).toBe(s);
    expect(viewReducer(s, { type: 'layout', layout: 'xyz' as never })).toBe(s);
  });

  it('initialView aproveita preferências válidas e descarta lixo', () => {
    expect(initialView({ layout: 'spotlight', columns: 2 })).toMatchObject({ layout: 'spotlight', columns: 2 });
    expect(initialView({ layout: 'nope' as never, columns: 99 })).toMatchObject({ layout: 'auto', columns: 0 });
  });
});

describe('exibição', () => {
  it('orderedTiles segue a ordem do estado e põe no fim o que ainda não foi sincronizado', () => {
    const tiles = buildTiles([person('a'), person('b'), person('c')]);
    let s = synced(buildTiles([person('a'), person('b')]));
    s = viewReducer(s, { type: 'move', id: 'camera:b', dir: 'up' });
    expect(ids(orderedTiles(tiles, s))).toEqual(['camera:b', 'camera:a', 'camera:c']);
  });

  it('auto vira destaque quando há tela visível, com ela como principal; senão é grade', () => {
    const noShare = buildTiles([person('a'), person('b')]);
    expect(effectiveLayout(visibleTiles(noShare, synced(noShare)), synced(noShare))).toBe('grid');

    const withShare = buildTiles([person('a'), person('b', { sharing: true })]);
    let s = synced(withShare);
    expect(effectiveLayout(visibleTiles(withShare, s), s)).toBe('grid'); // a tela remota começa oculta
    s = viewReducer(s, { type: 'toggleHidden', id: 'screen:b' });
    const vis = visibleTiles(withShare, s);
    expect(effectiveLayout(vis, s)).toBe('spotlight');
    expect(primaryTile(vis, s)?.id).toBe('screen:b');
  });

  it('layouts explícitos usam o primeiro tile visível como principal', () => {
    const tiles = buildTiles([person('a'), person('b')]);
    let s = synced(tiles);
    s = viewReducer(s, { type: 'layout', layout: 'sidebar' });
    s = viewReducer(s, { type: 'move', id: 'camera:b', dir: 'up' });
    const vis = visibleTiles(tiles, s);
    expect(effectiveLayout(vis, s)).toBe('sidebar');
    expect(primaryTile(vis, s)?.id).toBe('camera:b');
  });

  it('com um único tile visível, destaque e lateral viram grade (nada a separar)', () => {
    const tiles = buildTiles([person('a')]);
    const s = viewReducer(synced(tiles), { type: 'layout', layout: 'spotlight' });
    expect(effectiveLayout(visibleTiles(tiles, s), s)).toBe('grid');
  });
});
