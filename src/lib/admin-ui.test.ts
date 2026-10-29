import { describe, expect, it } from 'vitest';
import type { AdminPeer, AdminRoomSummary, Ban } from './admin-types';
import {
  MAC_NOTICE,
  banKindLabel,
  friendlyError,
  formatWhen,
  loginErrorMessage,
  mediaSummary,
  normalizeReason,
  pollIntervalMs,
  shortDevice,
  sortRooms,
  updatedLabel,
  validateText,
} from './admin-ui';

const room = (over: Partial<AdminRoomSummary> & { name: string }): AdminRoomSummary => ({
  peerCount: 0,
  observerCount: 0,
  createdAt: 0,
  lastActivity: 0,
  closed: false,
  ...over,
});

describe('updatedLabel', () => {
  it('antes da primeira resposta, e logo depois dela', () => {
    expect(updatedLabel(null)).toBe('carregando…');
    expect(updatedLabel(0)).toBe('atualizado agora');
    expect(updatedLabel(1)).toBe('atualizado agora');
  });
  it('mostra os segundos e depois os minutos', () => {
    expect(updatedLabel(7)).toBe('atualizado há 7 s');
    expect(updatedLabel(59)).toBe('atualizado há 59 s');
    expect(updatedLabel(60)).toBe('atualizado há 1 min');
    expect(updatedLabel(185)).toBe('atualizado há 3 min');
  });
});

describe('formatWhen', () => {
  const now = 1_000_000_000;
  it('agora, minutos, horas e dias', () => {
    expect(formatWhen(now - 3_000, now)).toBe('agora');
    expect(formatWhen(now - 5 * 60_000, now)).toBe('há 5 min');
    expect(formatWhen(now - 3 * 3_600_000, now)).toBe('há 3 h');
    expect(formatWhen(now - 2 * 86_400_000, now)).toBe('há 2 d');
  });
  it('relógio do servidor adiantado não vira "daqui a"', () => {
    expect(formatWhen(now + 60_000, now)).toBe('agora');
  });
  it('sem data', () => {
    expect(formatWhen(0, now)).toBe('—');
  });
});

describe('shortDevice', () => {
  it('abrevia o identificador e trata ausência', () => {
    expect(shortDevice('4a6f2c18-1111-4222-8333-944455556666')).toBe('4a6f2c18…');
    expect(shortDevice(null)).toBe('—');
    expect(shortDevice('')).toBe('—');
    expect(shortDevice('abc')).toBe('abc');
  });
});

describe('mediaSummary', () => {
  const peer = (over: Partial<AdminPeer>): Pick<AdminPeer, 'audio' | 'video' | 'screenSlots'> => ({ audio: true, video: true, screenSlots: 0, ...over });
  it('microfone, câmera e quantidade de telas', () => {
    expect(mediaSummary(peer({}))).toEqual({ mic: 'ligado', cam: 'ligada', screens: 'nenhuma' });
    expect(mediaSummary(peer({ audio: false, video: false }))).toEqual({ mic: 'mutado', cam: 'desligada', screens: 'nenhuma' });
    expect(mediaSummary(peer({ screenSlots: 0b001 })).screens).toBe('1 tela');
    expect(mediaSummary(peer({ screenSlots: 0b101 })).screens).toBe('2 telas');
    expect(mediaSummary(peer({ screenSlots: 0b111 })).screens).toBe('3 telas');
  });
});

describe('sortRooms', () => {
  it('abertas com mais gente primeiro, depois a atividade mais recente; fechadas por último', () => {
    const sorted = sortRooms([
      room({ name: 'fechada', closed: true, peerCount: 0, lastActivity: 999 }),
      room({ name: 'vazia-recente', peerCount: 0, lastActivity: 500 }),
      room({ name: 'cheia', peerCount: 5, lastActivity: 10 }),
      room({ name: 'duas', peerCount: 2, lastActivity: 100 }),
      room({ name: 'duas-nova', peerCount: 2, lastActivity: 300 }),
    ]);
    expect(sorted.map((r) => r.name)).toEqual(['cheia', 'duas-nova', 'duas', 'vazia-recente', 'fechada']);
  });
  it('não altera a lista original', () => {
    const list = [room({ name: 'b', peerCount: 1 }), room({ name: 'a', peerCount: 3 })];
    sortRooms(list);
    expect(list.map((r) => r.name)).toEqual(['b', 'a']);
  });
  it('empate total desempata pelo nome, para a ordem não pular a cada atualização', () => {
    const sorted = sortRooms([room({ name: 'z' }), room({ name: 'a' }), room({ name: 'm' })]);
    expect(sorted.map((r) => r.name)).toEqual(['a', 'm', 'z']);
  });
});

