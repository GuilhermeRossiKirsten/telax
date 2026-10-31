import { invalid, json, postRoute } from '@/server/http';
import { hashPassword, validatePassword, type PasswordRecord } from '@/server/room-password';
import { UnknownPeerError } from '@/server/room-store';

export const dynamic = 'force-dynamic';

/**
 * Liga, troca ou remove a senha da sala. Autenticada pelo token do peer (via `postRoute`) e SÓ O ANFITRIÃO
 * (o participante mais antigo) pode: os outros recebem 403 `not_host`. A senha é hasheada (scrypt) aqui e só o hash vai
 * para o armazenamento; a resposta traz apenas `{ protected }`.
 */
export const POST = postRoute(async (store, room, body) => {
  const peerId = body.peerId as string;
  if (body.action !== 'set' && body.action !== 'clear') return invalid();
  let record: PasswordRecord | null = null;
  if (body.action === 'set') {
    const password = validatePassword(body.password);
    if (password === null) return invalid();
    // quem não é anfitrião é recusado ANTES do scrypt: pedir hash repetido não vira consumo de CPU
    if (!(await store.isRoomHost(room, peerId))) return json({ error: 'not_host' }, 403);
    record = await hashPassword(password);
  }
  const result = await store.setRoomPassword(room, peerId, record);
  if (result === 'unknown_peer') throw new UnknownPeerError(); // saiu entre a autenticação e agora: 410
  if (result === 'not_host') return json({ error: 'not_host' }, 403);
  return json({ protected: record !== null });
}, 'peerId');
