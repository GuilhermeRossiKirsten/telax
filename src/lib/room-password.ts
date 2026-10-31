/** Lógica pura da senha da sala no cliente: validação, quem é o anfitrião, textos e leitura das respostas HTTP. */

export const PASSWORD_MIN = 4;
export const PASSWORD_MAX = 64;

export type LockReason = 'password_required' | 'wrong_password' | 'too_many_attempts';
export type PasswordError = 'not_host' | 'invalid' | 'network';
export type PasswordResult = { ok: true; protected: boolean } | { ok: false; error: PasswordError };
export type RoomNotice = 'protected' | 'unprotected';

/** 4 a 64 caracteres, sem normalização (espaços valem), igual ao servidor. */
export function validatePassword(value: unknown): value is string {
  return typeof value === 'string' && value.length >= PASSWORD_MIN && value.length <= PASSWORD_MAX;
}

/** O anfitrião é a pessoa mais antiga da sala (menor `joinedAt`; empate pelo menor id), sem contar observadores. */
export function computeIsHost(
  participants: ReadonlyArray<{ id: string; joinedAt: number; observer?: boolean }>,
  selfId: string | null,
): boolean {
  if (!selfId) return false;
  let host: { id: string; joinedAt: number } | undefined;
  for (const p of participants) {
    if (p.observer) continue;
    if (!host || p.joinedAt < host.joinedAt || (p.joinedAt === host.joinedAt && p.id < host.id)) host = p;
  }
  return host?.id === selfId;
}

export function passwordErrorText(reason: LockReason | PasswordError, secondsLeft = 0): string {
  switch (reason) {
    case 'wrong_password':
      return 'Senha incorreta.';
    case 'password_required':
      return 'Esta sala exige uma senha.';
    case 'too_many_attempts':
      return secondsLeft > 0
        ? `Muitas tentativas. Tente novamente em ${secondsLeft} s.`
        : 'Muitas tentativas. Tente novamente em instantes.';
    case 'invalid':
      return `A senha precisa ter entre ${PASSWORD_MIN} e ${PASSWORD_MAX} caracteres.`;
    case 'not_host':
      return 'Só a pessoa mais antiga na sala pode alterar a senha.';
    case 'network':
      return 'Não foi possível salvar. Tente de novo.';
  }
}

/** Segundos que faltam até `until` (arredonda para cima; nunca negativo). */
export function countdownSeconds(until: number, now: number): number {
  return Math.max(0, Math.ceil((until - now) / 1000));
}

const asRecord = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? (v as Record<string, unknown>) : {});

/** Resposta do `join` que é um bloqueio por senha (e não banimento nem sala encerrada)? */
export function lockFromResponse(
  status: number,
  body: unknown,
  retryAfterHeader: string | null,
): { reason: LockReason; retryAfter?: number } | null {
  const b = asRecord(body);
  if (status === 403 && (b.error === 'password_required' || b.error === 'wrong_password')) return { reason: b.error };
  if (status === 429) {
    const fromBody = typeof b.retryAfter === 'number' && Number.isFinite(b.retryAfter) ? b.retryAfter : undefined;
    const header = retryAfterHeader ? Number(retryAfterHeader) : NaN;
    const retryAfter = fromBody ?? (Number.isFinite(header) && header >= 0 ? header : undefined);
    return retryAfter === undefined ? { reason: 'too_many_attempts' } : { reason: 'too_many_attempts', retryAfter };
  }
  return null;
}

/** Resposta de `POST /password` (definir/remover). */
export function mapPasswordResult(status: number, body: unknown): PasswordResult {
  const b = asRecord(body);
  if (status === 200 && typeof b.protected === 'boolean') return { ok: true, protected: b.protected };
  if (status === 403 && b.error === 'not_host') return { ok: false, error: 'not_host' };
  if (status === 400 && b.error === 'invalid') return { ok: false, error: 'invalid' };
  return { ok: false, error: 'network' };
}

/** Aviso na sala quando a senha mudou; a pessoa que mudou já sabe e não recebe aviso. */
export function roomNoticeFor(isProtected: boolean, fromSelf: boolean): RoomNotice | null {
  if (fromSelf) return null;
  return isProtected ? 'protected' : 'unprotected';
}
