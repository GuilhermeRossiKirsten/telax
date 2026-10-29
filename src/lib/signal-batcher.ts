import type { SignalData } from './types';

export type SignalItem = { to: string; data: SignalData };

type Pending = SignalItem & { resolve(): void; reject(e: unknown): void };

export type SignalBatcher = {
  /** Enfileira um sinal. Resolve quando o lote que o contém foi enviado; rejeita com o erro do envio se ele falhar. */
  push(to: string, data: SignalData): Promise<void>;
  /** Envia na hora o que está pendente; resolve quando tudo o que foi enfileirado até aqui terminou de enviar. */
  flush(): Promise<void>;
  /** Cancela o prazo sem enviar e rejeita os pendentes com Error('disposed'). Depois disso `push` rejeita na hora. */
  dispose(): void;
};

/**
 * Junta sinais numa só requisição. Cada requisição à API é uma invocação de função (a Vercel gratuita tem 1 milhão
 * por mês), e uma entrada gera dezenas de candidatos ICE: um POST por candidato era o grosso do consumo.
 *
 * - Candidato ICE: espera até `delayMs` (contado desde o primeiro da fila) para ir junto com os vizinhos.
 * - Qualquer outro sinal (offer, answer, reset…): envia NA HORA a fila inteira, na ordem, então a negociação
 *   não fica mais lenta e os candidatos pendentes nunca ultrapassam a offer.
 * - Fila com `maxItems`: envia na hora lotes cheios.
 * - Um lote só sai depois que o anterior terminou: a ordem de chegada ao servidor é a ordem de `push`.
 */
export function createSignalBatcher(
  send: (items: SignalItem[]) => Promise<void>,
  opts: { delayMs?: number; maxItems?: number } = {},
): SignalBatcher {
  const delayMs = opts.delayMs ?? 80;
  const maxItems = Math.max(1, opts.maxItems ?? 25);

  let queue: Pending[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;
  /** Um envio por vez; nunca rejeita (cada item recebe o seu próprio resultado). */
  let chain: Promise<void> = Promise.resolve();

  function dispatch(batch: Pending[]) {
    chain = chain.then(async () => {
      try {
        await send(batch.map(({ to, data }) => ({ to, data })));
        for (const item of batch) item.resolve();
      } catch (e) {
        for (const item of batch) item.reject(e);
      }
    });
  }

  function clearTimer() {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  }

  /** Envia tudo o que há, em lotes de até `maxItems`. */
  function drain() {
    clearTimer();
    while (queue.length > 0) dispatch(queue.splice(0, maxItems));
  }

  return {
    push(to, data) {
      if (disposed) return Promise.reject(new Error('disposed'));
      const promise = new Promise<void>((resolve, reject) => queue.push({ to, data, resolve, reject }));
      if (data.kind !== 'candidate') {
        drain();
        return promise;
      }
      while (queue.length >= maxItems) dispatch(queue.splice(0, maxItems));
      if (queue.length > 0 && timer === undefined) {
        timer = setTimeout(() => {
          timer = undefined;
          drain();
        }, delayMs);
      }
      return promise;
    },

    async flush() {
      drain();
      await chain;
    },

    dispose() {
      disposed = true;
      clearTimer();
      const pending = queue;
      queue = [];
      for (const item of pending) item.reject(new Error('disposed'));
    },
  };
}
