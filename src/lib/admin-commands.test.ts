import { describe, expect, it, vi } from 'vitest';
import { parseAdminEvent, planAdminCommand, runAdminActions, type AdminCommandControls } from './admin-commands';

describe('parseAdminEvent', () => {
  it('mensagem válida', () => {
    expect(parseAdminEvent({ kind: 'message', text: 'A sala fecha em 5 min', at: 123 })).toEqual({
      kind: 'message',
      text: 'A sala fecha em 5 min',
      at: 123,
    });
  });

  it('mensagem vazia, só espaços ou sem texto é ignorada; texto gigante é cortado em 500', () => {
    expect(parseAdminEvent({ kind: 'message', text: '', at: 1 })).toBeNull();
    expect(parseAdminEvent({ kind: 'message', text: '   ', at: 1 })).toBeNull();
    expect(parseAdminEvent({ kind: 'message', at: 1 })).toBeNull();
    expect(parseAdminEvent({ kind: 'message', text: 42, at: 1 })).toBeNull();
    const big = parseAdminEvent({ kind: 'message', text: 'x'.repeat(900), at: 1 });
    expect(big && big.kind === 'message' && big.text.length).toBe(500);
  });

  it('`at` ausente ou inválido vira a hora de agora (a mensagem em si continua válida)', () => {
    const before = Date.now();
    const m = parseAdminEvent({ kind: 'message', text: 'oi' });
    expect(m && m.kind === 'message' && m.at).toBeGreaterThanOrEqual(before);
    const n = parseAdminEvent({ kind: 'message', text: 'oi', at: 'x' });
    expect(n && n.kind === 'message' && Number.isFinite(n.at)).toBe(true);
  });

  it('comandos válidos', () => {
    for (const what of ['screens', 'camera', 'mic', 'all'] as const) {
      expect(parseAdminEvent({ kind: 'command', what, at: 1 })).toMatchObject({ kind: 'command', what });
    }
    expect(parseAdminEvent({ kind: 'command', what: 'screen', slot: 2, at: 1 })).toMatchObject({ what: 'screen', slot: 2 });
  });

  it('comando desconhecido, `screen` sem slot válido ou slot fora de 0..2 é ignorado', () => {
    expect(parseAdminEvent({ kind: 'command', what: 'explodir', at: 1 })).toBeNull();
    expect(parseAdminEvent({ kind: 'command', what: 'screen', at: 1 })).toBeNull();
    for (const slot of [-1, 3, 1.5, '1', null, Number.NaN]) {
      expect(parseAdminEvent({ kind: 'command', what: 'screen', slot, at: 1 })).toBeNull();
    }
  });

  it('o slot é descartado nos comandos que não são `screen`', () => {
    const c = parseAdminEvent({ kind: 'command', what: 'camera', slot: 2, at: 1 });
    expect(c).not.toHaveProperty('slot');
  });

  it('lixo: não objeto, tipos desconhecidos', () => {
    for (const junk of [null, undefined, 5, 'x', [], {}, { kind: 'kick' }, { kind: 'ban' }, { kind: 'close' }]) {
      expect(parseAdminEvent(junk)).toBeNull();
    }
  });
});

describe('planAdminCommand', () => {
  it('traduz cada comando nas ações locais', () => {
    expect(planAdminCommand({ what: 'screens' })).toEqual([{ do: 'stopScreens' }]);
    expect(planAdminCommand({ what: 'screen', slot: 1 })).toEqual([{ do: 'stopScreen', slot: 1 }]);
    expect(planAdminCommand({ what: 'camera' })).toEqual([{ do: 'camOff' }]);
    expect(planAdminCommand({ what: 'mic' })).toEqual([{ do: 'micOff' }]);
  });

  it('`all` para as telas, desliga a câmera e muta o microfone', () => {
    expect(planAdminCommand({ what: 'all' })).toEqual([{ do: 'stopScreens' }, { do: 'camOff' }, { do: 'micOff' }]);
  });

  it('`screen` sem slot válido não faz nada (nunca para telas por engano)', () => {
    expect(planAdminCommand({ what: 'screen' })).toEqual([]);
    expect(planAdminCommand({ what: 'screen', slot: 9 })).toEqual([]);
  });
});

const controls = (over: Partial<AdminCommandControls> = {}) => ({
  micOn: true,
  camOn: true,
  toggleMic: vi.fn(),
  toggleCam: vi.fn(),
  stopAllScreens: vi.fn(),
  stopScreen: vi.fn(),
  ...over,
});

describe('runAdminActions', () => {
  it('desligar câmera e mutar mic é idempotente: só alterna se estiver ligado (toggle puro ligaria de volta)', () => {
    const off = controls({ micOn: false, camOn: false });
    runAdminActions([{ do: 'camOff' }, { do: 'micOff' }], off);
    expect(off.toggleCam).not.toHaveBeenCalled();
    expect(off.toggleMic).not.toHaveBeenCalled();

    const on = controls();
    runAdminActions([{ do: 'camOff' }, { do: 'micOff' }], on);
    expect(on.toggleCam).toHaveBeenCalledTimes(1);
    expect(on.toggleMic).toHaveBeenCalledTimes(1);
  });

  it('para todas as telas ou só a do slot', () => {
    const c = controls();
    runAdminActions([{ do: 'stopScreens' }, { do: 'stopScreen', slot: 2 }], c);
    expect(c.stopAllScreens).toHaveBeenCalledTimes(1);
    expect(c.stopScreen).toHaveBeenCalledWith(2);
  });

  it('lista vazia não mexe em nada', () => {
    const c = controls();
    runAdminActions([], c);
    expect(c.toggleCam).not.toHaveBeenCalled();
    expect(c.toggleMic).not.toHaveBeenCalled();
    expect(c.stopAllScreens).not.toHaveBeenCalled();
    expect(c.stopScreen).not.toHaveBeenCalled();
  });
});
