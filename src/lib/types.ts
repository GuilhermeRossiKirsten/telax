export type PeerInfo = {
  id: string;
  name: string;
  joinedAt: number;
  audio: boolean;
  video: boolean;
  /** compartilha alguma tela (`screenSlots > 0`) */
  sharing: boolean;
  /** máscara de bits dos slots de tela ativos (ver src/lib/screens.ts) */
  screenSlots: number;
  /** o administrador observando a sala: recebe mídia, mas não é um participante (sem tile, sem lista, sem som) */
  observer?: boolean;
};

/**
 * Estado de mídia que o cliente informa. `screenSlots` é opcional: quem manda só `sharing` vale como uma tela
 * (slot 0) ou nenhuma; se mandar `screenSlots`, ele manda e `sharing` é derivado dele.
 */
export type PeerMediaState = Pick<PeerInfo, 'audio' | 'video' | 'sharing'> & { screenSlots?: number };

export type RoomEventType = 'join' | 'leave' | 'state' | 'chat' | 'signal' | 'restart' | 'admin';

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
