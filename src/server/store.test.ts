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
});
