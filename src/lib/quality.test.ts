import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_QUALITY,
  contentHintFor,
  describeActual,
  estimateUploadKbps,
  loadQuality,
  sanitizeQuality,
  saveQuality,
  toSendQuality,
  toVideoConstraints,
  type QualitySettings,
} from './quality';

const custom = (over: Partial<QualitySettings['camera']> = {}, screen: Partial<QualitySettings['screen']> = {}): QualitySettings => ({
  camera: { ...DEFAULT_QUALITY.camera, ...over },
  screen: { ...DEFAULT_QUALITY.screen, ...screen },
});

describe('sanitizeQuality', () => {
  it('aceita valores válidos', () => {
    const q = custom({ resolution: '1080p', fps: 24, bitrateKbps: 1500 }, { resolution: '720p', fps: 60, bitrateKbps: 5000, priority: 'motion' });
    expect(sanitizeQuality(q)).toEqual(q);
  });
  it('lixo, tipos errados e valores fora da lista voltam ao automático, campo a campo', () => {
    expect(sanitizeQuality(null)).toEqual(DEFAULT_QUALITY);
    expect(sanitizeQuality('x')).toEqual(DEFAULT_QUALITY);
    expect(sanitizeQuality({ camera: 7, screen: [] })).toEqual(DEFAULT_QUALITY);
    const mixed = sanitizeQuality({
      camera: { resolution: '4k', fps: 999, bitrateKbps: '800' },
      screen: { resolution: '1080p', fps: 30, bitrateKbps: -5, priority: 'detail' },
    });
    expect(mixed.camera).toEqual(DEFAULT_QUALITY.camera);
    expect(mixed.screen).toEqual({ ...DEFAULT_QUALITY.screen, resolution: '1080p', fps: 30, priority: 'detail' });
  });
  it('o padrão é tudo automático', () => {
    expect(DEFAULT_QUALITY.camera).toMatchObject({ resolution: 'auto', fps: 0, bitrateKbps: 0 });
    expect(DEFAULT_QUALITY.screen).toMatchObject({ resolution: 'auto', fps: 0, bitrateKbps: 0, priority: 'balanced' });
  });
});

describe('preferências salvas', () => {
  it('lê o que foi salvo e valida', () => {
    const q = custom({ resolution: '720p' });
    expect(loadQuality({ getItem: () => JSON.stringify(q) })).toEqual(q);
    expect(loadQuality({ getItem: () => '{quebrado' })).toEqual(DEFAULT_QUALITY);
    expect(loadQuality({ getItem: () => null })).toEqual(DEFAULT_QUALITY);
  });
  it('storage que lança não derruba (leitura e escrita)', () => {
    expect(loadQuality({ getItem: () => { throw new Error('bloqueado'); } })).toEqual(DEFAULT_QUALITY);
    expect(() => saveQuality(DEFAULT_QUALITY, { setItem: () => { throw new Error('cheio'); } })).not.toThrow();
  });
  it('grava como JSON na chave telax:quality', () => {
    const setItem = vi.fn();
    saveQuality(DEFAULT_QUALITY, { setItem });
    expect(setItem).toHaveBeenCalledWith('telax:quality', JSON.stringify(DEFAULT_QUALITY));
  });
});

describe('toVideoConstraints', () => {
  it('câmera: resolução e fps escolhidos viram ideal', () => {
    expect(toVideoConstraints('camera', custom({ resolution: '720p', fps: 24 }))).toEqual({
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 24 },
    });
  });
  it('câmera no automático pede 720p/30 (o que o navegador entregaria bem), para poder voltar de um valor alto', () => {
    expect(toVideoConstraints('camera', DEFAULT_QUALITY)).toEqual({
      width: { ideal: 1280 },
      height: { ideal: 720 },
      frameRate: { ideal: 30 },
    });
  });
  it('tela no automático pede a resolução nativa (um teto alto) e 30 fps; escolhida, usa a escolha', () => {
    expect(toVideoConstraints('screen', DEFAULT_QUALITY)).toEqual({
      width: { ideal: 3840 },
      height: { ideal: 2160 },
      frameRate: { ideal: 30 },
    });
    expect(toVideoConstraints('screen', custom({}, { resolution: '1080p', fps: 60 }))).toEqual({
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 60 },
    });
  });
});

describe('toSendQuality', () => {
  it('automático não limita nada', () => {
    expect(toSendQuality(DEFAULT_QUALITY)).toEqual({
      camera: { maxBitrate: undefined, maxFramerate: undefined },
      screen: { maxBitrate: undefined, maxFramerate: undefined },
    });
  });
  it('kbps viram bits por segundo e fps passa direto', () => {
    expect(toSendQuality(custom({ bitrateKbps: 800, fps: 15 }, { bitrateKbps: 2500, fps: 30 }))).toEqual({
      camera: { maxBitrate: 800_000, maxFramerate: 15 },
      screen: { maxBitrate: 2_500_000, maxFramerate: 30 },
    });
  });
});

describe('contentHintFor', () => {
  it('equilibrada não força dica; movimento e nitidez mapeiam para as dicas do navegador', () => {
    expect(contentHintFor('balanced')).toBe('');
    expect(contentHintFor('motion')).toBe('motion');
    expect(contentHintFor('detail')).toBe('detail');
  });
});

describe('estimateUploadKbps', () => {
  it('multiplica a taxa de cada fluxo pelos outros participantes (malha completa)', () => {
    const q = custom({ bitrateKbps: 800 }, { bitrateKbps: 2500 });
    expect(estimateUploadKbps(q, 4, false)).toBe(800 * 3);
    expect(estimateUploadKbps(q, 4, true)).toBe((800 + 2500) * 3);
  });
  it('sem limite definido não há estimativa; sozinho na sala é zero', () => {
    expect(estimateUploadKbps(DEFAULT_QUALITY, 4, true)).toBeUndefined();
    expect(estimateUploadKbps(custom({ bitrateKbps: 800 }), 1, false)).toBe(0);
  });
  it('só a câmera limitada: a tela sem limite impede a soma exata e a estimativa vira undefined quando ela está ativa', () => {
    expect(estimateUploadKbps(custom({ bitrateKbps: 800 }), 3, true)).toBeUndefined();
  });
});

describe('describeActual', () => {
  it('descreve resolução e fps realmente em uso', () => {
    expect(describeActual({ width: 1280, height: 720, frameRate: 29.97 })).toBe('1280×720 a 30 fps');
    expect(describeActual({ width: 640, height: 480 })).toBe('640×480');
    expect(describeActual({ frameRate: 15 })).toBe('15 fps');
  });
  it('sem dados devolve texto vazio', () => {
    expect(describeActual(undefined)).toBe('');
    expect(describeActual({})).toBe('');
  });
});
