import { describe, expect, it } from 'vitest';
import { normalizeChat, normalizeName, normalizeRoom, parseMediaState, resolveMediaState, safeDecode } from './validation';

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

describe('parseMediaState (corpo de POST /state)', () => {
  const base = { audio: true, video: false };
  it('só sharing boolean: vira screenSlots 0 ou 1', () => {
    expect(parseMediaState({ ...base, sharing: true })).toEqual({ audio: true, video: false, sharing: true, screenSlots: 1 });
    expect(parseMediaState({ ...base, sharing: false })).toEqual({ audio: true, video: false, sharing: false, screenSlots: 0 });
  });
  it('só screenSlots: deriva sharing', () => {
    expect(parseMediaState({ ...base, screenSlots: 5 })).toEqual({ audio: true, video: false, sharing: true, screenSlots: 5 });
    expect(parseMediaState({ ...base, screenSlots: 0 })).toEqual({ audio: true, video: false, sharing: false, screenSlots: 0 });
  });
  it('inconsistentes: vale screenSlots e sharing é derivado', () => {
    expect(parseMediaState({ ...base, sharing: false, screenSlots: 2 })).toMatchObject({ sharing: true, screenSlots: 2 });
    expect(parseMediaState({ ...base, sharing: true, screenSlots: 0 })).toMatchObject({ sharing: false, screenSlots: 0 });
  });
  it('inválidos viram null', () => {
    for (const screenSlots of [8, -1, 1.5, '3', Number.NaN, null, {}, []]) {
      expect(parseMediaState({ ...base, sharing: false, screenSlots })).toBeNull();
      expect(parseMediaState({ ...base, screenSlots })).toBeNull();
    }
    expect(parseMediaState({ ...base })).toBeNull(); // nem sharing nem screenSlots
    expect(parseMediaState({ ...base, sharing: 'sim' })).toBeNull();
    expect(parseMediaState({ ...base, sharing: 'sim', screenSlots: 1 })).toBeNull();
    expect(parseMediaState({ audio: 'x', video: true, sharing: false })).toBeNull();
    expect(parseMediaState({ audio: true, sharing: false })).toBeNull();
  });
});

describe('resolveMediaState (o que os stores guardam)', () => {
  it('sem screenSlots, deriva de sharing; com screenSlots válido, ele manda', () => {
    expect(resolveMediaState({ audio: true, video: true, sharing: true })).toEqual({ audio: true, video: true, sharing: true, screenSlots: 1 });
    expect(resolveMediaState({ audio: true, video: true, sharing: true, screenSlots: 0 })).toEqual({ audio: true, video: true, sharing: false, screenSlots: 0 });
    expect(resolveMediaState({ audio: true, video: true, sharing: false, screenSlots: 6 })).toEqual({ audio: true, video: true, sharing: true, screenSlots: 6 });
  });
  it('screenSlots inválido cai de volta em sharing', () => {
    expect(resolveMediaState({ audio: true, video: true, sharing: true, screenSlots: 99 })).toMatchObject({ sharing: true, screenSlots: 1 });
    expect(resolveMediaState({ audio: true, video: true, sharing: false, screenSlots: -2 })).toMatchObject({ sharing: false, screenSlots: 0 });
  });
});
