import { describe, expect, it, vi } from 'vitest';
import { DEVICE_ID_KEY, getDeviceId } from './device-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const memoryStorage = (initial: Record<string, string> = {}) => {
  const data = { ...initial };
  return {
    data,
    getItem: vi.fn((k: string) => data[k] ?? null),
    setItem: vi.fn((k: string, v: string) => {
      data[k] = v;
    }),
  };
};

describe('getDeviceId', () => {
  it('gera um UUID na primeira vez, grava em telax:device-id e devolve o mesmo nas próximas', () => {
    const storage = memoryStorage();
    const first = getDeviceId(storage);
    expect(first).toMatch(UUID);
    expect(DEVICE_ID_KEY).toBe('telax:device-id');
    expect(storage.data[DEVICE_ID_KEY]).toBe(first);
    expect(getDeviceId(storage)).toBe(first);
    expect(storage.setItem).toHaveBeenCalledTimes(1);
  });

  it('reaproveita um UUID já salvo', () => {
    const saved = '3f197123-2bf8-4730-aadf-6c61db50d59e';
    const storage = memoryStorage({ [DEVICE_ID_KEY]: saved });
    expect(getDeviceId(storage)).toBe(saved);
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('valor salvo que não é UUID (lixo, vazio) é substituído por um novo', () => {
    for (const junk of ['', 'abc', '{"x":1}', '3f197123-2bf8-4730-aadf']) {
      const storage = memoryStorage({ [DEVICE_ID_KEY]: junk });
      const id = getDeviceId(storage);
      expect(id).toMatch(UUID);
      expect(id).not.toBe(junk);
      expect(storage.data[DEVICE_ID_KEY]).toBe(id);
    }
  });

  it('armazenamento que lança (janela privada, bloqueado) cai num UUID de sessão, estável', () => {
    const broken = {
      getItem: () => {
        throw new Error('bloqueado');
      },
      setItem: () => {
        throw new Error('bloqueado');
      },
    };
    const a = getDeviceId(broken);
    expect(a).toMatch(UUID);
    expect(getDeviceId(broken)).toBe(a);
  });

  it('leitura que funciona mas escrita que falha ainda devolve um UUID válido', () => {
    const readOnly = { getItem: () => null, setItem: () => { throw new Error('cheio'); } };
    expect(getDeviceId(readOnly)).toMatch(UUID);
  });

  it('dois navegadores (storages) diferentes têm ids diferentes', () => {
    expect(getDeviceId(memoryStorage())).not.toBe(getDeviceId(memoryStorage()));
  });
});
