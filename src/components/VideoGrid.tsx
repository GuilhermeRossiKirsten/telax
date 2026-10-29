'use client';

import { useCallback, useState, type CSSProperties } from 'react';
import type { Participant, RemoteStreams } from '@/hooks/use-room';
import type { ViewApi } from '@/hooks/use-view-state';
import {
  applyVolume,
  effectiveLayout,
  orderedTiles,
  stageColumns,
  stageTiles,
  screenIdOf,
  screenKey,
  showsScreen,
  tileLabel,
  visibleTiles,
  voiceKey,
  volumeOf,
  type Tile,
} from '@/lib/view-state';
import { Icon } from './Icon';
import { RemoteAudio } from './RemoteAudio';
import { VideoTile } from './VideoTile';

type Props = {
  participants: Participant[];
  remoteStreams: Record<string, RemoteStreams>;
  localCamera: MediaStream | null;
  /** telas próprias por slot (null = slot livre) */
  localScreens: Array<MediaStream | null>;
  tiles: ViewApi['tiles'];
  view: ViewApi['view'];
  dispatch: ViewApi['dispatch'];
  sinkId?: string;
  onStopShare(slot: number): void;
};

export function VideoGrid({ participants, remoteStreams, localCamera, localScreens, tiles, view, dispatch, sinkId, onStopShare }: Props) {
  const people = new Map(participants.map((p) => [p.id, p]));
  // fontes de som cujo play() o navegador bloqueou (precisa de um gesto); `retry` refaz o play() dentro do clique
  const [blocked, setBlocked] = useState<string[]>([]);
  const [retry, setRetry] = useState(0);
  const onBlocked = useCallback(
    (id: string, isBlocked: boolean) =>
      setBlocked((list) => (isBlocked ? (list.includes(id) ? list : [...list, id]) : list.includes(id) ? list.filter((x) => x !== id) : list)),
    [],
  );

  const cameraOf = (t: Tile) => (t.self ? localCamera : (remoteStreams[t.peerId]?.camera ?? null));
  const screenOf = (t: Tile) => {
    if (t.slot === null) return null;
    return t.self ? (localScreens[t.slot] ?? null) : (remoteStreams[t.peerId]?.screens?.[t.slot] ?? null);
  };

  const sound = (key: string) => ({ muted: view.muted.includes(key), volume: volumeOf(view, key) });
  // mexer no volume de uma fonte silenciada volta a ouvir
  const setVolume = (key: string) => (volume: number) => applyVolume(view, dispatch, key, volume);

  const render = (t: Tile) => {
    const p = people.get(t.peerId);
    if (!p) return null;
    const sid = screenIdOf(t);
    const vKey = voiceKey(t.peerId);
    const sKey = sid ? screenKey(sid) : '';
    return (
      <VideoTile
        key={t.id}
        kind={t.kind}
        name={t.name}
        label={tileLabel(t)}
        isSelf={t.self}
        conn={p.conn}
        camera={cameraOf(t)}
        screen={screenOf(t)}
        slot={t.slot}
        audioOn={p.audio}
        videoOn={p.video}
        showScreen={showsScreen(t, view)}
        selected={view.selected.includes(t.id)}
        voice={sound(vKey)}
        tab={sid ? sound(sKey) : { muted: true, volume: 1 }}
        onToggleVoice={() => dispatch({ type: 'toggleMuted', key: vKey })}
        onVoiceVolume={setVolume(vKey)}
        onToggleTab={() => sid && dispatch({ type: 'toggleMuted', key: sKey })}
        onTabVolume={(v) => sid && setVolume(sKey)(v)}
        onOpenScreen={() => sid && dispatch({ type: 'openScreen', id: sid })}
        onCloseScreen={() => sid && dispatch({ type: 'closeScreen', id: sid })}
        onStopShare={() => t.slot !== null && onStopShare(t.slot)}
        onHide={() => dispatch({ type: 'toggleHidden', id: t.id })}
        onToggleSelect={() => dispatch({ type: 'select', id: t.id })}
      />
    );
  };

  const ordered = orderedTiles(tiles, view);
  const visible = visibleTiles(tiles, view);
  const hidden = ordered.filter((t) => view.hidden.includes(t.id));
  // o tile escondido continua montado, só fora da vista (o som não depende disso: ver RemoteAudio)
  const off = tiles.filter((t) => !visible.includes(t));

  const layout = effectiveLayout(visible, view);
  const featured = layout === 'spotlight' ? stageTiles(visible, view) : [];
  const stage = featured.length > 0 ? (
    // os selecionados (ou as telas abertas) formam, juntos, uma grade grande; todos os demais, participantes inclusive, ficam na faixa embaixo
    <div className="tiles" data-testid="tiles" data-layout="spotlight">
      <div
        className="tiles-primary"
        data-count={featured.length}
        style={{ '--cols': stageColumns(featured.length) } as CSSProperties}
      >
        {featured.map(render)}
      </div>
      <div className="tiles-rest">{visible.filter((t) => !featured.includes(t)).map(render)}</div>
    </div>
  ) : (
    <div className="tiles" data-testid="tiles" data-layout="grid" data-count={Math.min(visible.length, 9)}>
      {visible.map(render)}
    </div>
  );

  const remote = tiles.filter((t) => !t.self);

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
      {/* um <audio> por fonte de som remota (voz de cada pessoa e som da aba de cada tela), num lugar fixo:
          layout, fechar e selecionar não o tocam */}
      <div className="audio-sink" aria-hidden="true">
        {remote
          .filter((t) => t.kind === 'person')
          .map((t) => {
            const key = voiceKey(t.peerId);
            return (
              <RemoteAudio
                key={key}
                id={key}
                stream={cameraOf(t)}
                muted={view.muted.includes(key)}
                volume={volumeOf(view, key)}
                sinkId={sinkId}
                retry={retry}
                onBlocked={onBlocked}
              />
            );
          })}
        {remote
          .filter((t) => t.slot !== null)
          .map((t) => {
            const key = screenKey(screenIdOf(t)!);
            return (
              <RemoteAudio
                key={key}
                id={key}
                // o som da aba só toca enquanto a tela está aberta: fechar a tela para de ouvir também
                stream={showsScreen(t, view) ? screenOf(t) : null}
                muted={view.muted.includes(key)}
                volume={volumeOf(view, key)}
                sinkId={sinkId}
                retry={retry}
                onBlocked={onBlocked}
              />
            );
          })}
      </div>
    </div>
  );
}
