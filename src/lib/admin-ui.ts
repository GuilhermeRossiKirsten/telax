/** Lógica pura da tela de administração: formatação, ordenação, validação e mensagens de erro (testada sem navegador). */

import type { AdminPeer, AdminRoomSummary, Ban } from './admin-types';
import { ADMIN_MESSAGE_MAX, ADMIN_REASON_MAX } from './admin-types';
import { slotsFromMask } from './screens';

export const MAC_NOTICE =
  'O endereço MAC não é acessível por navegadores. O bloqueio usa IP e o identificador do dispositivo; ' +
  'IP compartilhado pode bloquear inocentes e VPN ou limpar os dados do navegador contornam o bloqueio.';

/** "atualizado há 7 s": o indicador de frescor da lista de salas. `null` = ainda sem resposta. */
export function updatedLabel(secondsAgo: number | null): string {
  if (secondsAgo === null) return 'carregando…';
  if (secondsAgo < 2) return 'atualizado agora';
  if (secondsAgo < 60) return `atualizado há ${Math.floor(secondsAgo)} s`;
  return `atualizado há ${Math.floor(secondsAgo / 60)} min`;
}

/** "há 5 min": quando algo aconteceu. Relógio do servidor adiantado não vira "daqui a". */
export function formatWhen(ts: number, now: number): string {
  if (!ts) return '—';
  const diff = Math.max(0, now - ts);
  if (diff < 30_000) return 'agora';
  if (diff < 3_600_000) return `há ${Math.max(1, Math.floor(diff / 60_000))} min`;
  if (diff < 86_400_000) return `há ${Math.floor(diff / 3_600_000)} h`;
  return `há ${Math.floor(diff / 86_400_000)} d`;
}

/** Identificador do dispositivo abreviado (o inteiro só atrapalha a tabela). */
export function shortDevice(id: string | null | undefined): string {
  if (!id) return '—';
  return id.length > 8 ? `${id.slice(0, 8)}…` : id;
}

export function mediaSummary(p: Pick<AdminPeer, 'audio' | 'video' | 'screenSlots'>): { mic: string; cam: string; screens: string } {
  const n = slotsFromMask(p.screenSlots).length;
  return {
    mic: p.audio ? 'ligado' : 'mutado',
    cam: p.video ? 'ligada' : 'desligada',
    screens: n === 0 ? 'nenhuma' : n === 1 ? '1 tela' : `${n} telas`,
  };
}

/** Abertas primeiro (mais gente, depois atividade recente), fechadas por último; o nome desempata para a ordem não pular. */
export function sortRooms(rooms: ReadonlyArray<AdminRoomSummary>): AdminRoomSummary[] {
  return [...rooms].sort(
    (a, b) =>
      Number(a.closed) - Number(b.closed) ||
      b.peerCount - a.peerCount ||
      b.lastActivity - a.lastActivity ||
      a.name.localeCompare(b.name),
  );
}

/** Intervalo da atualização automática; com a aba oculta não consulta (cada consulta é uma invocação da Vercel). */
export function pollIntervalMs(hidden: boolean, base = 5000): number | null {
  return hidden ? null : base;
}

/** Mensagem de erro de um texto livre (mensagem ao grupo), ou `null` se está ok. */
export function validateText(text: string, max: number = ADMIN_MESSAGE_MAX): string | null {
  const t = text.trim();
  if (t.length === 0) return 'Escreva a mensagem.';
  if (t.length > max) return `Máximo de ${max} caracteres.`;
  return null;
}

export function normalizeReason(reason: string): string | undefined {
  const t = reason.trim().slice(0, ADMIN_REASON_MAX);
  return t.length > 0 ? t : undefined;
}

/** Texto amigável para um erro de API; nunca mostra o corpo cru da resposta. */
export function friendlyError(status: number, code?: string): string {
  if (status === 0) return 'Falha de conexão. Verifique a internet e tente de novo.';
  if (status === 401) return 'Sua sessão expirou. Entre novamente.';
  if (status === 403) return 'Sem permissão para esta ação.';
  if (status === 404) return 'Sala ou pessoa não encontrada (pode já ter saído).';
  if (status === 400) return 'Dados inválidos. Confira os campos.';
  if (status === 503 && code === 'admin_disabled') return 'O painel de administração está desativado neste servidor.';
  return 'Algo deu errado. Tente de novo em instantes.';
}

/** Traduz o `?error=` da volta do login. Valores desconhecidos não são exibidos (nada da URL entra na tela cru). */
export function loginErrorMessage(code: string | null | undefined): string | null {
  switch (code) {
    case 'forbidden':
      return 'Esta conta do GitHub não tem acesso ao painel.';
    case 'state':
      return 'A verificação do login falhou ou expirou. Tente entrar de novo.';
    case 'github':
      return 'Não foi possível falar com o GitHub agora. Tente entrar de novo.';
    default:
      return null;
  }
}

export const banKindLabel = (b: Pick<Ban, 'kind'>) => (b.kind === 'ip' ? 'IP' : 'Dispositivo');

/** Segundos inteiros desde `ts` (`null` se ainda não houve atualização). */
export function secondsSince(ts: number | null, now: number): number | null {
  return ts === null ? null : Math.max(0, Math.floor((now - ts) / 1000));
}
