import { describe, expect, it } from 'vitest';
import { getIceServers } from './ice';

const STUN = { urls: 'stun:stun.l.google.com:19302' };

describe('getIceServers', () => {
  it('sem variáveis devolve só o STUN', () => {
    expect(getIceServers({})).toEqual([STUN]);
  });

  it('com as três variáveis inclui o TURN e separa URLs por vírgula', () => {
    const servers = getIceServers({
      TURN_URLS: 'turn:a.example:3478, turns:a.example:5349',
      TURN_USERNAME: 'u',
      TURN_CREDENTIAL: 'c',
    });
    expect(servers).toEqual([
      STUN,
      { urls: ['turn:a.example:3478', 'turns:a.example:5349'], username: 'u', credential: 'c' },
    ]);
  });

  it('ignora o TURN se faltar qualquer uma das três', () => {
    expect(getIceServers({ TURN_URLS: 'turn:a.example', TURN_USERNAME: 'u' })).toEqual([STUN]);
    expect(getIceServers({ TURN_USERNAME: 'u', TURN_CREDENTIAL: 'c' })).toEqual([STUN]);
  });
});
