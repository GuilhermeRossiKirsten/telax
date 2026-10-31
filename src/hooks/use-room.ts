'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { parseAdminEvent } from '@/lib/admin-commands';
import type { AdminCommand, RemovalReason } from '@/lib/admin-types';
import { getDeviceId } from '@/lib/device-id';
import { PeerManager, type ConnState, type LocalTracks, type SendQuality } from '@/lib/peer-manager';
import { MAX_SCREENS } from '@/lib/screens';
import {
  computeIsHost,
  roomNoticeFor,
  type LockReason,
  type PasswordResult,
  type RoomNotice,
} from '@/lib/room-password';
import { clearRoomPassword, saveRoomPassword } from '@/lib/room-password-store';
import { createSignalBatcher } from '@/lib/signal-batcher';
import { createSignalingClient, type SignalingStatus } from '@/lib/signaling-client';
import type { ChatPayload, PeerInfo, PeerMediaState, RoomEvent, SignalData } from '@/lib/types';

export type Participant = PeerInfo & { conn: ConnState | 'self' };
/** `screens` tem sempre MAX_SCREENS streams estáveis (um por slot de tela, cada um com [vídeo, som da aba]). */
export type RemoteStreams = { camera: MediaStream; screens: MediaStream[] };
/** Sala trancada por senha: o motivo e, quando há espera, o instante (ms) em que dá para tentar de novo. */
export type RoomLock = { reason: LockReason; until?: number };
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
/** O observador (admin) não envia mídia: nenhuma faixa local, nunca. */
const NO_TRACKS: LocalTracks = { audio: null, camera: null, screens: [] };
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

/**
 * `sendQuality` (opcional, memoize-o): limita bitrate/fps do que este navegador envia; sem ele, nada muda.
 * `observer`: entra como OBSERVADOR (o administrador vendo a sala): só recebe mídia, não aparece na lista nem em tiles
 * e não anuncia estado. `onAdminCommand`: chamado quando o administrador manda um comando a ESTE navegador.
 */
