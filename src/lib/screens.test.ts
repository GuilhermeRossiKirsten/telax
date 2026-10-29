import { describe, expect, it } from 'vitest';
import { FULL_SLOT_MASK, MAX_SCREENS, isSlotMask, maskFromSlots, screenLabel, screenSound, slotsFromMask } from './screens';

describe('slots de tela compartilhada', () => {
  it('máscara de bits <-> lista de slots', () => {
    expect(MAX_SCREENS).toBe(3);
    expect(FULL_SLOT_MASK).toBe(0b111);
    expect(slotsFromMask(0)).toEqual([]);
    expect(slotsFromMask(0b101)).toEqual([0, 2]);
    expect(slotsFromMask(0b111)).toEqual([0, 1, 2]);
    expect(maskFromSlots([])).toBe(0);
    expect(maskFromSlots([2, 0])).toBe(0b101);
  });
  it('ignora slots fora do limite e repetidos', () => {
    expect(maskFromSlots([0, 0, 5, -1, 1.5])).toBe(0b001);
    expect(slotsFromMask(0b1111)).toEqual([0, 1, 2]);
  });
  it('valida a máscara recebida da rede', () => {
    expect(isSlotMask(0)).toBe(true);
    expect(isSlotMask(7)).toBe(true);
    expect(isSlotMask(8)).toBe(false);
    expect(isSlotMask(-1)).toBe(false);
    expect(isSlotMask(1.5)).toBe(false);
    expect(isSlotMask('3')).toBe(false);
    expect(isSlotMask(Number.NaN)).toBe(false);
  });
  it('rótulos: o slot 0 é "tela", os outros levam o número', () => {
    expect(screenLabel('Ana', 0)).toBe('Tela de Ana');
    expect(screenLabel('Ana', 1)).toBe('Tela 2 de Ana');
    expect(screenSound('Ana', 0)).toBe('som da aba de Ana');
    expect(screenSound('Ana', 2)).toBe('som da aba 3 de Ana');
  });
});

describe('palavra da tela nos botões', () => {
  it('"tela" no slot 0 e "tela N" nos outros', async () => {
    const { screenWord } = await import('./screens');
    expect(screenWord(0)).toBe('tela');
    expect(screenWord(2)).toBe('tela 3');
  });
});
