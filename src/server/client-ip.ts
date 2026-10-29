import { isIP } from 'node:net';

/**
 * IP do cliente a partir dos cabeçalhos do proxy (Vercel preenche `x-forwarded-for` e `x-real-ip`).
 * Só devolve algo que PAREÇA um IP: o valor vai para o banco e para a lista de banimentos, então texto livre
 * ou tentativa de injeção vira `'unknown'`.
 */
export function clientIp(headers: Headers): string {
  return normalize(headers.get('x-forwarded-for')?.split(',')[0]) ?? normalize(headers.get('x-real-ip')) ?? 'unknown';
}

function normalize(raw: string | null | undefined): string | null {
  let value = raw?.trim().toLowerCase();
  if (!value || value.length > 45) return null;
  // IPv4 com porta ("1.2.3.4:5678"): só se for IPv4 puro com UMA porta
  const withPort = /^(\d{1,3}(?:\.\d{1,3}){3}):\d{1,5}$/.exec(value);
  if (withPort) value = withPort[1];
  // IPv4 mapeado em IPv6 ("::ffff:1.2.3.4") é o mesmo cliente que "1.2.3.4"
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(value);
  if (mapped) value = mapped[1];
  return isIP(value) ? value : null;
}