describe('pollIntervalMs', () => {
  it('5 s por padrão e NENHUMA consulta com a aba oculta (economia de invocações)', () => {
    expect(pollIntervalMs(false)).toBe(5000);
    expect(pollIntervalMs(true)).toBeNull();
    expect(pollIntervalMs(false, 8000)).toBe(8000);
  });
});

describe('validateText', () => {
  it('exige texto entre 1 e o máximo, ignorando espaços nas pontas', () => {
    expect(validateText('oi', 500)).toBeNull();
    expect(validateText('', 500)).toMatch(/escreva/i);
    expect(validateText('   ', 500)).toMatch(/escreva/i);
    expect(validateText('a'.repeat(500), 500)).toBeNull();
    expect(validateText('a'.repeat(501), 500)).toMatch(/500/);
  });
});

describe('normalizeReason', () => {
  it('apara, limita a 200 e vira undefined quando vazio', () => {
    expect(normalizeReason('  spam  ')).toBe('spam');
    expect(normalizeReason('   ')).toBeUndefined();
    expect(normalizeReason('x'.repeat(250))).toHaveLength(200);
  });
});

describe('friendlyError', () => {
  it('mensagens em português, sem vazar detalhes técnicos', () => {
    expect(friendlyError(401)).toMatch(/sessão expirou/i);
    expect(friendlyError(403)).toMatch(/sem permissão/i);
    expect(friendlyError(404)).toMatch(/não encontrada/i);
    expect(friendlyError(400)).toMatch(/inválid/i);
    expect(friendlyError(503, 'admin_disabled')).toMatch(/desativad/i);
    expect(friendlyError(500)).toMatch(/tente de novo/i);
    expect(friendlyError(0)).toMatch(/conexão/i);
  });
});

describe('loginErrorMessage', () => {
  it('traduz o ?error= da volta do GitHub', () => {
    expect(loginErrorMessage('forbidden')).toMatch(/não tem acesso/i);
    expect(loginErrorMessage('state')).toMatch(/tente entrar de novo/i);
    expect(loginErrorMessage('github')).toMatch(/GitHub/);
  });
  it('sem erro ou valor desconhecido não mostra nada (nada vindo da URL é exibido cru)', () => {
    expect(loginErrorMessage(null)).toBeNull();
    expect(loginErrorMessage(undefined)).toBeNull();
    expect(loginErrorMessage('<script>alert(1)</script>')).toBeNull();
  });
});

describe('banKindLabel e aviso do MAC', () => {
  it('rótulos dos tipos de bloqueio', () => {
    const ban = (kind: Ban['kind']): Ban => ({ id: '1', kind, value: 'x', reason: '', createdAt: 1 });
    expect(banKindLabel(ban('ip'))).toBe('IP');
    expect(banKindLabel(ban('device'))).toBe('Dispositivo');
  });
  it('o aviso sobre MAC diz a verdade sobre os limites', () => {
    expect(MAC_NOTICE).toMatch(/MAC não é acessível/);
    expect(MAC_NOTICE).toMatch(/IP compartilhado/);
    expect(MAC_NOTICE).toMatch(/VPN/);
  });
});

describe('secondsSince', () => {
  it('segundos desde a última atualização; sem atualização ainda, null; relógio para trás não dá negativo', async () => {
    const { secondsSince } = await import('./admin-ui');
    expect(secondsSince(null, 5_000)).toBeNull();
    expect(secondsSince(1_000, 8_400)).toBe(7);
    expect(secondsSince(9_000, 8_000)).toBe(0);
  });
});
