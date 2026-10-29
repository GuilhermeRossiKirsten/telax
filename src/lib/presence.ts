/** Diferença de presença entre dois retratos da lista de participantes, sem contar a própria pessoa. */
export function diffPresence(
  prevIds: ReadonlyArray<string>,
  nextIds: ReadonlyArray<string>,
  selfId: string | null,
): { joined: number; left: number } {
  const prev = new Set(prevIds.filter((id) => id !== selfId));
  const next = new Set(nextIds.filter((id) => id !== selfId));
  let joined = 0;
  let left = 0;
  for (const id of next) if (!prev.has(id)) joined += 1;
  for (const id of prev) if (!next.has(id)) left += 1;
  return { joined, left };
}
