import { describe, expect, it } from 'vitest';
import { MemoryRoomStore } from './memory-room-store';
import { MongoRoomStore } from './mongo-room-store';
import { createStore } from './store';

describe('createStore', () => {
  it('sem MONGODB_URI usa a memória do processo', () => {
    expect(createStore({})).toBeInstanceOf(MemoryRoomStore);
  });

  it('MONGODB_URI vazia ou só espaços também cai na memória', () => {
    expect(createStore({ MONGODB_URI: '' })).toBeInstanceOf(MemoryRoomStore);
    expect(createStore({ MONGODB_URI: '   ' })).toBeInstanceOf(MemoryRoomStore);
  });

  it('com MONGODB_URI usa o MongoDB (a conexão só abre no primeiro uso)', () => {
    expect(createStore({ MONGODB_URI: 'mongodb://127.0.0.1:1' })).toBeInstanceOf(MongoRoomStore);
  });

  describe('MAX_PEERS (limite opcional de pessoas por sala)', () => {
    const limit = (s: unknown) => (s as { opts?: { maxPeers?: number } }).opts?.maxPeers;
    it('ausente, vazio ou inválido = sem limite', () => {
      for (const v of [undefined, '', '  ', 'abc', '0', '-3', '2.5', '8x', 'Infinity', 'NaN']) {
        expect(limit(createStore({ MAX_PEERS: v })), String(v)).toBeUndefined();
      }
    });
    it('inteiro positivo vira o limite', () => {
      expect(limit(createStore({ MAX_PEERS: '8' }))).toBe(8);
      expect(limit(createStore({ MAX_PEERS: ' 25 ' }))).toBe(25);
    });
    it('sem a variável o 9º participante entra', async () => {
      const store = createStore({});
      for (let i = 0; i < 12; i++) await store.join('sala-sem-limite', `p${i}`);
    });
    it('com MAX_PEERS=2 o 3º recebe RoomFullError', async () => {
      const store = createStore({ MAX_PEERS: '2' });
      await store.join('sala-limite', 'a');
      await store.join('sala-limite', 'b');
      await expect(Promise.resolve().then(() => store.join('sala-limite', 'c'))).rejects.toThrow('room_full');
    });
  });
});
