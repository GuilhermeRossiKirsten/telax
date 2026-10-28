import { describe, expect, it } from 'vitest';
import { normalizeChat, normalizeName, normalizeRoom, safeDecode } from './validation';

describe('normalizeRoom', () => {
  it('apara espaços e converte para minúsculas', () => {
    expect(normalizeRoom('  Sala A ')).toBe('sala a');
  });
  it('rejeita vazio, longo demais e não-string', () => {
    expect(normalizeRoom('   ')).toBeNull();
    expect(normalizeRoom('x'.repeat(41))).toBeNull();
    expect(normalizeRoom(42)).toBeNull();
  });
  it('aceita exatamente 40 caracteres', () => {
    expect(normalizeRoom('a'.repeat(40))).toBe('a'.repeat(40));
  });
});

describe('normalizeName', () => {
  it('apara espaços mas preserva maiúsculas', () => {
    expect(normalizeName('  Ana ')).toBe('Ana');
  });
  it('rejeita vazio, longo demais e não-string', () => {
    expect(normalizeName('')).toBeNull();
    expect(normalizeName('x'.repeat(41))).toBeNull();
    expect(normalizeName(undefined)).toBeNull();
  });
});

describe('normalizeChat', () => {
  it('apara e aceita até 2000 caracteres', () => {
    expect(normalizeChat('  oi  ')).toBe('oi');
    expect(normalizeChat('x'.repeat(2000))).toBe('x'.repeat(2000));
  });
  it('rejeita vazio, 2001 caracteres e não-string', () => {
    expect(normalizeChat('   ')).toBeNull();
    expect(normalizeChat('x'.repeat(2001))).toBeNull();
    expect(normalizeChat(null)).toBeNull();
  });
});

describe('safeDecode', () => {
  it('decodifica parâmetro de URL com acento e espaço', () => {
    expect(safeDecode('Reuni%C3%A3o%203238')).toBe('Reunião 3238');
  });
  it('devolve a entrada se estiver malformada, sem lançar', () => {
    expect(safeDecode('100%')).toBe('100%');
    expect(safeDecode('%E0%A4%A')).toBe('%E0%A4%A');
  });
  it('não altera texto simples', () => {
    expect(safeDecode('sala-1')).toBe('sala-1');
  });
});
