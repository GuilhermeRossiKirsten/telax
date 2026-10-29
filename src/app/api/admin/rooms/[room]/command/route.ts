import type { AdminCommand } from '@/lib/admin-types';
import { MAX_SCREENS } from '@/lib/screens';
import { normalizeRoom } from '@/lib/validation';
import { adminRoute, invalidInput, isUuid, ok, readJsonBody } from '@/server/admin-route';

export const dynamic = 'force-dynamic';

const WHAT = ['screens', 'screen', 'camera', 'mic', 'all'] as const;

/** `slot` só existe (e é obrigatório) com `what: 'screen'`, inteiro de 0 a MAX_SCREENS - 1. */
function parseCommand(body: Record<string, unknown>): AdminCommand | null {
  const what = WHAT.find((w) => w === body.what);
  if (!what) return null;
  if (what === 'screen') {
    const slot = body.slot;
    if (typeof slot !== 'number' || !Number.isInteger(slot) || slot < 0 || slot >= MAX_SCREENS) return null;
    return { what, slot };
  }
  return body.slot === undefined ? { what } : null;
}

export const POST = adminRoute<{ room: string }>(async ({ req, store, params }) => {
  const room = normalizeRoom(params.room);
  const body = await readJsonBody(req);
  const cmd = body && parseCommand(body);
  if (!room || !body || !isUuid(body.peerId) || !cmd) return invalidInput();
  return ok({ ok: await store.command(room, body.peerId, cmd) });
});
