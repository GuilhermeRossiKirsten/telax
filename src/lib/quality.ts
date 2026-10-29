/** Qualidade do que eu envio (câmera e tela): presets, validação do que está salvo e tradução para o navegador. */

export type CameraResolution = 'auto' | '360p' | '480p' | '720p' | '1080p';
export type ScreenResolution = 'auto' | '720p' | '1080p';
export type ScreenPriority = 'balanced' | 'motion' | 'detail';

export type CameraQuality = { resolution: CameraResolution; fps: number; bitrateKbps: number };
export type ScreenQuality = { resolution: ScreenResolution; fps: number; bitrateKbps: number; priority: ScreenPriority };
export type QualitySettings = { camera: CameraQuality; screen: ScreenQuality };

/** 0 em `fps` e `bitrateKbps` significa automático. */
export const DEFAULT_QUALITY: QualitySettings = {
  camera: { resolution: 'auto', fps: 0, bitrateKbps: 0 },
  screen: { resolution: 'auto', fps: 0, bitrateKbps: 0, priority: 'balanced' },
};

type Option<T> = { value: T; label: string };

export const CAMERA_OPTIONS = {
  resolution: [
    { value: 'auto', label: 'Automática' },
    { value: '360p', label: '360p' },
    { value: '480p', label: '480p' },
    { value: '720p', label: '720p (HD)' },
    { value: '1080p', label: '1080p (Full HD)' },
  ] as Option<CameraResolution>[],
  fps: [
    { value: 0, label: 'Automático' },
    { value: 15, label: '15 fps' },
    { value: 24, label: '24 fps' },
    { value: 30, label: '30 fps' },
  ] as Option<number>[],
  bitrateKbps: [
    { value: 0, label: 'Automática' },
    { value: 300, label: '300 kbps (economia)' },
    { value: 800, label: '800 kbps' },
    { value: 1500, label: '1,5 Mbps' },
    { value: 3000, label: '3 Mbps' },
  ] as Option<number>[],
};

export const SCREEN_OPTIONS = {
  resolution: [
    { value: 'auto', label: 'Automática (nativa)' },
    { value: '720p', label: '720p' },
    { value: '1080p', label: '1080p (Full HD)' },
  ] as Option<ScreenResolution>[],
  fps: [
    { value: 0, label: 'Automático' },
    { value: 5, label: '5 fps (slides, texto)' },
    { value: 15, label: '15 fps' },
    { value: 30, label: '30 fps' },
    { value: 60, label: '60 fps (vídeo, jogos)' },
  ] as Option<number>[],
  bitrateKbps: [
    { value: 0, label: 'Automática' },
    { value: 1000, label: '1 Mbps' },
    { value: 2500, label: '2,5 Mbps' },
    { value: 5000, label: '5 Mbps' },
    { value: 8000, label: '8 Mbps' },
  ] as Option<number>[],
  priority: [
    { value: 'balanced', label: 'Equilibrada' },
    { value: 'motion', label: 'Movimento fluido (vídeo, jogos)' },
    { value: 'detail', label: 'Nitidez do texto (documentos, código)' },
  ] as Option<ScreenPriority>[],
};

const SIZES: Record<string, { width: number; height: number }> = {
  '360p': { width: 640, height: 360 },
  '480p': { width: 854, height: 480 },
  '720p': { width: 1280, height: 720 },
  '1080p': { width: 1920, height: 1080 },
};

const pick = <T>(options: Option<T>[], raw: unknown, fallback: T): T =>
  options.some((o) => o.value === raw) ? (raw as T) : fallback;
const asObject = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {});

