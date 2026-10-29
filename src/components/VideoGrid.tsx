'use client';

import { useCallback, useState } from 'react';
import type { Participant, RemoteStreams } from '@/hooks/use-room';
import type { ViewApi } from '@/hooks/use-view-state';
import { effectiveLayout, orderedTiles, primaryTile, tileLabel, visibleTiles, volumeOf, type Tile } from '@/lib/view-state';
import { Icon } from './Icon';
import { RemoteAudio } from './RemoteAudio';
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
  // tiles cujo som o navegador bloqueou (precisa de um gesto); `retry` refaz o play() dentro do clique
  const [blocked, setBlocked] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);
  const onBlocked = useCallback(
    (id: string, isBlocked: boolean) =>
      setBlocked((list) => (isBlocked ? (list.includes(id) ? list : [...list, id]) : list.includes(id) ? list.filter((x) => x !== id) : list)),
    [],
  );

  const streamOf = (t: Tile) =>
    t.self ? (t.kind === 'screen' ? localScreen : localCamera) : (remoteStreams[t.peerId]?.[t.kind] ?? null);

  const render = (t: Tile) => {
    const p = people.get(t.peerId);
    if (!p) return null;
    const stream = streamOf(t);
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
        volume={volumeOf(view, t.id)}
        selected={view.selected === t.id}
        onToggleMuted={() => dispatch({ type: 'toggleMuted', id: t.id })}
        onVolume={(volume) => {
          dispatch({ type: 'volume', id: t.id, volume });
          // mexer no volume de quem está silenciado volta a ouvir
          if (volume > 0 && view.muted.includes(t.id)) dispatch({ type: 'toggleMuted', id: t.id });
        }}
        onClose={() => dispatch({ type: 'toggleHidden', id: t.id })}
        onToggleSelect={() => dispatch({ type: 'select', id: t.id })}
      />
    );
  };

  const ordered = orderedTiles(tiles, view);
  const visible = visibleTiles(tiles, view);
  const hidden = ordered.filter((t) => view.hidden.includes(t.id));
  // o que não está no palco continua montado, só fora da vista (o som não depende disso: ver RemoteAudio)
  const off = tiles.filter((t) => !visible.includes(t));

  const layout = effectiveLayout(visible, view);
  const main = layout === 'spotlight' ? primaryTile(visible, view) : undefined;
  const stage =
    main ? (
      // selecionado (ou tela compartilhada) grande; todos os demais, participantes inclusive, na faixa embaixo
      <div className="tiles" data-testid="tiles" data-layout="spotlight">
        <div className="tiles-primary">{render(main)}</div>
        <div className="tiles-rest">{visible.filter((t) => t !== main).map(render)}</div>
      </div>
    ) : (
      <div className="tiles" data-testid="tiles" data-layout="grid" data-count={Math.min(visible.length, 9)}>
        {visible.map(render)}
      </div>
    );

  return (
    <div className="stage-tiles">
      {hidden.length > 0 && (
        <section className="shelf" aria-label="Telas fechadas">
          <span className="muted small">Fechadas</span>
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
      {blocked.length > 0 && (
        <button className="unblock" onClick={() => setRetry((n) => n + 1)}>
          Clique para ativar o áudio
        </button>
      )}
      {stage}
      <div className="tiles-off" aria-hidden="true">
        {off.map(render)}
      </div>
      {/* um elemento de áudio por tile remoto, num lugar fixo: layout, fechar e selecionar não o tocam */}
      <div className="audio-sink" aria-hidden="true">
        {tiles
          .filter((t) => !t.self)
          .map((t) => (
            <RemoteAudio
              key={t.id}
              id={t.id}
              stream={streamOf(t)}
              muted={view.muted.includes(t.id)}
              volume={volumeOf(view, t.id)}
              sinkId={sinkId}
              retry={retry}
              onBlocked={onBlocked}
            />
          ))}
      </div>
    </div>
  );
}
