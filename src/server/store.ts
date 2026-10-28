import { MongoClient } from 'mongodb';
import { MemoryRoomStore } from './memory-room-store';
import { MongoRoomStore, type RoomDoc } from './mongo-room-store';
import type { RoomStore } from './room-store';

const globalForStore = globalThis as unknown as { __telaxStore?: RoomStore };

type Env = Record<string, string | undefined>;

/**
 * Com `MONGODB_URI` as salas ficam no MongoDB e todas as instâncias do servidor (ex.: Vercel) enxergam as
 * mesmas; sem ela, ficam na memória do processo (só confiável com uma instância).
 */
export function createStore(env: Env): RoomStore {
  const uri = env.MONGODB_URI?.trim();
  if (!uri) return new MemoryRoomStore();
  // Pool pequeno e conexões ociosas fechadas logo: cada instância serverless abre o seu próprio pool.
  const client = new MongoClient(uri, {
    maxPoolSize: 5,
    minPoolSize: 0,
    maxIdleTimeMS: 10_000,
    serverSelectionTimeoutMS: 5_000,
  });
  return new MongoRoomStore(client.db(env.MONGODB_DB?.trim() || 'telax').collection<RoomDoc>('rooms'));
}

/** Singleton em globalThis: sobrevive a hot reload e é reaproveitado entre invocações da mesma instância. */
export function getStore(): RoomStore {
  if (!globalForStore.__telaxStore) {
    const store = createStore(process.env);
    if (store instanceof MongoRoomStore) {
      // o índice TTL só limpa salas abandonadas: se falhar, o app segue funcionando
      void store.ensureIndexes().catch((e) => console.error('telax: não criou o índice TTL das salas', e));
    }
    globalForStore.__telaxStore = store;
  }
  return globalForStore.__telaxStore;
}
