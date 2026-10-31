import { describe, expect, it, vi } from 'vitest';
import { describeRoomPreview, fetchRoomPreview } from './room-preview';

describe('describeRoomPreview', () => {
  it('sala vazia ou inexistente não mostra nada', () => {
    expect(describeRoomPreview({ count: 0, closed: false, protected: false })).toBeNull();
    expect(describeRoomPreview(null)).toBeNull();
  });

  it('diz que a sala já existe e quantas pessoas estão nela (singular e plural)', () => {
    expect(describeRoomPreview({ count: 1, closed: false, protected: false })).toEqual({
      tone: 'live',
      text: 'Esta sala já existe: 1 pessoa na sala agora.',
    });
    expect(describeRoomPreview({ count: 2, closed: false, protected: false })?.text).toBe('Esta sala já existe: 2 pessoas na sala agora.');
    expect(describeRoomPreview({ count: 25, closed: false, protected: false })?.text).toBe('Esta sala já existe: 25 pessoas na sala agora.');
  });

  it('sala protegida por senha: avisa na mesma frase, e uma sala protegida vazia ainda existe', () => {
    expect(describeRoomPreview({ count: 2, closed: false, protected: true })).toEqual({
      tone: 'live',
      text: 'Esta sala já existe: 2 pessoas na sala agora. Ela é protegida por senha.',
    });
    expect(describeRoomPreview({ count: 0, closed: false, protected: true })).toEqual({
      tone: 'live',
      text: 'Esta sala já existe e é protegida por senha.',
    });
  });

  it('sala fechada pelo admin: existe, mas está encerrada (mesmo vazia)', () => {
    expect(describeRoomPreview({ count: 0, closed: true, protected: false })).toEqual({
      tone: 'closed',
      text: 'Esta sala existe, mas foi encerrada pelo administrador.',
    });
    expect(describeRoomPreview({ count: 3, closed: true, protected: false })?.tone).toBe('closed');
  });
});

describe('fetchRoomPreview', () => {
  const ok = (body: unknown, status = 200) =>
    vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify(body), { status }));

  it('chama a rota pública com o nome codificado e devolve count e closed', async () => {
    const f = ok({ count: 3, closed: false, protected: true });
    await expect(fetchRoomPreview('Sala Café/1', f)).resolves.toEqual({ count: 3, closed: false, protected: true });
    expect(f).toHaveBeenCalledTimes(1);
    expect(f.mock.calls[0][0]).toBe('/api/rooms/Sala%20Caf%C3%A9%2F1/preview');
  });

  it('apara o nome e repassa o sinal de cancelamento', async () => {
    const f = ok({ count: 1, closed: false, protected: false });
    const ctl = new AbortController();
    await fetchRoomPreview('  sala  ', f, ctl.signal);
    expect(f.mock.calls[0][0]).toBe('/api/rooms/sala/preview');
    expect((f.mock.calls[0][1] as RequestInit).signal).toBe(ctl.signal);
  });

  it('qualquer coisa fora do contrato vira null (a tela simplesmente não mostra nada)', async () => {
    await expect(fetchRoomPreview('s', ok({ error: 'invalid' }, 400))).resolves.toBeNull();
    await expect(fetchRoomPreview('s', ok({ count: -1, closed: false, protected: false }))).resolves.toBeNull();
    await expect(fetchRoomPreview('s', ok({ count: 1.5, closed: false, protected: false }))).resolves.toBeNull();
    await expect(fetchRoomPreview('s', ok({ count: '3', closed: false, protected: false }))).resolves.toBeNull();
    await expect(fetchRoomPreview('s', ok({ count: 3 }))).resolves.toBeNull();
    await expect(fetchRoomPreview('s', ok(null))).resolves.toBeNull();
    await expect(fetchRoomPreview('s', vi.fn(async (_url: string) => new Response('<html>', { status: 200 })))).resolves.toBeNull();
    await expect(fetchRoomPreview('s', vi.fn(async (_url: string): Promise<Response> => { throw new Error('rede'); }))).resolves.toBeNull();
  });

  it('servidor que ainda não manda "protected": vale como não protegida; valor que não é booleano invalida', async () => {
    await expect(fetchRoomPreview('s', ok({ count: 1, closed: false }))).resolves.toEqual({ count: 1, closed: false, protected: false });
    await expect(fetchRoomPreview('s', ok({ count: 1, closed: false, protected: 'sim' }))).resolves.toBeNull();
  });

  it('nome vazio não faz requisição', async () => {
    const f = ok({ count: 1, closed: false, protected: false });
    await expect(fetchRoomPreview('   ', f)).resolves.toBeNull();
    expect(f).not.toHaveBeenCalled();
  });

  it('não repassa nada além de count e closed, mesmo que o servidor mande mais', async () => {
    const r = await fetchRoomPreview('s', ok({ count: 2, closed: false, protected: false, names: ['Ana'], ip: '1.2.3.4' }));
    expect(r).toEqual({ count: 2, closed: false, protected: false });
  });
});
