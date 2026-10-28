'use client';

import type { Participant, RemoteStreams } from '@/hooks/use-room';
import { VideoTile } from './VideoTile';

type Props = {
  participants: Participant[];
  remoteStreams: Record<string, RemoteStreams>;
  localCamera: MediaStream | null;
  localScreen: MediaStream | null;
};

export function VideoGrid({ participants, remoteStreams, localCamera, localScreen }: Props) {
  const camera = (p: Participant) => (
    <VideoTile
      key={`cam-${p.id}`}
      stream={p.conn === 'self' ? localCamera : (remoteStreams[p.id]?.camera ?? null)}
      name={p.name}
      isSelf={p.conn === 'self'}
      audioOn={p.audio}
      videoOn={p.video}
      conn={p.conn}
    />
  );
  const screen = (p: Participant) => (
    <VideoTile
      key={`scr-${p.id}`}
      kind="screen"
      stream={p.conn === 'self' ? localScreen : (remoteStreams[p.id]?.screen ?? null)}
      name={p.name}
      isSelf={p.conn === 'self'}
      conn={p.conn}
    />
  );

  const sharers = participants.filter((p) => p.sharing);
  if (sharers.length === 0) {
    return (
      <div className="grid" data-count={Math.min(participants.length, 9)}>
        {participants.map(camera)}
      </div>
    );
  }
  return (
    <div className="spotlight">
      <div className="spotlight-main">{screen(sharers[0])}</div>
      <div className="spotlight-strip">
        {participants.map(camera)}
        {sharers.slice(1).map(screen)}
      </div>
    </div>
  );
}
