import type { Collection, Document } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { MongoRoomStore } from './mongo-room-store';

/**
 * Sem Mongo real (o contrato completo só roda com MONGODB_TEST_URI): confere a FORMA da consulta da prévia. Um
 * `$filter ... as: 'p'` só enxerga a variável como `$$p`; `$p.v.lastSeen` é um caminho de campo do documento, que não
 * existe, e a contagem de pessoas ficava sempre em 0 (a tela só avisava que a sala existia quando ela tinha senha).
 */
function previewProjection(): Document {
  let projection: Document | undefined;
  const rooms = {
    findOne: async (_filter: Document, options?: { projection?: Document }) => {
      projection = options?.projection;
      return { count: 2 };
    },
  } as unknown as Collection<Document>;
  const store = new MongoRoomStore(rooms as never, () => 1_000_000);
  return { run: store.roomPreview('sala'), get: () => projection } as unknown as Document;
}

describe('MongoRoomStore.roomPreview: consulta de contagem', () => {
  it('lê os peers pela variável do $filter ($$p), nunca por um caminho de campo ($p)', async () => {
    const probe = previewProjection() as unknown as { run: Promise<{ count: number }>; get: () => Document | undefined };
    const result = await probe.run;
    const text = JSON.stringify(probe.get());
    expect(text).toContain('"$$p.v.lastSeen"');
    expect(text).toContain('"$$p.v.observer"');
    expect(text).not.toMatch(/"\$p\./);
    expect(result.count).toBe(2);
  });
});
