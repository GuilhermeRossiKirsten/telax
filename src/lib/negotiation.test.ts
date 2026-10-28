import { describe, expect, it } from 'vitest';
import { RestartQueue, isOfferer, isStale } from './negotiation';

describe('isOfferer', () => {
  it('o menor id oferece, o maior responde — nunca os dois', () => {
    expect(isOfferer('a', 'b')).toBe(true);
    expect(isOfferer('b', 'a')).toBe(false);
  });
});

describe('isStale', () => {
  it('só gen estritamente menor é obsoleto', () => {
    expect(isStale(1, 2)).toBe(true);
    expect(isStale(2, 2)).toBe(false);
    expect(isStale(3, 2)).toBe(false);
  });
});

describe('RestartQueue', () => {
  it('nunca executa mais tarefas simultâneas que a concorrência e conclui todas', async () => {
    const queue = new RestartQueue(2);
    let active = 0;
    let peak = 0;
    let done = 0;
    const task = async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((r) => setTimeout(r, 5));
      active--;
      done++;
    };
    await Promise.all(Array.from({ length: 5 }, () => queue.run(task)));
    expect(peak).toBe(2);
    expect(done).toBe(5);
  });

  it('respeita a ordem de chegada', async () => {
    const queue = new RestartQueue(1);
    const order: number[] = [];
    await Promise.all([1, 2, 3].map((n) => queue.run(async () => void order.push(n))));
    expect(order).toEqual([1, 2, 3]);
  });

  it('tarefa que lança não bloqueia as seguintes e rejeita só a sua promessa', async () => {
    const queue = new RestartQueue(1);
    let ran = false;
    const failing = queue.run(async () => {
      throw new Error('boom');
    });
    const next = queue.run(async () => {
      ran = true;
    });
    await expect(failing).rejects.toThrow('boom');
    await next;
    expect(ran).toBe(true);
  });
});
