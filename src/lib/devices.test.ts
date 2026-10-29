import { describe, expect, it, vi } from 'vitest';
import { applySinkId, loadDevicePrefs, pickDevice, saveDevicePrefs, supportsSinkId, toOptions } from './devices';

const dev = (deviceId: string, kind: string, label = '') => ({ deviceId, kind, label });

describe('toOptions', () => {
  it('filtra pelo tipo e mantém os rótulos', () => {
    const list = [dev('m1', 'audioinput', 'USB Mic'), dev('s1', 'audiooutput', 'Fone'), dev('c1', 'videoinput', 'Câmera')];
    expect(toOptions(list, 'audioinput')).toEqual([{ id: 'm1', label: 'USB Mic' }]);
    expect(toOptions(list, 'audiooutput')).toEqual([{ id: 's1', label: 'Fone' }]);
  });

  it('sem permissão os rótulos vêm vazios: usa nomes numerados', () => {
    const list = [dev('a', 'audioinput'), dev('b', 'audioinput', '   '), dev('x', 'audiooutput')];
    expect(toOptions(list, 'audioinput').map((o) => o.label)).toEqual(['Microfone 1', 'Microfone 2']);
    expect(toOptions(list, 'audiooutput').map((o) => o.label)).toEqual(['Saída 1']);
  });

  it('marca como genérico só o rótulo gerado por nós (sem permissão), nunca o que veio do navegador', () => {
    const list = [dev('a', 'audioinput'), dev('b', 'audioinput', 'USB Mic')];
    expect(toOptions(list, 'audioinput')).toEqual([
      { id: 'a', label: 'Microfone 1', generic: true },
      { id: 'b', label: 'USB Mic' },
    ]);
  });

  it('descarta deviceId vazio e ids repetidos', () => {
    const list = [dev('', 'audioinput', 'sem id'), dev('a', 'audioinput', 'A'), dev('a', 'audioinput', 'A de novo')];
    expect(toOptions(list, 'audioinput')).toEqual([{ id: 'a', label: 'A' }]);
  });

  it('lista vazia dá lista vazia', () => {
    expect(toOptions([], 'audioinput')).toEqual([]);
  });
});

describe('pickDevice', () => {
  const opts = [
    { id: 'default', label: 'Padrão' },
    { id: 'a', label: 'A' },
    { id: 'b', label: 'B' },
  ];

  it('devolve o preferido quando existe', () => {
    expect(pickDevice(opts, 'b')).toBe('b');
  });
  it('se o preferido sumiu, cai no default', () => {
    expect(pickDevice(opts, 'fantasma')).toBe('default');
    expect(pickDevice(opts, null)).toBe('default');
    expect(pickDevice(opts, undefined)).toBe('default');
  });
  it('sem default, cai no primeiro', () => {
    expect(pickDevice(opts.slice(1), 'fantasma')).toBe('a');
  });
  it('lista vazia dá string vazia', () => {
    expect(pickDevice([], 'a')).toBe('');
  });
  it('o id mudou (navegador gera ids novos) mas o rótulo é o mesmo: acha pelo rótulo', () => {
    expect(pickDevice(opts, 'id-novo', 'B')).toBe('b');
  });
  it('rótulo repetido na lista (dois headsets iguais) não casa: cairia no dispositivo errado', () => {
    const iguais = [
      { id: 'default', label: 'Padrão' },
      { id: 'a', label: 'USB Audio Device' },
      { id: 'b', label: 'USB Audio Device' },
    ];
    expect(pickDevice(iguais, 'id-novo', 'USB Audio Device')).toBe('default');
  });
  it('rótulo único casa mesmo havendo outros repetidos', () => {
    const lista = [
      { id: 'a', label: 'USB Audio Device' },
      { id: 'b', label: 'USB Audio Device' },
      { id: 'c', label: 'Fone Bluetooth' },
    ];
    expect(pickDevice(lista, 'id-novo', 'Fone Bluetooth')).toBe('c');
  });
  it('o id tem prioridade sobre o rótulo; rótulo desconhecido cai no default', () => {
    expect(pickDevice(opts, 'a', 'B')).toBe('a');
    expect(pickDevice(opts, 'fantasma', 'Outro fone')).toBe('default');
  });
});

