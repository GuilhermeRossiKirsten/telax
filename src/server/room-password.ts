import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

/** Como a senha foi derivada. Fica junto do registro: dá para subir o custo no futuro sem invalidar senhas antigas. */
export type PasswordParams = { N: number; r: number; p: number; keylen: number };
/** O que se guarda da senha da sala: nunca o texto, só sal + derivação (tudo em base64). */
export type PasswordRecord = { salt: string; hash: string; params: PasswordParams };

export const PASSWORD_MIN = 4;
export const PASSWORD_MAX = 64;

const SALT_BYTES = 16;
const DEFAULT_PARAMS: PasswordParams = { N: 16384, r: 8, p: 1, keylen: 64 };
/** Teto dos parâmetros lidos do banco: um registro adulterado não pode pedir minutos de CPU. */
const MAX_N = 1 << 17;

const derive = (password: string, salt: Buffer, { N, r, p, keylen }: PasswordParams) =>
  new Promise<Buffer>((resolve, reject) => {
    // maxmem acompanha N*r: o padrão do Node (32 MiB) já cobre N=16384, r=8 (16 MiB), mas não o teto de MAX_N
    scrypt(password, salt, keylen, { N, r, p, maxmem: 256 * N * r }, (err, key) => (err ? reject(err) : resolve(key)));
  });

/** Texto da senha se estiver nos limites (4..64, sem aparar espaços), senão `null`. */
export function validatePassword(raw: unknown): string | null {
  return typeof raw === 'string' && raw.length >= PASSWORD_MIN && raw.length <= PASSWORD_MAX ? raw : null;
}

export async function hashPassword(password: string): Promise<PasswordRecord> {
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, DEFAULT_PARAMS);
  return { salt: salt.toString('base64'), hash: key.toString('base64'), params: { ...DEFAULT_PARAMS } };
}

/** Compara em tempo constante. Registro malformado ou senha que não é texto = `false`, nunca exceção. */
export async function verifyPassword(password: string, record: PasswordRecord): Promise<boolean> {
  try {
    if (typeof password !== 'string' || !record || typeof record.salt !== 'string' || typeof record.hash !== 'string') return false;
    const { N, r, p, keylen } = record.params ?? ({} as PasswordParams);
    const sane =
      Number.isInteger(N) && N >= 2 && N <= MAX_N && (N & (N - 1)) === 0 &&
      Number.isInteger(r) && r >= 1 && r <= 16 &&
      Number.isInteger(p) && p >= 1 && p <= 4 &&
      Number.isInteger(keylen) && keylen >= 16 && keylen <= 128;
    if (!sane) return false;
    const salt = Buffer.from(record.salt, 'base64');
    const expected = Buffer.from(record.hash, 'base64');
    if (salt.length === 0 || expected.length !== keylen) return false;
    const actual = await derive(password, salt, { N, r, p, keylen });
    return timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}
