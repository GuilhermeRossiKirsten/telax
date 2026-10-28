/** Papel fixo por par: o menor peerId oferece, o outro só responde (sem glare por construção). */
export function isOfferer(selfId: string, otherId: string): boolean {
  return selfId < otherId;
}

/** Um sinal de geração anterior à atual pertence a uma negociação já abandonada. */
export function isStale(msgGen: number, currentGen: number): boolean {
  return msgGen < currentGen;
}

/** Executa tarefas na ordem de chegada com no máximo `concurrency` ao mesmo tempo. */
export class RestartQueue {
  private active = 0;
  private waiting: Array<() => void> = [];

  constructor(private concurrency = 2) {}

  async run(task: () => Promise<void>): Promise<void> {
    if (this.active >= this.concurrency) {
      // a vaga é entregue por quem terminou, sem passar por `active`, para ninguém furar a fila
      await new Promise<void>((resolve) => this.waiting.push(resolve));
    } else {
      this.active++;
    }
    try {
      await task();
    } finally {
      const next = this.waiting.shift();
      if (next) next();
      else this.active--;
    }
  }
}