describe('prefs', () => {
  const store = (raw: string | null | (() => never)) => ({
    getItem: vi.fn((key: string) => {
      expect(key).toBe('telax:devices');
      if (typeof raw === 'function') return raw();
      return raw;
    }),
  });

  it('lê as preferências salvas', () => {
    expect(loadDevicePrefs(store(JSON.stringify({ micId: 'm', outputId: 's' })))).toEqual({ micId: 'm', outputId: 's' });
  });
  it('nada salvo, JSON inválido, lixo e valores que não são texto viram null', () => {
    const nulls = { micId: null, outputId: null };
    expect(loadDevicePrefs(store(null))).toEqual(nulls);
    expect(loadDevicePrefs(store('{quebrado'))).toEqual(nulls);
    expect(loadDevicePrefs(store('42'))).toEqual(nulls);
    expect(loadDevicePrefs(store('null'))).toEqual(nulls);
    expect(loadDevicePrefs(store(JSON.stringify({ micId: 7, outputId: { x: 1 } })))).toEqual(nulls);
    expect(loadDevicePrefs(store(JSON.stringify({ micId: '', outputId: 's' })))).toEqual({ micId: null, outputId: 's' });
  });
  it('guarda e lê também os rótulos escolhidos, ignorando rótulo que não é texto', () => {
    const full = { micId: 'm', outputId: 's', micLabel: 'Fone X', outputLabel: 'Caixa Y' };
    expect(loadDevicePrefs(store(JSON.stringify(full)))).toEqual(full);
    expect(loadDevicePrefs(store(JSON.stringify({ micId: 'm', micLabel: 5 })))).toEqual({ micId: 'm', outputId: null });
  });
  it('storage que lança não derruba', () => {
    expect(loadDevicePrefs(store(() => { throw new Error('bloqueado'); }))).toEqual({ micId: null, outputId: null });
    expect(() =>
      saveDevicePrefs({ micId: 'm', outputId: 's' }, { setItem: () => { throw new Error('cheio'); } }),
    ).not.toThrow();
  });
  it('grava as preferências como JSON na chave certa', () => {
    const setItem = vi.fn();
    saveDevicePrefs({ micId: 'm', outputId: null }, { setItem });
    expect(setItem).toHaveBeenCalledWith('telax:devices', JSON.stringify({ micId: 'm', outputId: null }));
  });
});

describe('supportsSinkId / applySinkId', () => {
  it('supportsSinkId olha o elemento dado; sem DOM (node) e sem argumento é false', () => {
    expect(supportsSinkId({ setSinkId() {} })).toBe(true);
    expect(supportsSinkId({})).toBe(false);
    expect(supportsSinkId(null)).toBe(false);
    expect(supportsSinkId()).toBe(false);
  });

  it('sem setSinkId não faz nada e devolve false', async () => {
    expect(await applySinkId({} as unknown as HTMLMediaElement, 'abc')).toBe(false);
  });
  it('id vazio não chama setSinkId', async () => {
    const setSinkId = vi.fn();
    expect(await applySinkId({ setSinkId } as unknown as HTMLMediaElement, '')).toBe(false);
    expect(setSinkId).not.toHaveBeenCalled();
  });
  it('sucesso devolve true e passa o id', async () => {
    const setSinkId = vi.fn().mockResolvedValue(undefined);
    expect(await applySinkId({ setSinkId } as unknown as HTMLMediaElement, 'abc')).toBe(true);
    expect(setSinkId).toHaveBeenCalledWith('abc');
  });
  it('setSinkId que rejeita (dispositivo removido) devolve false sem lançar', async () => {
    const setSinkId = vi.fn().mockRejectedValue(new DOMException('sumiu', 'NotFoundError'));
    await expect(applySinkId({ setSinkId } as unknown as HTMLMediaElement, 'abc')).resolves.toBe(false);
  });
  it('setSinkId que lança de forma síncrona também não propaga', async () => {
    const setSinkId = vi.fn(() => {
      throw new Error('boom');
    });
    await expect(applySinkId({ setSinkId } as unknown as HTMLMediaElement, 'abc')).resolves.toBe(false);
  });
});
