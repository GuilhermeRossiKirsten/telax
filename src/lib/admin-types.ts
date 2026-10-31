/** Tipos compartilhados do painel de administração (servidor, cliente e telas de admin). */

export const ADMIN_MESSAGE_MAX = 500;
export const ADMIN_REASON_MAX = 200;

/** Contexto da entrada na sala, preenchido pela ROTA (nunca pelo corpo do cliente, exceto `deviceId` validado como UUID). */
export type JoinContext = {
  /** IP do cliente visto pelo servidor (`x-forwarded-for`/`x-real-ip`). */
  ip?: string;
  /** Identificador do dispositivo gerado no navegador (localStorage). Não é endereço MAC: o MAC é inacessível à web. */
  deviceId?: string;
  /** Observador: o administrador vendo a sala. Só a rota de join, com sessão de admin válida, pode pedir isso. */
  observer?: boolean;
};

/** Por que um peer foi removido pelo servidor; volta no `410 gone` para o cliente mostrar o aviso certo. */
export type RemovalReason = 'kicked' | 'banned' | 'closed';

export type AdminPeer = {
  id: string;
  name: string;
  joinedAt: number;
  lastSeen: number;
  audio: boolean;
  video: boolean;
  sharing: boolean;
  screenSlots: number;
  observer: boolean;
  ip: string | null;
  deviceId: string | null;
};

export type AdminRoomSummary = {
  name: string;
  /** participantes de verdade (sem observadores) */
  peerCount: number;
  observerCount: number;
  createdAt: number;
  lastActivity: number;
  closed: boolean;
  closedReason?: string;
  /** a sala exige senha para entrar (só o estado: o admin nunca vê a senha) */
  passwordProtected: boolean;
};

export type AdminRoomDetail = AdminRoomSummary & { peers: AdminPeer[] };

/** Comando do admin para o cliente de UMA pessoa. */
export type AdminCommand = {
  what: 'screens' | 'screen' | 'camera' | 'mic' | 'all';
  /** só com `what: 'screen'`: o slot (0 a 2) da tela a parar */
  slot?: number;
};

/** Payload do evento `admin` (de `from: 'admin'`). Expulsão, banimento e encerramento NÃO são eventos: viram `410 gone` com `reason`. */
export type AdminEventPayload = { kind: 'message'; text: string; at: number } | ({ kind: 'command'; at: number } & AdminCommand);

export type Ban = {
  id: string;
  kind: 'ip' | 'device';
  value: string;
  reason: string;
  createdAt: number;
  bannedName?: string;
  room?: string;
};
