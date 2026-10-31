import { describe, expect, it } from 'vitest';
import { clearRoomPassword, loadRoomPassword, saveRoomPassword } from './room-password-store';

const memory = () => {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
    keys: () => [...m.keys()],
  };
};

describe('senha da sala guardada só nesta aba', () => {
  it('guarda e lê por sala; o nome é aparado e salas diferentes não se misturam', () => {
    const s = memory();
    saveRoomPassword('  Sala A ', 'segredo', s);
    expect(loadRoomPassword('Sala A', s)).toBe('segredo');
    expect(loadRoomPassword('Sala B', s)).toBeUndefined();
    expect(s.keys()).toEqual(['telax:room-pw:Sala A']);
  });

  it('não guarda senha vazia; limpar apaga', () => {
    const s = memory();
    saveRoomPassword('x', '', s);
    expect(loadRoomPassword('x', s)).toBeUndefined();
    saveRoomPassword('x', 'abcd', s);
    clearRoomPassword('x', s);
    expect(loadRoomPassword('x', s)).toBeUndefined();
  });

  it('armazenamento que lança (janela privada, bloqueado) não derruba nada', () => {
    const boom = {
      getItem: () => { throw new Error('bloqueado'); },
      setItem: () => { throw new Error('cheio'); },
      removeItem: () => { throw new Error('bloqueado'); },
    };
    expect(() => saveRoomPassword('x', 'abcd', boom)).not.toThrow();
    expect(loadRoomPassword('x', boom)).toBeUndefined();
    expect(() => clearRoomPassword('x', boom)).not.toThrow();
  });

  it('valor que não é texto é ignorado', () => {
    const s = { getItem: () => '', setItem: () => {}, removeItem: () => {} };
    expect(loadRoomPassword('x', s)).toBeUndefined();
  });
});
