'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { PeerManager, type ConnState } from '@/lib/peer-manager';
import { createSignalingClient, type SignalingStatus } from '@/lib/signaling-client';
import type { ChatPayload, PeerInfo, PeerMediaState, RoomEvent, SignalData } from '@/lib/types';
import type { LocalTracks } from './use-local-media';

export type Participant = PeerInfo & { conn: ConnState | 'self' };
export type RemoteStreams = { camera: MediaStream; screen: MediaStream };
export type ChatMessage = { id: string; from: string; name: string; text: string; at: number };
export type RoomFile = {
  id: string;
  peerId: string;
  name: string;
  size: number;
  url: string;
  direction: 'in' | 'out';
  progress: number;
  status: 'sending' | 'done' | 'error';
};

const noop = () => {};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Reenvia um sinal algumas vezes: uma offer perdida deixaria o par parado sem nunca falhar. */
async function withRetry(fn: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await fn();
    } catch (e) {
      if (attempt === 3) throw e;
      await sleep(500 * attempt);
    }
  }
}

function syncStream(stream: MediaStream, wanted: Array<MediaStreamTrack | undefined>) {
  const keep = wanted.filter((t): t is MediaStreamTrack => !!t);
  for (const t of stream.getTracks()) if (!keep.includes(t)) stream.removeTrack(t);
  for (const t of keep) if (!stream.getTracks().includes(t)) stream.addTrack(t);
}

