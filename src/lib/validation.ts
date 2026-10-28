const MAX_LABEL = 40;
const MAX_CHAT = 2000;

function trimmed(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null;
  const value = raw.trim();
  return value.length >= 1 && value.length <= max ? value : null;
}

/** O Next entrega params de página ainda codificados; devolve a entrada se não der para decodificar. */
export function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export function normalizeRoom(raw: unknown): string | null {
  return trimmed(raw, MAX_LABEL)?.toLowerCase() ?? null;
}

export function normalizeName(raw: unknown): string | null {
  return trimmed(raw, MAX_LABEL);
}

export function normalizeChat(raw: unknown): string | null {
  return trimmed(raw, MAX_CHAT);
}
