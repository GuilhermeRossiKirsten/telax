import { describe, expect, it } from 'vitest';
import { hashPassword, validatePassword, verifyPassword } from './room-password';

describe('hash de senha da sala', () => {
  it('guarda scrypt com salt aleatório: a mesma senha gera registros diferentes e nada em texto puro', async () => {
    const a = await hashPassword('segredo123');
    const b = await hashPassword('segredo123');
    expect(a.salt).not.toBe(b.salt);
    expect(a.hash).not.toBe(b.hash);
    expect(a.params).toEqual({ N: 16384, r: 8, p: 1, keylen: 64 });
    expect(Buffer.from(a.salt, 'base64')).toHaveLength(16);
    expect(Buffer.from(a.hash, 'base64')).toHaveLength(64);
    expect(JSON.stringify(a)).not.toContain('segredo123');
  });

  it('verifica a senha certa e recusa a errada (inclusive diferença só de caixa ou espaço)', async () => {
    const rec = await hashPassword('Segredo 123');
    expect(await verifyPassword('Segredo 123', rec)).toBe(true);
    expect(await verifyPassword('segredo 123', rec)).toBe(false);
    expect(await verifyPassword('Segredo 123 ', rec)).toBe(false);
    expect(await verifyPassword('', rec)).toBe(false);
  });

  it('registro corrompido nunca lança: só recusa', async () => {
    const rec = await hashPassword('segredo123');
    expect(await verifyPassword('segredo123', { ...rec, hash: 'curto' })).toBe(false);
    expect(await verifyPassword('segredo123', { ...rec, salt: '' })).toBe(false);
    expect(await verifyPassword('segredo123', { ...rec, params: { N: 3, r: 8, p: 1, keylen: 64 } })).toBe(false);
    expect(await verifyPassword('segredo123', null as never)).toBe(false);
    expect(await verifyPassword('segredo123', {} as never)).toBe(false);
    expect(await verifyPassword(42 as never, rec)).toBe(false);
  });

  it('valida comprimento 4..64 e tipo, sem aparar espaços', () => {
    expect(validatePassword('abcd')).toBe('abcd');
    expect(validatePassword('a'.repeat(64))).toBe('a'.repeat(64));
    expect(validatePassword('  ab  ')).toBe('  ab  ');
    expect(validatePassword('abc')).toBeNull();
    expect(validatePassword('a'.repeat(65))).toBeNull();
    expect(validatePassword(undefined)).toBeNull();
    expect(validatePassword(1234)).toBeNull();
    expect(validatePassword(null)).toBeNull();
  });
});
