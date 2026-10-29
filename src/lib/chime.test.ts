import { describe, expect, it, vi } from 'vitest';
import { chimeNotes, loadSoundPrefs, saveSoundPrefs, SOUND_PREFS_KEY } from './chime';

describe('chimeNotes', () => {
  it('entrar: duas notas ascendentes; sair: duas descendentes', () => {
    const join = chimeNotes('join');
    const leave = chimeNotes('leave');
    expect(join.map((n) => n.freq)).toEqual([587, 880]);
    expect(leave.map((n) => n.freq)).toEqual([740, 494]);
    expect(join[1].freq).toBeGreaterThan(join[0].freq);
    expect(leave[1].freq).toBeLessThan(leave[0].freq);
  });

  it('são baixos e curtos: ganho de pico <= 0.1 e ~250–350 ms no total', () => {
    for (const kind of ['join', 'leave'] as const) {
      const notes = chimeNotes(kind);
      for (const n of notes) {
        expect(n.gain).toBeGreaterThan(0);
        expect(n.gain).toBeLessThanOrEqual(0.1);
        expect(n.duration).toBeGreaterThan(0);
      }
      const end = Math.max(...notes.map((n) => n.start + n.duration));
      expect(end).toBeGreaterThanOrEqual(0.25);
      expect(end).toBeLessThanOrEqual(0.35);
      // as notas vêm em ordem de início
      expect(notes.map((n) => n.start)).toEqual([...notes.map((n) => n.start)].sort((a, b) => a - b));
    }
  });
});

describe('preferências de som', () => {
  const store = (raw: string | null | (() => never)) => ({
    getItem: vi.fn((key: string) => {
      expect(key).toBe(SOUND_PREFS_KEY);
      if (typeof raw === 'function') return raw();
      return raw;
    }),
  });

  it('a chave é telax:sounds e o padrão é LIGADO', () => {
    expect(SOUND_PREFS_KEY).toBe('telax:sounds');
    expect(loadSoundPrefs(store(null))).toEqual({ enabled: true });
  });
  it('lê o valor salvo', () => {
    expect(loadSoundPrefs(store(JSON.stringify({ enabled: false })))).toEqual({ enabled: false });
    expect(loadSoundPrefs(store(JSON.stringify({ enabled: true })))).toEqual({ enabled: true });
  });
  it('JSON inválido, lixo e valores que não são booleanos voltam ao padrão ligado', () => {
    for (const raw of ['{quebrado', '42', 'null', '[]', '{"enabled":"nao"}', '{"enabled":0}', '{}']) {
      expect(loadSoundPrefs(store(raw))).toEqual({ enabled: true });
    }
  });
  it('storage que lança não derruba (leitura e escrita)', () => {
    expect(loadSoundPrefs(store(() => { throw new Error('bloqueado'); }))).toEqual({ enabled: true });
    expect(() => saveSoundPrefs({ enabled: false }, { setItem: () => { throw new Error('cheio'); } })).not.toThrow();
  });
  it('grava como JSON na chave certa', () => {
    const setItem = vi.fn();
    saveSoundPrefs({ enabled: false }, { setItem });
    expect(setItem).toHaveBeenCalledWith('telax:sounds', JSON.stringify({ enabled: false }));
  });
});
