export type PeerInfo = {
  id: string;
  name: string;
  joinedAt: number;
  audio: boolean;
  video: boolean;
  sharing: boolean;
};

export type PeerMediaState = Pick<PeerInfo, 'audio' | 'video' | 'sharing'>;

export type RoomEventType = 'join' | 'leave' | 'state' | 'chat' | 'signal' | 'restart';

export type RoomEvent = {
  seq: number;
  type: RoomEventType;
  from: string;
  to?: string;
  payload: unknown;
};

export type SignalData = {
  gen: number;
  /** Id da sessão de negociação (criado pelo offerer a cada RTCPeerConnection, ecoado por quem responde). */
  sid?: number;
  /** `reset`: quem só responde recriou o par e pede ao offerer uma nova offer. */
  kind: 'offer' | 'answer' | 'candidate' | 'reset';
  sdp?: string;
  candidate?: RTCIceCandidateInit;
};

export type ChatPayload = { id: string; name: string; text: string; at: number };
