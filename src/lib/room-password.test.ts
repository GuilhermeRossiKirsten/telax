import { describe, expect, it } from 'vitest';
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  computeIsHost,
  countdownSeconds,
  lockFromResponse,
  mapPasswordResult,
  passwordErrorText,
  roomNoticeFor,
  validatePassword,
} from './room-password';

describe('validatePassword', () => {
  it('aceita de 4 a 64 caracteres, sem aparar espaços', () => {
    expect(PASSWORD_MIN).toBe(4);
    expect(PASSWORD_MAX).toBe(64);
    expect(validatePassword('abcd')).toBe(true);
    expect(validatePassword('a'.repeat(64))).toBe(true);
    expect(validatePassword('    ')).toBe(true);
  });
  it('recusa curta, longa e o que não é texto', () => {
    expect(validatePassword('abc')).toBe(false);
    expect(validatePassword('')).toBe(false);
    expect(validatePassword('a'.repeat(65))).toBe(false);
    expect(validatePassword(undefined)).toBe(false);
    expect(validatePassword(1234)).toBe(false);
  });
});

describe('computeIsHost', () => {
  const p = (id: string, joinedAt: number, observer?: boolean) => ({ id, joinedAt, observer });
  it('é a pessoa mais antiga; empate pelo menor id', () => {
    expect(computeIsHost([p('b', 10), p('a', 20)], 'b')).toBe(true);
    expect(computeIsHost([p('b', 10), p('a', 20)], 'a')).toBe(false);
    expect(computeIsHost([p('b', 10), p('a', 10)], 'a')).toBe(true);
    expect(computeIsHost([p('b', 10), p('a', 10)], 'b')).toBe(false);
  });
  it('ignora observadores e funciona sem selfId', () => {
    expect(computeIsHost([p('adm', 1, true), p('x', 5)], 'x')).toBe(true);
    expect(computeIsHost([p('adm', 1, true), p('x', 5)], 'adm')).toBe(false);
    expect(computeIsHost([p('x', 5)], null)).toBe(false);
    expect(computeIsHost([], 'x')).toBe(false);
  });
});

describe('passwordErrorText', () => {
  it('textos em português', () => {
    expect(passwordErrorText('wrong_password')).toBe('Senha incorreta.');
    expect(passwordErrorText('password_required')).toBe('Esta sala exige uma senha.');
    expect(passwordErrorText('too_many_attempts', 42)).toBe('Muitas tentativas. Tente novamente em 42 s.');
    expect(passwordErrorText('too_many_attempts', 0)).toBe('Muitas tentativas. Tente novamente em instantes.');
    expect(passwordErrorText('invalid')).toBe('A senha precisa ter entre 4 e 64 caracteres.');
    expect(passwordErrorText('not_host')).toBe('Só a pessoa mais antiga na sala pode alterar a senha.');
    expect(passwordErrorText('network')).toBe('Não foi possível salvar. Tente de novo.');
  });
});

describe('countdownSeconds', () => {
  it('arredonda para cima e nunca fica negativo', () => {
    expect(countdownSeconds(10_000, 7_500)).toBe(3);
    expect(countdownSeconds(10_000, 10_000)).toBe(0);
    expect(countdownSeconds(10_000, 12_000)).toBe(0);
  });
});

describe('lockFromResponse', () => {
  it('403 com password_required / wrong_password', () => {
    expect(lockFromResponse(403, { error: 'password_required' }, null)).toEqual({ reason: 'password_required' });
    expect(lockFromResponse(403, { error: 'wrong_password' }, null)).toEqual({ reason: 'wrong_password' });
  });
  it('429 usa retryAfter do corpo, ou o cabeçalho Retry-After', () => {
    expect(lockFromResponse(429, { error: 'too_many_attempts', retryAfter: 30 }, '12')).toEqual({
      reason: 'too_many_attempts',
      retryAfter: 30,
    });
    expect(lockFromResponse(429, { error: 'too_many_attempts' }, '12')).toEqual({ reason: 'too_many_attempts', retryAfter: 12 });
    expect(lockFromResponse(429, {}, null)).toEqual({ reason: 'too_many_attempts' });
  });
  it('outros casos não são bloqueio por senha', () => {
    expect(lockFromResponse(403, { error: 'banned' }, null)).toBeNull();
    expect(lockFromResponse(403, { error: 'room_closed' }, null)).toBeNull();
    expect(lockFromResponse(200, {}, null)).toBeNull();
    expect(lockFromResponse(429, null, null)).toEqual({ reason: 'too_many_attempts' });
  });
});

describe('mapPasswordResult', () => {
  it('200 devolve protected', () => {
    expect(mapPasswordResult(200, { protected: true })).toEqual({ ok: true, protected: true });
    expect(mapPasswordResult(200, { protected: false })).toEqual({ ok: true, protected: false });
  });
  it('200 sem protected válido é erro de rede', () => {
    expect(mapPasswordResult(200, {})).toEqual({ ok: false, error: 'network' });
  });
  it('403 not_host e 400 invalid', () => {
    expect(mapPasswordResult(403, { error: 'not_host' })).toEqual({ ok: false, error: 'not_host' });
    expect(mapPasswordResult(400, { error: 'invalid' })).toEqual({ ok: false, error: 'invalid' });
  });
  it('qualquer outra coisa vira network', () => {
    expect(mapPasswordResult(500, null)).toEqual({ ok: false, error: 'network' });
    expect(mapPasswordResult(403, { error: 'outra' })).toEqual({ ok: false, error: 'network' });
  });
});

describe('roomNoticeFor', () => {
  it('só avisa quando foi outra pessoa', () => {
    expect(roomNoticeFor(true, true)).toBeNull();
    expect(roomNoticeFor(false, true)).toBeNull();
    expect(roomNoticeFor(true, false)).toBe('protected');
    expect(roomNoticeFor(false, false)).toBe('unprotected');
  });
});
