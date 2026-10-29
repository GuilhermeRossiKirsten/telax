/** Telas compartilhadas por uma mesma pessoa: slots fixos, para que a identidade de cada tela não mude quando outra para. */

export const MAX_SCREENS = 3;
export const FULL_SLOT_MASK = (1 << MAX_SCREENS) - 1;

/** Slots ativos (0-based) de uma máscara de bits; bits acima do limite são ignorados. */
export function slotsFromMask(mask: number): number[] {
  const slots: number[] = [];
  for (let i = 0; i < MAX_SCREENS; i++) if (mask & (1 << i)) slots.push(i);
  return slots;
}

export function maskFromSlots(slots: ReadonlyArray<number>): number {
  return slots.reduce((m, s) => (Number.isInteger(s) && s >= 0 && s < MAX_SCREENS ? m | (1 << s) : m), 0);
}

/** Máscara válida vinda da rede: inteiro entre 0 e todos os slots ligados. */
export const isSlotMask = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= FULL_SLOT_MASK;

/** "Tela de Ana" (slot 0) ou "Tela 2 de Ana". */
export const screenLabel = (name: string, slot: number) => (slot === 0 ? `Tela de ${name}` : `Tela ${slot + 1} de ${name}`);
/** "som da aba de Ana" (slot 0) ou "som da aba 2 de Ana". */
export const screenSound = (name: string, slot: number) => (slot === 0 ? `som da aba de ${name}` : `som da aba ${slot + 1} de ${name}`);
/** "tela" (slot 0) ou "tela 2": para montar "Ver tela 2 de Ana", "Parar de compartilhar tela 2"... */
export const screenWord = (slot: number) => (slot === 0 ? 'tela' : `tela ${slot + 1}`);
