'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useDevices } from '@/hooks/use-devices';
import { useLocalMedia } from '@/hooks/use-local-media';
import { useRoom } from '@/hooks/use-room';
import { useViewState } from '@/hooks/use-view-state';
import { ControlBar } from './ControlBar';
import { Icon } from './Icon';
import { SettingsDialog } from './SettingsDialog';
import { SidePanel, type Tab } from './SidePanel';
import { VideoGrid } from './VideoGrid';

const RESTART_FEEDBACK_MS = 4000;

export function RoomView({ room, name }: { room: string; name: string }) {
  const router = useRouter();
  const local = useLocalMedia();
  const media = useMemo(
    () => ({ audio: local.micOn, video: local.camOn, sharing: local.sharing }),
    [local.micOn, local.camOn, local.sharing],
  );
  const r = useRoom({ room, name, tracks: local.tracks, media });
  const screens = useViewState(r.participants);
  const devices = useDevices();
  const [settingsOpen, setSettingsOpen] = useState(false);

  // os nomes dos dispositivos só aparecem depois da permissão de mídia; e a escolha salva vale assim que a câmera existe
  const { refresh: refreshDevices } = devices;
  useEffect(() => {
    if (local.camera) void refreshDevices();
  }, [local.camera, refreshDevices]);
  const { micId, outputId } = devices;
  const { selectMic, camera: cameraStream } = local;
  useEffect(() => {
    // roda de novo quando o stream da câmera aparece (a escolha salva só vale depois dele); selectMic ignora repetições
    if (micId && cameraStream) void selectMic(micId);
  }, [micId, cameraStream, selectMic]);

  const [panelOpen, setPanelOpen] = useState(false);
  const [tab, setTab] = useState<Tab>('participants');
  const [restarting, setRestarting] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (window.matchMedia('(min-width: 900px)').matches) setPanelOpen(true);
  }, []);

  const { stopAll } = local;
  const ended = r.status === 'full' || r.status === 'error';
  useEffect(() => {
    if (ended) stopAll();
  }, [ended, stopAll]);

  const nameOf = useCallback((id: string) => r.participants.find((p) => p.id === id)?.name ?? 'alguém', [r.participants]);

  async function restart() {
    setRestarting(true);
    await r.restart();
    setTimeout(() => setRestarting(false), RESTART_FEEDBACK_MS);
  }

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(`${location.origin}/?room=${encodeURIComponent(room)}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      /* sem permissão de área de transferência: o botão apenas não confirma */
    }
  }

  if (r.status === 'full') {
    return (
      <main className="join-page">
        <div className="join-card">
          <h1 className="brand">
            tela<span>X</span>
          </h1>
          <p role="alert">Sala cheia: &quot;{room}&quot; já tem 8 participantes.</p>
          <Link className="primary link-btn" href={`/?room=${encodeURIComponent(room)}`}>
            Voltar
          </Link>
        </div>
      </main>
    );
  }

  if (r.status === 'error') {
    return (
      <main className="join-page">
        <div className="join-card">
          <h1 className="brand">
            tela<span>X</span>
          </h1>
          <p role="alert">Não foi possível manter a sala &quot;{room}&quot;.</p>
          <p className="muted">
            O servidor deixou de reconhecer você várias vezes seguidas. Isso costuma acontecer em hospedagem
            serverless (como a Vercel), onde cada requisição pode cair em uma instância diferente que não
            guarda a sala.
          </p>
          <button className="primary" onClick={() => location.reload()}>
            Tentar novamente
          </button>
          <Link className="ghost link-btn" href={`/?room=${encodeURIComponent(room)}`}>
            Voltar
          </Link>
        </div>
      </main>
    );
  }

  return (
    <div className="room">
      <header className="topbar">
        <span className="brand small">
          tela<span>X</span>
        </span>
        <span className="room-name" title={room}>
          {room}
        </span>
        <span className="muted">{r.participants.length} na sala</span>
        <button className="ghost" onClick={copyLink} aria-label="Copiar link da sala">
          <Icon name="link" size={16} /> {copied ? 'Link copiado' : 'Copiar link'}
        </button>
      </header>

      {r.status === 'reconnecting' && (
        <div className="banner warn" role="status">
          Reconectando ao servidor… as chamadas já estabelecidas continuam.
        </div>
      )}
      {local.error && (
        <div className="banner" role="status">
          {local.error}
        </div>
      )}
      {r.error && (
        <div className="banner warn" role="alert">
          {r.error} <button className="ghost" onClick={r.dismissError}>Fechar</button>
        </div>
      )}

      <div className={`stage ${panelOpen ? 'with-panel' : ''}`}>
        <main className="stage-main">
          {r.selfId ? (
            <VideoGrid
              participants={r.participants}
              remoteStreams={r.remoteStreams}
              localCamera={local.camera}
              localScreen={local.screen}
              tiles={screens.tiles}
              view={screens.view}
              dispatch={screens.dispatch}
              sinkId={outputId}
            />
          ) : (
            <p className="muted center">Entrando na sala…</p>
          )}
        </main>
        {panelOpen && (
          <SidePanel
            tab={tab}
            onTab={setTab}
            participants={r.participants}
            messages={r.messages}
            files={r.files}
            selfId={r.selfId}
            nameOf={nameOf}
            onSendChat={r.sendChat}
            onSendFile={r.sendFile}
          />
        )}
      </div>

      <ControlBar
        micOn={local.micOn}
        camOn={local.camOn}
        sharing={local.sharing}
        sharingAudio={local.sharingAudio}
        hasMic={local.hasMic}
        hasCam={local.hasCam}
        panelOpen={panelOpen}
        restarting={restarting}
        onMic={local.toggleMic}
        onCam={local.toggleCam}
        onScreen={local.toggleScreen}
        onPanel={() => setPanelOpen((o) => !o)}
        onSettings={() => setSettingsOpen(true)}
        onRestart={restart}
        onLeave={() => router.push('/')}
      />
      <SettingsDialog open={settingsOpen} onClose={() => setSettingsOpen(false)} devices={devices} />
    </div>
  );
}
