/**
 * Toques curtos e BAIXOS de entrada e saída da sala, sintetizados com Web Audio (sem arquivos de áudio).
 * Entrar: duas notas subindo. Sair: duas notas descendo.
 */

export type ChimeKind = 'join' | 'leave';
export type ChimeNote = { freq: number; /** s, a partir do início do toque */ start: number; duration: number; /** pico, 0..1 */ gain: number };

const PEAK = 0.06; // bem baixo: um indicador, não um alerta

export function chimeNotes(kind: ChimeKind): ChimeNote[] {
  const [a, b] = kind === 'join' ? [587, 880] : [740, 494];
  return [
    { freq: a, start: 0, duration: 0.16, gain: PEAK },
    { freq: b, start: 0.12, duration: 0.2, gain: PEAK },
  ];
}

/** Tempo total de um toque, em segundos (usado para enfileirar toques sem sobrepor). */
const CHIME_SPAN = 0.4;

// --- preferências -----------------------------------------------------------

export const SOUND_PREFS_KEY = 'telax:sounds';
export type SoundPrefs = { enabled: boolean };

/** Ligado por padrão; qualquer coisa inesperada no armazenamento volta ao padrão. */
export function loadSoundPrefs(storage?: Pick<Storage, 'getItem'>): SoundPrefs {
  try {
    const raw = (storage ?? localStorage).getItem(SOUND_PREFS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object' && typeof (parsed as { enabled?: unknown }).enabled === 'boolean') {
      return { enabled: (parsed as SoundPrefs).enabled };
    }
  } catch {
    /* sem localStorage ou JSON inválido */
  }
  return { enabled: true };
}

export function saveSoundPrefs(prefs: SoundPrefs, storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? localStorage).setItem(SOUND_PREFS_KEY, JSON.stringify({ enabled: prefs.enabled }));
  } catch {
    /* modo privado ou cota cheia: vale só nesta visita */
  }
}

// --- reprodução -------------------------------------------------------------

type SinkContext = AudioContext & { setSinkId?: (id: string) => Promise<void> };

let ctx: SinkContext | null = null;
let appliedSink = '';

function context(): SinkContext | null {
  if (typeof window === 'undefined') return null;
  const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!Ctor) return null;
  if (!ctx || ctx.state === 'closed') {
    ctx = new Ctor() as SinkContext;
    appliedSink = '';
  }
  return ctx;
}

/** O contexto pode nascer suspenso (autoplay): tenta retomar por pouco tempo; se não der, fica em silêncio. */
async function ready(c: AudioContext): Promise<boolean> {
  if (c.state === 'running') return true;
  try {
    await Promise.race([c.resume(), new Promise<void>((resolve) => setTimeout(resolve, 300))]);
  } catch {
    /* sem permissão para tocar */
  }
  return (c.state as AudioContextState) === 'running'; // o estado pode ter mudado durante o await
}

async function routeTo(c: SinkContext, sinkId?: string) {
  if (!sinkId || sinkId === appliedSink || typeof c.setSinkId !== 'function') return;
  try {
    await c.setSinkId(sinkId);
    appliedSink = sinkId;
  } catch {
    /* dispositivo sumiu ou sem permissão: segue na saída padrão */
  }
}

function schedule(c: AudioContext, kind: ChimeKind, at: number) {
  for (const n of chimeNotes(kind)) {
    const t = at + n.start;
    const osc = c.createOscillator();
    const amp = c.createGain();
    osc.type = 'sine';
    osc.frequency.value = n.freq;
    amp.gain.setValueAtTime(0.0001, t);
    amp.gain.linearRampToValueAtTime(n.gain, t + 0.015);
    amp.gain.exponentialRampToValueAtTime(0.0001, t + n.duration);
    osc.connect(amp).connect(c.destination);
    osc.start(t);
    osc.stop(t + n.duration + 0.02);
  }
}

/**
 * Toca os toques de uma mudança de presença: vários eventos simultâneos viram UM toque de cada tipo,
 * e se houver os dois, sai primeiro e entra depois. Nunca lança.
 */
export async function playPresenceChimes(change: { joined: number; left: number }, sinkId?: string): Promise<void> {
  if (change.joined <= 0 && change.left <= 0) return;
  try {
    const c = context();
    if (!c || !(await ready(c))) return;
    await routeTo(c, sinkId);
    let at = c.currentTime + 0.02;
    if (change.left > 0) {
      schedule(c, 'leave', at);
      at += CHIME_SPAN;
    }
    if (change.joined > 0) schedule(c, 'join', at);
  } catch {
    /* som é um enfeite: nunca derruba a sala */
  }
}
