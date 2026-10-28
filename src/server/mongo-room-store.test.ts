import { randomUUID } from 'node:crypto';
import { MongoClient, type Db } from 'mongodb';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MongoRoomStore } from './mongo-room-store';
import { describeRoomStore } from './room-store.contract';

/**
 * Roda contra um MongoDB real, só quando MONGODB_TEST_URI estiver definida, por exemplo:
 *   docker run -d --rm -p 27018:27017 mongo:7
 *   MONGODB_TEST_URI=mongodb://127.0.0.1:27018 npx vitest run src/server/mongo-room-store.test.ts
 * Usa um banco descartável com nome aleatório e o apaga no fim.
 */
const uri = process.env.MONGODB_TEST_URI;
const suite = uri ? describe : describe.skip;

let client: MongoClient;
let db: Db;

if (uri) {
  beforeAll(async () => {
    client = new MongoClient(uri);
    await client.connect();
    db = client.db(`telax_test_${randomUUID().slice(0, 8)}`);
    await new MongoRoomStore(db.collection('rooms')).ensureIndexes();
  });
  afterAll(async () => {
    await db.dropDatabase();
    await client.close();
  });
}

const newStore = (now: () => number = Date.now) => new MongoRoomStore(db.collection('rooms'), now);

if (uri) describeRoomStore('MongoDB', (now) => newStore(now));
else describe.skip('contrato do RoomStore: MongoDB (defina MONGODB_TEST_URI para rodar)', () => it('pulado', () => {}));

suite('várias instâncias do servidor compartilhando o mesmo MongoDB', () => {
  it('quem entra por uma instância é reconhecido, recebe eventos e fala pela outra (o bug da Vercel)', async () => {
    const instanciaA = newStore();
    const instanciaB = newStore();
    const room = `multi-${randomUUID().slice(0, 8)}`;

    const ana = await instanciaA.join(room, 'Ana');
    await expect(instanciaB.authenticate(room, ana.peerId, ana.token)).resolves.toBeUndefined();

    const beto = await instanciaB.join(room, 'Beto');
    expect(beto.participants.map((p) => p.name).sort()).toEqual(['Ana', 'Beto']);

    await instanciaA.chat(room, ana.peerId, 'oi do A');
    await instanciaB.signal(room, beto.peerId, ana.peerId, { gen: 0, kind: 'offer', sdp: 'v=0' });
    const { events } = await instanciaA.events(room, ana.peerId, ana.cursor);
    expect(events.map((e) => e.type)).toEqual(['join', 'signal']);
    const doBeto = await instanciaB.events(room, beto.peerId, beto.cursor);
    expect(doBeto.events.map((e) => e.type)).toEqual(['chat']);
  });

  it('o limite de 8 vale entre instâncias diferentes disputando ao mesmo tempo', async () => {
    const instancias = [newStore(), newStore(), newStore()];
    const room = `multi-${randomUUID().slice(0, 8)}`;
    const results = await Promise.allSettled(
      Array.from({ length: 15 }, (_, i) => instancias[i % 3].join(room, `p${i}`)),
    );
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(8);
  });

  it('salas diferentes não se misturam', async () => {
    const store = newStore();
    const a = await store.join(`iso-a-${randomUUID().slice(0, 8)}`, 'Ana');
    const outra = `iso-b-${randomUUID().slice(0, 8)}`;
    const b = await store.join(outra, 'Beto');
    expect(b.participants).toHaveLength(1);
    await expect(Promise.resolve(store.authenticate(outra, a.peerId, a.token))).rejects.toThrow();
  });
});
