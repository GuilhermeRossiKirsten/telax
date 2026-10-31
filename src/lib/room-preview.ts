/** Preview da sala na tela inicial: "esta sala já existe" e quantas pessoas estão nela. Só dados públicos e mínimos. */

export type RoomPreview = { count: number; closed: boolean; protected: boolean };
export type RoomPreviewText = { tone: 'live' | 'closed'; text: string };

/** O que mostrar sob o campo "Nome da sala"; `null` = a sala não existe (nada a mostrar). */
export function describeRoomPreview(p: RoomPreview | null): RoomPreviewText | null {
  if (!p) return null;
  if (p.closed) return { tone: 'closed', text: 'Esta sala existe, mas foi encerrada pelo administrador.' };
  if (p.count <= 0) {
    // uma sala protegida por senha segue existindo mesmo sem ninguém dentro (a senha vale até a sala ficar sem uso)
    return p.protected ? { tone: 'live', text: 'Esta sala já existe e é protegida por senha.' } : null;
  }
  const people = p.count === 1 ? '1 pessoa' : `${p.count} pessoas`;
  return { tone: 'live', text: `Esta sala já existe: ${people} na sala agora.${p.protected ? ' Ela é protegida por senha.' : ''}` };
}

type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

/**
 * Consulta a rota pública de preview. Qualquer resposta fora do contrato (erro, formato errado, rede) vira `null`: a
 * tela simplesmente não mostra nada. Só `count`, `closed` e `protected` são aproveitados, ainda que o servidor mande mais.
 */
export async function fetchRoomPreview(room: string, fetchFn: FetchLike = fetch, signal?: AbortSignal): Promise<RoomPreview | null> {
  const name = room.trim();
  if (!name) return null;
  try {
    const res = await fetchFn(`/api/rooms/${encodeURIComponent(name)}/preview`, { signal, cache: 'no-store' });
    if (!res.ok) return null;
    const body = (await res.json()) as { count?: unknown; closed?: unknown; protected?: unknown } | null;
    if (!body || typeof body !== 'object') return null;
    if (typeof body.count !== 'number' || !Number.isInteger(body.count) || body.count < 0) return null;
    if (typeof body.closed !== 'boolean') return null;
    // servidor que ainda não manda `protected` vale como "sem senha"; um valor que não é booleano é lixo
    if (body.protected !== undefined && typeof body.protected !== 'boolean') return null;
    return { count: body.count, closed: body.closed, protected: body.protected ?? false };
  } catch {
    return null;
  }
}
