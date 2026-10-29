import type { SignalData } from '@/lib/types';

export const MAX_SDP = 32 * 1024;
export const MAX_CANDIDATE = 2048;
export const MAX_BATCH = 50;
const MAX_MID = 64;
const MAX_UFRAG = 256;

const KINDS: readonly SignalData['kind'][] = ['offer', 'answer', 'candidate', 'reset'];

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const isUint = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isStr = (v: unknown, max: number): v is string => typeof v === 'string' && v.length <= max;

/** Campo opcional que aceita null: devolve false se presente e inválido. */
function optNullable(o: Obj, key: string, ok: (v: unknown) => boolean, out: Obj): boolean {
  if (!(key in o) || o[key] === undefined) return true;
  if (o[key] !== null && !ok(o[key])) return false;
  out[key] = o[key];
  return true;
}

function parseCandidate(raw: unknown): RTCIceCandidateInit | null {
  if (!isObj(raw) || !isStr(raw.candidate, MAX_CANDIDATE)) return null;
  const out: Obj = { candidate: raw.candidate };
  const valid =
    optNullable(raw, 'sdpMid', (v) => isStr(v, MAX_MID), out) &&
    optNullable(raw, 'sdpMLineIndex', isUint, out) &&
    optNullable(raw, 'usernameFragment', (v) => isStr(v, MAX_UFRAG), out);
  return valid ? (out as RTCIceCandidateInit) : null;
}

/** Reconstrói o sinal só com campos conhecidos e limitados; null se algo for inválido. */
export function parseSignal(raw: unknown): SignalData | null {
  if (!isObj(raw) || !isUint(raw.gen) || !KINDS.includes(raw.kind as SignalData['kind'])) return null;
  const out: SignalData = { gen: raw.gen, kind: raw.kind as SignalData['kind'] };
  if (raw.sid !== undefined) {
    if (!Number.isSafeInteger(raw.sid)) return null;
    out.sid = raw.sid as number;
  }
  if (raw.sdp !== undefined) {
    if (!isStr(raw.sdp, MAX_SDP)) return null;
    out.sdp = raw.sdp;
  }
  if (raw.candidate !== undefined) {
    const candidate = parseCandidate(raw.candidate);
    if (!candidate) return null;
    out.candidate = candidate;
  }
  return out;
}

/**
 * Lote de sinais: 1..MAX_BATCH itens `{ to, data }`. Tudo ou nada: qualquer item inválido invalida o lote inteiro,
 * para que nada seja aplicado pela metade. Cada `data` é reconstruído por parseSignal (só campos conhecidos).
 */
export function parseSignalItems(raw: unknown): Array<{ to: string; data: SignalData }> | null {
  if (!Array.isArray(raw) || raw.length < 1 || raw.length > MAX_BATCH) return null;
  const out: Array<{ to: string; data: SignalData }> = [];
  for (const it of raw) {
    if (!isObj(it) || typeof it.to !== 'string' || it.to.length === 0) return null;
    const data = parseSignal(it.data);
    if (!data) return null;
    out.push({ to: it.to, data });
  }
  return out;
}
