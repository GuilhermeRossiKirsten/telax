import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSignalBatcher } from './signal-batcher';
import type { SignalData } from './types';

type Item = { to: string; data: SignalData };

const cand = (n: number): SignalData => ({ gen: 0, kind: 'candidate', sid: 1, candidate: { candidate: `c${n}` } });
const offer: SignalData = { gen: 0, kind: 'offer', sid: 1, sdp: 'v=0' };
const answer: SignalData = { gen: 0, kind: 'answer', sid: 1, sdp: 'v=0' };
const label = (i: Item) => (i.data.kind === 'candidate' ? String((i.data.candidate as { candidate: string }).candidate) : i.data.kind);

function setup(opts?: { delayMs?: number; maxItems?: number }, sendImpl?: (items: Item[]) => Promise<void>) {
  const batches: Item[][] = [];
  const send = vi.fn(async (items: Item[]) => {
    batches.push(items);
    await sendImpl?.(items);
  });
  const batcher = createSignalBatcher(send, opts);
  return { batcher, send, batches };
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('candidatos ICE', () => {
  it('vários candidatos seguidos viram UMA chamada, depois de delayMs', async () => {
    const t = setup({ delayMs: 80 });
    const p = [t.batcher.push('b', cand(1)), t.batcher.push('b', cand(2)), t.batcher.push('c', cand(3))];
    await vi.advanceTimersByTimeAsync(79);
    expect(t.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await Promise.all(p);
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.batches[0].map((i) => [i.to, label(i)])).toEqual([['b', 'c1'], ['b', 'c2'], ['c', 'c3']]);
  });

  it('o padrão é 80 ms', async () => {
    const t = setup();
    void t.batcher.push('b', cand(1));
    await vi.advanceTimersByTimeAsync(79);
    expect(t.send).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(t.send).toHaveBeenCalledTimes(1);
  });

  it('o prazo conta a partir do primeiro candidato do lote (não é empurrado por quem chega depois)', async () => {
    const t = setup({ delayMs: 80 });
    void t.batcher.push('b', cand(1));
    await vi.advanceTimersByTimeAsync(60);
    void t.batcher.push('b', cand(2));
    await vi.advanceTimersByTimeAsync(25);
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(t.batches[0]).toHaveLength(2);
  });
});

describe('sinais que não são candidatos', () => {
  it('a offer sai NA HORA, levando os candidatos pendentes na ordem', async () => {
    const t = setup({ delayMs: 80 });
    void t.batcher.push('b', cand(1));
    void t.batcher.push('b', cand(2));
    const p = t.batcher.push('b', offer);
    await p;
    expect(t.send).toHaveBeenCalledTimes(1); // sem avançar o relógio
    expect(t.batches[0].map(label)).toEqual(['c1', 'c2', 'offer']);
    await vi.advanceTimersByTimeAsync(200);
    expect(t.send).toHaveBeenCalledTimes(1); // o prazo antigo não reenvia nada
  });

  it('a answer e o reset sozinhos saem sem esperar, em chamadas de 1 item', async () => {
    const t = setup({ delayMs: 80 });
    await t.batcher.push('b', answer);
    await t.batcher.push('b', { gen: 0, kind: 'reset' });
    expect(t.batches.map((b) => b.map(label))).toEqual([['answer'], ['reset']]);
  });
});

describe('limite por lote', () => {
  it('ao atingir maxItems envia na hora e o resto segue o prazo; a ordem FIFO global se mantém', async () => {
    const t = setup({ delayMs: 80, maxItems: 3 });
    const all = Array.from({ length: 7 }, (_, i) => t.batcher.push('b', cand(i + 1)));
    await vi.advanceTimersByTimeAsync(0);
    expect(t.batches.map((b) => b.length)).toEqual([3, 3]); // dois lotes cheios já saíram
    await vi.advanceTimersByTimeAsync(80);
    await Promise.all(all);
    expect(t.batches.map((b) => b.length)).toEqual([3, 3, 1]);
    expect(t.batches.flat().map(label)).toEqual(['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7']);
  });

  it('uma offer com a fila acima do limite sai em lotes de no máximo maxItems, em ordem', async () => {
    const t = setup({ delayMs: 80, maxItems: 2 });
    const ps = [1, 2, 3].map((n) => t.batcher.push('b', cand(n)));
    ps.push(t.batcher.push('b', offer));
    await Promise.all(ps);
    expect(t.batches.every((b) => b.length <= 2)).toBe(true);
    expect(t.batches.flat().map(label)).toEqual(['c1', 'c2', 'c3', 'offer']);
  });
});

describe('ordem entre lotes', () => {
  it('um lote só sai depois que o anterior terminou (a ordem de chegada ao servidor é a de push)', async () => {
    let release!: () => void;
    const t = setup({ delayMs: 80 }, (items) => (items[0].data.kind === 'offer' ? new Promise<void>((r) => (release = r)) : Promise.resolve()));
    const first = t.batcher.push('b', offer); // envio lento
    const second = t.batcher.push('b', answer); // não pode passar na frente
    await vi.advanceTimersByTimeAsync(500);
    expect(t.batches.map((b) => b.map(label))).toEqual([['offer']]);
    release();
    await Promise.all([first, second]);
    expect(t.batches.map((b) => b.map(label))).toEqual([['offer'], ['answer']]);
  });
});

describe('resultado do envio', () => {
  it('o promise de cada push só resolve depois que o lote foi enviado', async () => {
    let release!: () => void;
    const t = setup({ delayMs: 10 }, () => new Promise<void>((r) => (release = r)));
    let done = false;
    const p = t.batcher.push('b', cand(1)).then(() => (done = true));
    await vi.advanceTimersByTimeAsync(10);
    expect(t.send).toHaveBeenCalledTimes(1);
    expect(done).toBe(false);
    release();
    await p;
    expect(done).toBe(true);
  });

  it('se o envio falha, TODOS os itens do lote rejeitam com o mesmo erro; o lote seguinte não é afetado', async () => {
    let n = 0;
    const err = new Error('rede');
    const t = setup({ delayMs: 10 }, async () => {
      if (++n === 1) throw err;
    });
    const a = t.batcher.push('b', cand(1));
    const b = t.batcher.push('b', cand(2));
    const settled = Promise.allSettled([a, b]);
    await vi.advanceTimersByTimeAsync(10);
    const r = await settled;
    expect(r.map((x) => x.status)).toEqual(['rejected', 'rejected']);
    expect((r[0] as PromiseRejectedResult).reason).toBe(err);
    expect((r[1] as PromiseRejectedResult).reason).toBe(err);
    // o próximo lote segue normalmente
    const c = t.batcher.push('b', cand(3));
    await vi.advanceTimersByTimeAsync(10);
    await expect(c).resolves.toBeUndefined();
  });
});

describe('flush e dispose', () => {
  it('flush envia o que está pendente na hora e resolve quando terminou', async () => {
    const t = setup({ delayMs: 1000 });
    const p = t.batcher.push('b', cand(1));
    await t.batcher.flush();
    expect(t.send).toHaveBeenCalledTimes(1);
    await expect(p).resolves.toBeUndefined();
  });

  it('flush sem nada pendente não chama send', async () => {
    const t = setup();
    await t.batcher.flush();
    expect(t.send).not.toHaveBeenCalled();
  });

  it('dispose cancela o timer SEM enviar e rejeita os pendentes com Error("disposed")', async () => {
    const t = setup({ delayMs: 80 });
    const p = t.batcher.push('b', cand(1));
    const settled = p.then(
      () => 'ok',
      (e: Error) => e.message,
    );
    t.batcher.dispose();
    await vi.advanceTimersByTimeAsync(500);
    expect(t.send).not.toHaveBeenCalled();
    expect(await settled).toBe('disposed');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('push depois de dispose rejeita na hora e não agenda nada', async () => {
    const t = setup();
    t.batcher.dispose();
    await expect(t.batcher.push('b', cand(1))).rejects.toThrow('disposed');
    expect(vi.getTimerCount()).toBe(0);
    expect(t.send).not.toHaveBeenCalled();
  });
});