export function useRoom(args: { room: string; name: string; tracks: LocalTracks; media: PeerMediaState }) {
  const { room, name, tracks, media } = args;
  const [status, setStatus] = useState<SignalingStatus>('connecting');
  const [selfId, setSelfId] = useState<string | null>(null);
  const [peers, setPeers] = useState<Record<string, PeerInfo>>({});
  const [conn, setConn] = useState<Record<string, ConnState>>({});
  const [streams, setStreams] = useState<Record<string, RemoteStreams>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [files, setFiles] = useState<RoomFile[]>([]);
  const [error, setError] = useState<string | null>(null);

  const clientRef = useRef<ReturnType<typeof createSignalingClient> | null>(null);
  const managerRef = useRef<PeerManager | null>(null);
  const tracksRef = useRef(tracks);
  const mediaRef = useRef(media);
  const selfRef = useRef<string | null>(null);
  const streamRefs = useRef(new Map<string, RemoteStreams>());
  const urlsRef = useRef(new Set<string>());

  useEffect(() => {
    tracksRef.current = tracks;
    managerRef.current?.setLocalTracks(tracks);
  }, [tracks]);

  useEffect(() => {
    mediaRef.current = media;
    if (status === 'online') clientRef.current?.setState(media).catch(noop);
  }, [media, status]);

  useEffect(() => {
    let disposed = false;
    const urls = urlsRef.current;
    const streamMap = streamRefs.current;

    const dropRemote = (peerId: string) => {
      streamMap.delete(peerId);
      setStreams((s) => omit(s, peerId));
      setConn((c) => omit(c, peerId));
    };

    const client = createSignalingClient({
      room,
      name,
      onStatus: (s) => {
        if (disposed) return;
        // sem sinalização não há como manter os pares: solta as conexões em vez de deixá-las órfãs
        if (s === 'error') managerRef.current?.close();
        setStatus(s);
      },

      onJoined: (result, isRejoin) => {
        if (disposed) return;
        managerRef.current?.close();
        if (isRejoin) {
          streamMap.clear();
          setStreams({});
          setConn({});
        }
        selfRef.current = result.peerId;
        setSelfId(result.peerId);
        setPeers(Object.fromEntries(result.participants.map((p) => [p.id, p])));

        const manager = new PeerManager({
          selfId: result.peerId,
          iceServers: result.iceServers,
          gen: result.gen,
          sendSignal: (to, data) => withRetry(() => client.signal(to, data)),
          onConnState: (id, s) => !disposed && setConn((c) => ({ ...c, [id]: s })),
          onRemoteTracks: (id, t) => {
            if (disposed) return;
            let entry = streamMap.get(id);
            if (!entry) {
              entry = { camera: new MediaStream(), screen: new MediaStream() };
              streamMap.set(id, entry);
            }
            syncStream(entry.camera, [t.audio, t.camera]);
            syncStream(entry.screen, [t.screen, t.screenAudio]);
            const shared = entry;
            setStreams((s) => ({ ...s, [id]: { ...shared } }));
          },
          onFile: (peerId, file) => {
            if (disposed) return;
            const url = URL.createObjectURL(file.blob);
            urls.add(url);
            setFiles((f) => [
              ...f,
              {
                id: file.header.id,
                peerId,
                name: file.header.name,
                size: file.header.size,
                url,
                direction: 'in',
                progress: 1,
                status: 'done',
              },
            ]);
          },
        });
        manager.setLocalTracks(tracksRef.current);
        managerRef.current = manager;
        for (const p of result.participants) if (p.id !== result.peerId) manager.addPeer(p.id);
        // o servidor assume mic/câmera ligados ao entrar; corrige já com o estado real
        client.setState(mediaRef.current).catch(noop);
      },

      onEvent: (e: RoomEvent) => {
        if (disposed) return;
        const manager = managerRef.current;
        switch (e.type) {
          case 'join': {
            const info = e.payload as PeerInfo;
            setPeers((p) => ({ ...p, [info.id]: info }));
            manager?.addPeer(info.id);
            break;
          }
          case 'leave':
            setPeers((p) => omit(p, e.from));
            manager?.removePeer(e.from);
            dropRemote(e.from);
            break;
          case 'state':
            setPeers((p) => (p[e.from] ? { ...p, [e.from]: { ...p[e.from], ...(e.payload as PeerMediaState) } } : p));
            break;
          case 'chat': {
            const m = e.payload as ChatPayload;
            setMessages((list) => (list.some((x) => x.id === m.id) ? list : [...list, { ...m, from: e.from }]));
            break;
          }
          case 'signal':
            manager?.handleSignal(e.from, e.payload as SignalData).catch(noop);
            break;
          case 'restart':
            manager?.restartAll((e.payload as { gen: number }).gen);
            break;
        }
      },
    });

    clientRef.current = client;
    const onPageHide = () => client.leave();
    window.addEventListener('pagehide', onPageHide);
    void client.start();

    return () => {
      disposed = true;
      window.removeEventListener('pagehide', onPageHide);
      client.leave();
      client.stop();
      managerRef.current?.close();
      managerRef.current = null;
      clientRef.current = null;
      selfRef.current = null;
      streamMap.clear();
      for (const url of urls) URL.revokeObjectURL(url);
      urls.clear();
    };
  }, [room, name]);

  const sendChat = useCallback(
    (text: string) => {
      const client = clientRef.current;
      const from = selfRef.current;
      if (!client || !from || !text.trim()) return;
      client.chat(text).then(
        () => setMessages((list) => [...list, { id: crypto.randomUUID(), from, name, text: text.trim(), at: Date.now() }]),
        () => setError('Mensagem não enviada.'),
      );
    },
    [name],
  );

  const sendFile = useCallback(async (file: File) => {
    const manager = managerRef.current;
    const from = selfRef.current;
    if (!manager || !from) return;
    const id = crypto.randomUUID();
    const url = URL.createObjectURL(file);
    urlsRef.current.add(url);
    const patch = (p: Partial<RoomFile>) => setFiles((list) => list.map((f) => (f.id === id ? { ...f, ...p } : f)));
    setFiles((list) => [
      ...list,
      { id, peerId: from, name: file.name, size: file.size, url, direction: 'out', progress: 0, status: 'sending' },
    ]);
    const sent = new Map<string, number>();
    try {
      await manager.sendFileToAll(file, (peerId, bytes) => {
        sent.set(peerId, bytes);
        patch({ progress: file.size === 0 ? 1 : Math.min(...sent.values()) / file.size });
      });
      patch({ progress: 1, status: 'done' });
    } catch (e) {
      patch({ status: 'error' });
      setError(
        e instanceof Error && e.message === 'file_too_large'
          ? 'Arquivo acima de 25 MB.'
          : 'Ninguém conectado para receber o arquivo.',
      );
    }
  }, []);

  const restart = useCallback(async () => {
    try {
      const gen = await clientRef.current?.restart();
      if (gen !== undefined) managerRef.current?.restartAll(gen);
    } catch {
      setError('Não foi possível reiniciar as conexões.');
    }
  }, []);

  const participants = useMemo<Participant[]>(() => {
    const others = Object.values(peers)
      .filter((p) => p.id !== selfId)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map<Participant>((p) => ({ ...p, conn: conn[p.id] ?? 'connecting' }));
    const me = selfId ? peers[selfId] : undefined;
    return me ? [{ ...me, ...media, conn: 'self' }, ...others] : others;
  }, [peers, conn, selfId, media]);

  return {
    status,
    selfId,
    participants,
    remoteStreams: streams,
    messages,
    files,
    error,
    dismissError: () => setError(null),
    sendChat,
    sendFile,
    restart,
  };
}

function omit<T>(obj: Record<string, T>, key: string): Record<string, T> {
  if (!(key in obj)) return obj;
  const { [key]: _removed, ...rest } = obj;
  return rest;
}