export function useRoom(args: {
  room: string;
  name: string;
  tracks: LocalTracks;
  media: PeerMediaState;
  sendQuality?: SendQuality;
  observer?: boolean;
  onAdminCommand?: (cmd: AdminCommand) => void;
}) {
  const { room, name, media, sendQuality, observer = false, onAdminCommand } = args;
  const tracks = observer ? NO_TRACKS : args.tracks;
  const [status, setStatus] = useState<SignalingStatus>('connecting');
  const [selfId, setSelfId] = useState<string | null>(null);
  const [peers, setPeers] = useState<Record<string, PeerInfo>>({});
  const [conn, setConn] = useState<Record<string, ConnState>>({});
  const [streams, setStreams] = useState<Record<string, RemoteStreams>>({});
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [files, setFiles] = useState<RoomFile[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [adminMessage, setAdminMessage] = useState<{ text: string; at: number } | null>(null);
  const [removed, setRemoved] = useState<{ reason: RemovalReason; detail?: string } | null>(null);
  const [blocked, setBlocked] = useState<{ reason: 'banned' | 'closed'; detail?: string } | null>(null);
  const [locked, setLocked] = useState<RoomLock | null>(null);
  const [roomProtected, setRoomProtected] = useState(false);
  const [roomNotice, setRoomNotice] = useState<RoomNotice | null>(null);

  const clientRef = useRef<ReturnType<typeof createSignalingClient> | null>(null);
  const managerRef = useRef<PeerManager | null>(null);
  const tracksRef = useRef(tracks);
  const mediaRef = useRef(media);
  const qualityRef = useRef(sendQuality);
  const adminCommandRef = useRef(onAdminCommand);
  const observerRef = useRef(observer);
  const selfRef = useRef<string | null>(null);
  const streamRefs = useRef(new Map<string, RemoteStreams>());
  const urlsRef = useRef(new Set<string>());

  useEffect(() => {
    tracksRef.current = tracks;
    managerRef.current?.setLocalTracks(tracks);
  }, [tracks]);

  useEffect(() => {
    qualityRef.current = sendQuality;
    if (sendQuality) managerRef.current?.setSendQuality(sendQuality);
  }, [sendQuality]);

  useEffect(() => {
    adminCommandRef.current = onAdminCommand;
    observerRef.current = observer;
  });

  useEffect(() => {
    mediaRef.current = media;
    // o observador não anuncia mic/câmera/telas (e economiza invocações)
    if (status === 'online' && !observerRef.current) clientRef.current?.setState(media).catch(noop);
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

    // Sinais (sobretudo candidatos ICE) vão em lote: cada requisição à API é uma invocação de função.
    // `client` só é usado na hora de enviar, depois de criado.
    const batcher = createSignalBatcher((items) =>
      items.length === 1 ? client.signal(items[0].to, items[0].data) : client.signals(items),
    );
    const sendSignal = (to: string, data: SignalData) =>
      // depois de desmontar, o lote pendente é descartado: não é falha de rede, então não deve haver nova tentativa
      withRetry(() => batcher.push(to, data).catch((e) => (disposed ? undefined : Promise.reject(e))));

    const client = createSignalingClient({
      room,
      name,
      deviceId: getDeviceId(),
      observer,
      onStatus: (s) => {
        if (disposed) return;
        // sem sinalização (ou sem acesso, para o admin) não há como manter os pares: solta as conexões em vez de deixá-las órfãs
        if (s === 'error' || s === 'blocked' || s === 'removed' || s === 'locked') managerRef.current?.close();
        setStatus(s);
      },
      onEnded: (end) => {
        if (disposed) return;
        if (end.kind === 'locked') {
          setLocked({
            reason: end.reason,
            ...(end.retryAfter !== undefined ? { until: Date.now() + end.retryAfter * 1000 } : {}),
          });
        } else if (end.kind === 'removed') setRemoved({ reason: end.reason, ...(end.detail ? { detail: end.detail } : {}) });
        else setBlocked({ reason: end.reason, ...(end.detail ? { detail: end.detail } : {}) });
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
        setLocked(null);
        setRoomProtected(result.protected);
        setRoomNotice(null);
        setPeers(Object.fromEntries(result.participants.map((p) => [p.id, p])));

        const manager = new PeerManager({
          selfId: result.peerId,
          iceServers: result.iceServers,
          gen: result.gen,
          sendSignal,
          onConnState: (id, s) => !disposed && setConn((c) => ({ ...c, [id]: s })),
          onRemoteTracks: (id, t) => {
            if (disposed) return;
            let entry = streamMap.get(id);
            if (!entry) {
              entry = { camera: new MediaStream(), screens: Array.from({ length: MAX_SCREENS }, () => new MediaStream()) };
              streamMap.set(id, entry);
            }
            syncStream(entry.camera, [t.audio, t.camera]);
            entry.screens.forEach((stream, i) => syncStream(stream, [t.screens[i]?.video, t.screens[i]?.audio]));
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
        if (qualityRef.current) manager.setSendQuality(qualityRef.current);
        managerRef.current = manager;
        for (const p of result.participants) if (p.id !== result.peerId) manager.addPeer(p.id);
        // o servidor assume mic/câmera ligados ao entrar; corrige já com o estado real (o observador não anuncia nada)
        if (!observerRef.current) client.setState(mediaRef.current).catch(noop);
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
          case 'room': {
            // só os participantes recebem; o payload vem do servidor, mas confere o formato antes de usar
            const next = (e.payload as { protected?: unknown } | null)?.protected;
            if (typeof next !== 'boolean') break;
            setRoomProtected(next);
            if (!observerRef.current) setRoomNotice(roomNoticeFor(next, e.from === selfRef.current));
            break;
          }
          case 'restart':
            manager?.restartAll((e.payload as { gen: number }).gen);
            break;
          case 'admin': {
            // só o servidor emite eventos admin (from: 'admin'); o observador (o próprio admin) não precisa deles
            if (e.from !== 'admin' || observerRef.current) break;
            const ev = parseAdminEvent(e.payload);
            if (!ev) break;
            if (ev.kind === 'message') setAdminMessage({ text: ev.text, at: ev.at });
            else adminCommandRef.current?.(ev.what === 'screen' ? { what: 'screen', slot: ev.slot } : { what: ev.what });
            break;
          }
        }
      },
    });

    clientRef.current = client;
    const onPageHide = () => client.leave();
    window.addEventListener('pagehide', onPageHide);
    void client.start();

    return () => {
      disposed = true;
      batcher.dispose();
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
  }, [room, name, observer]);

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

  /** Sala trancada: tenta entrar de novo com a senha digitada (o cliente de sinalização guarda a que funcionar). */
  const retryWithPassword = useCallback((password: string) => {
    void clientRef.current?.retryJoin(password);
  }, []);

  /** Só o anfitrião consegue (o servidor decide); em caso de sucesso a senha fica guardada nesta aba para reentradas. */
  const setRoomPassword = useCallback(
    async (action: 'set' | 'clear', password?: string): Promise<PasswordResult> => {
      const client = clientRef.current;
      if (!client) return { ok: false, error: 'network' };
      const result = await client.roomPassword(action, password);
      if (result.ok) {
        setRoomProtected(result.protected);
        if (action === 'set' && password) saveRoomPassword(room, password);
        else clearRoomPassword(room);
      }
      return result;
    },
    [room],
  );

  const restart = useCallback(async () => {
    try {
      const gen = await clientRef.current?.restart();
      if (gen !== undefined) managerRef.current?.restartAll(gen);
    } catch {
      setError('Não foi possível reiniciar as conexões.');
    }
  }, []);

  // Observadores (o admin) ficam em `peers` para o PeerManager abrir a conexão com eles, mas NÃO são participantes:
  // sem lista, sem tile, sem contagem e sem som de entrada/saída.
  const participants = useMemo<Participant[]>(() => {
    const others = Object.values(peers)
      .filter((p) => p.id !== selfId && !p.observer)
      .sort((a, b) => a.joinedAt - b.joinedAt)
      .map<Participant>((p) => ({ ...p, conn: conn[p.id] ?? 'connecting' }));
    const me = selfId ? peers[selfId] : undefined;
    return me && !observer ? [{ ...me, ...media, conn: 'self' }, ...others] : others;
  }, [peers, conn, selfId, media, observer]);

  // o anfitrião é a pessoa mais antiga (o servidor confere de novo em cada pedido); o observador nunca é
  const isHost = useMemo(() => computeIsHost(Object.values(peers), selfId), [peers, selfId]);

  const observerPresent = useMemo(() => Object.values(peers).some((p) => p.observer && p.id !== selfId), [peers, selfId]);

  return {
    status,
    selfId,
    participants,
    remoteStreams: streams,
    messages,
    files,
    error,
    observerPresent,
    adminMessage,
    dismissAdminMessage: () => setAdminMessage(null),
    removed,
    blocked,
    locked,
    roomProtected,
    isHost,
    roomNotice,
    dismissRoomNotice: () => setRoomNotice(null),
    retryWithPassword,
    setRoomPassword,
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