/** Valores desconhecidos (lixo salvo, lista que mudou) voltam ao automático, campo a campo. */
export function sanitizeQuality(raw: unknown): QualitySettings {
  const root = asObject(raw);
  const cam = asObject(root.camera);
  const scr = asObject(root.screen);
  const d = DEFAULT_QUALITY;
  return {
    camera: {
      resolution: pick(CAMERA_OPTIONS.resolution, cam.resolution, d.camera.resolution),
      fps: pick(CAMERA_OPTIONS.fps, cam.fps, d.camera.fps),
      bitrateKbps: pick(CAMERA_OPTIONS.bitrateKbps, cam.bitrateKbps, d.camera.bitrateKbps),
    },
    screen: {
      resolution: pick(SCREEN_OPTIONS.resolution, scr.resolution, d.screen.resolution),
      fps: pick(SCREEN_OPTIONS.fps, scr.fps, d.screen.fps),
      bitrateKbps: pick(SCREEN_OPTIONS.bitrateKbps, scr.bitrateKbps, d.screen.bitrateKbps),
      priority: pick(SCREEN_OPTIONS.priority, scr.priority, d.screen.priority),
    },
  };
}

const KEY = 'telax:quality';

export function loadQuality(storage?: Pick<Storage, 'getItem'>): QualitySettings {
  try {
    const raw = (storage ?? localStorage).getItem(KEY);
    return sanitizeQuality(raw ? JSON.parse(raw) : null);
  } catch {
    return DEFAULT_QUALITY; // sem localStorage ou JSON inválido
  }
}

export function saveQuality(q: QualitySettings, storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? localStorage).setItem(KEY, JSON.stringify(q));
  } catch {
    /* modo privado ou cota cheia: vale só nesta visita */
  }
}

/**
 * Restrições para `applyConstraints`. O automático também pede algo explícito (720p/30 na câmera; um teto alto
 * na tela, que a captura limita à resolução nativa), para que voltar de um valor alto realmente volte.
 */
export function toVideoConstraints(kind: 'camera' | 'screen', q: QualitySettings): MediaTrackConstraints {
  const s = kind === 'camera' ? q.camera : q.screen;
  const size = s.resolution === 'auto' ? (kind === 'camera' ? SIZES['720p'] : { width: 3840, height: 2160 }) : SIZES[s.resolution];
  return {
    width: { ideal: size.width },
    height: { ideal: size.height },
    frameRate: { ideal: s.fps || 30 },
  };
}

export type SendLimits = {
  camera: { maxBitrate?: number; maxFramerate?: number };
  screen: { maxBitrate?: number; maxFramerate?: number };
};

/** Tetos de envio por conexão (bits/s e fps); `undefined` = sem limite. */
export function toSendQuality(q: QualitySettings): SendLimits {
  return {
    camera: { maxBitrate: q.camera.bitrateKbps ? q.camera.bitrateKbps * 1000 : undefined, maxFramerate: q.camera.fps || undefined },
    screen: { maxBitrate: q.screen.bitrateKbps ? q.screen.bitrateKbps * 1000 : undefined, maxFramerate: q.screen.fps || undefined },
  };
}

export const contentHintFor = (p: ScreenPriority): '' | 'motion' | 'detail' => (p === 'balanced' ? '' : p);

/**
 * Envio total estimado em kbps: cada outro participante recebe um fluxo próprio (malha completa).
 * Sem teto definido não há como estimar (depende da rede), então devolve `undefined`.
 */
export function estimateUploadKbps(q: QualitySettings, participants: number, sharing: boolean): number | undefined {
  const others = Math.max(0, participants - 1);
  if (!q.camera.bitrateKbps) return undefined;
  if (sharing && !q.screen.bitrateKbps) return undefined;
  return (q.camera.bitrateKbps + (sharing ? q.screen.bitrateKbps : 0)) * others;
}

/** O que a captura realmente entrega ("1280×720 a 30 fps"), para mostrar quando difere do pedido. */
export function describeActual(s: Pick<MediaTrackSettings, 'width' | 'height' | 'frameRate'> | undefined): string {
  if (!s) return '';
  const size = s.width && s.height ? `${s.width}×${s.height}` : '';
  const fps = s.frameRate ? `${Math.round(s.frameRate)} fps` : '';
  return [size, fps].filter(Boolean).join(size && fps ? ' a ' : '');
}
