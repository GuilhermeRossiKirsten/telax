'use client';

import type { CSSProperties } from 'react';
import type { Participant, RemoteStreams } from '@/hooks/use-room';
import type { ViewApi } from '@/hooks/use-view-state';
import { effectiveLayout, orderedTiles, primaryTile, tileLabel, visibleTiles, type Tile } from '@/lib/view-state';
import { Icon } from './Icon';
import { VideoTile } from './VideoTile';

type Props = {
  participants: Participant[];
  remoteStreams: Record<string, RemoteStreams>;
  localCamera: MediaStream | null;
  localScreen: MediaStream | null;
  tiles: ViewApi['tiles'];
  view: ViewApi['view'];
  dispatch: ViewApi['dispatch'];
  sinkId?: string;
};

export function VideoGrid({ participants, remoteStreams, localCamera, localScreen, tiles, view, dispatch, sinkId }: Props) {
  const people = new Map(participants.map((p) => [p.id, p]));

  const render = (t: Tile) => {
    const p = people.get(t.peerId);
    if (!p) return null;
    const stream = t.self
      ? t.kind === 'screen' ? localScreen : localCamera
      : (remoteStreams[t.peerId]?.[t.kind] ?? null);
    return (
      <VideoTile
        key={t.id}
        stream={stream}
        label={tileLabel(t)}
        name={t.name}
        kind={t.kind}
        isSelf={t.self}
        audioOn={p.audio}
        videoOn={p.video}
        conn={p.conn}
        muted={view.muted.includes(t.id)}
        maximized={view.maximized === t.id}
        sinkId={sinkId}
        onToggleMuted={() => dispatch({ type: 'toggleMuted', id: t.id })}
        onHide={() => dispatch({ type: 'toggleHidden', id: t.id })}
        onToggleMaximize={() => dispatch({ type: 'maximize', id: t.id })}
      />
    );
  };

  const ordered = orderedTiles(tiles, view);
  const visible = visibleTiles(tiles, view);
  const maxTile = view.maximized ? tiles.find((t) => t.id === view.maximized) : undefined;
  const hidden = ordered.filter((t) => view.hidden.includes(t.id));

  const shown = maxTile ? [maxTile] : visible;
  // o que não está no palco continua montado (o áudio não para), só fora da vista
  const off = tiles.filter((t) => !shown.includes(t));

  let stage;
  if (maxTile) {
    stage = (
      <div className="tiles" data-testid="tiles" data-layout="maximized">
        {render(maxTile)}
      </div>
    );
  } else {
    const layout = effectiveLayout(visible, view);
    if (layout === 'grid') {
      const style = view.columns ? ({ '--cols': view.columns } as CSSProperties) : undefined;
      stage = (
        <div className="tiles" data-testid="tiles" data-layout="grid" data-columns={view.columns || undefined} data-count={Math.min(visible.length, 9)} style={style}>
          {visible.map(render)}
        </div>
      );
    } else {
      const main = primaryTile(visible, view);
      stage = (
        <div className="tiles" data-testid="tiles" data-layout={layout}>
          <div className="tiles-primary">{main && render(main)}</div>
          <div className="tiles-rest">{visible.filter((t) => t !== main).map(render)}</div>
        </div>
      );
    }
  }

  return (
    <div className="stage-tiles">
      {hidden.length > 0 && (
        <section className="shelf" aria-label="Telas ocultas">
          <span className="muted small">Ocultas</span>
          {hidden.map((t) => (
            <button
              key={t.id}
              className="ghost"
              aria-label={`Mostrar ${tileLabel(t)}`}
              onClick={() => dispatch({ type: 'toggleHidden', id: t.id })}
            >
              <Icon name="eye" size={14} /> {tileLabel(t)}
            </button>
          ))}
        </section>
      )}
      {stage}
      <div className="tiles-off" aria-hidden="true">
        {off.map(render)}
      </div>
    </div>
  );
}
