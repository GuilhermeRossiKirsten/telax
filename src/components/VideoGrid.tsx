'use client';

import { useCallback, useState } from 'react';
import type { Participant, RemoteStreams } from '@/hooks/use-room';
import type { ViewApi } from '@/hooks/use-view-state';
import {
  audioKey,
  effectiveLayout,
  orderedTiles,
  primaryTile,
  showsScreen,
  tileLabel,
  visibleTiles,
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
  localScreen: MediaStream | null;
  tiles: ViewApi['tiles'];
  view: ViewApi['view'];
  dispatch: ViewApi['dispatch'];
  sinkId?: string;
};

export function VideoGrid({ participants, remoteStreams, localCamera, localScreen, tiles, view, dispatch, sinkId }: Props) {
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
  const screenOf = (t: Tile) => (t.self ? localScreen : (remoteStreams[t.peerId]?.screen ?? null));

  const sound = (key: string) => ({ muted: view.muted.includes(key), volume: volumeOf(view, key) });
  // mexer no volume de uma fonte silenciada volta a ouvir
  const setVolume = (key: string) => (volume: number) => {
    dispatch({ type: 'volume', key, volume });
    if (volume > 0 && view.muted.includes(key)) dispatch({ type: 'toggleMuted', key });
  };

  const render = (t: Tile) => {
    const p = people.get(t.peerId);
    if (!p) return null;
    const voiceKey = audioKey(t.id, 'camera');
    const tabKey = audioKey(t.id, 'screen');
    return (
      <VideoTile
        key={t.id}
        name={t.name}
        label={tileLabel(t)}
        isSelf={t.self}
        conn={p.conn}
        camera={cameraOf(t)}
        screen={screenOf(t)}
        audioOn={p.audio}
        videoOn={p.video}
        sharing={t.sharing}
        showScreen={showsScreen(t, view)}
        selected={view.selected === t.id}
        voice={sound(voiceKey)}
        tab={sound(tabKey)}
        onToggleVoice={() => dispatch({ type: 'toggleMuted', key: voiceKey })}
        onVoiceVolume={setVolume(voiceKey)}
        onToggleTab={() => dispatch({ type: 'toggleMuted', key: tabKey })}
        onTabVolume={setVolume(tabKey)}
        onOpenScreen={() => dispatch({ type: 'openScreen', id: t.id })}
        onCloseScreen={() => dispatch({ type: 'closeScreen', id: t.id })}
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
  const main = layout === 'spotlight' ? primaryTile(visible, view) : undefined;
  const stage = main ? (
    // selecionado (ou tela aberta) grande; todos os demais, participantes inclusive, na faixa embaixo
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
      {/* um <audio> por fonte de som remota (voz e som da aba), num lugar fixo: layout, fechar e selecionar não o tocam */}
      <div className="audio-sink" aria-hidden="true">
        {tiles
          .filter((t) => !t.self)
          .flatMap((t) => {
            const voiceKey = audioKey(t.id, 'camera');
            const tabKey = audioKey(t.id, 'screen');
            const items = [
              <RemoteAudio
                key={voiceKey}
                id={voiceKey}
                stream={cameraOf(t)}
                muted={view.muted.includes(voiceKey)}
                volume={volumeOf(view, voiceKey)}
                sinkId={sinkId}
                retry={retry}
                onBlocked={onBlocked}
              />,
            ];
            if (t.sharing) {
              items.push(
                <RemoteAudio
                  key={tabKey}
                  id={tabKey}
                  // o som da aba só toca enquanto a tela está aberta: fechar a tela para de ouvir também
                  stream={showsScreen(t, view) ? screenOf(t) : null}
                  muted={view.muted.includes(tabKey)}
                  volume={volumeOf(view, tabKey)}
                  sinkId={sinkId}
                  retry={retry}
                  onBlocked={onBlocked}
                />,
              );
            }
            return items;
          })}
      </div>
    </div>
  );
}
