/** Dispositivos de áudio: listagem, escolha, saída (`setSinkId`) e preferências salvas no navegador. */

/** `generic`: o rótulo foi gerado por nós (sem permissão o navegador não informa o nome); não serve para reencontrar o dispositivo. */
export type DeviceOption = { id: string; label: string; generic?: true };
/**
 * Os rótulos servem de reserva: alguns navegadores geram ids novos para os mesmos dispositivos
 * (ao limpar dados do site, em janela anônima, a cada carregamento), mas o nome continua igual.
 */
export type DevicePrefs = {
  micId: string | null;
  outputId: string | null;
  micLabel?: string;
  outputLabel?: string;
};

const PREFS_KEY = 'telax:devices';
const DEFAULT_LABEL = { audioinput: 'Microfone', audiooutput: 'Saída' } as const;

export function toOptions(
  list: ReadonlyArray<{ deviceId: string; kind: string; label: string }>,
  kind: 'audioinput' | 'audiooutput',
): DeviceOption[] {
  const seen = new Set<string>();
  const options: DeviceOption[] = [];
  for (const d of list) {
    if (d.kind !== kind || !d.deviceId || seen.has(d.deviceId)) continue;
    seen.add(d.deviceId);
    // sem permissão de mídia os rótulos vêm vazios
    const label = d.label.trim();
    options.push(
      label
        ? { id: d.deviceId, label }
        : { id: d.deviceId, label: `${DEFAULT_LABEL[kind]} ${options.length + 1}`, generic: true },
    );
  }
  return options;
}

/** O preferido (pelo id, ou pelo rótulo se o id mudou) se ainda existir; senão o padrão do sistema; senão o primeiro; senão nada. */
export function pickDevice(
  options: DeviceOption[],
  preferredId: string | null | undefined,
  preferredLabel?: string | null,
): string {
  if (preferredId && options.some((o) => o.id === preferredId)) return preferredId;
  // só casa pelo rótulo quando ele é único: dois aparelhos iguais ("USB Audio Device") cairiam sempre no primeiro
  const sameLabel = preferredLabel ? options.filter((o) => o.label === preferredLabel) : [];
  if (sameLabel.length === 1) return sameLabel[0].id;
  if (options.some((o) => o.id === 'default')) return 'default';
  return options[0]?.id ?? '';
}

type SinkTarget = { setSinkId?: (id: string) => Promise<void> };

export function supportsSinkId(el?: unknown): boolean {
  if (el !== undefined) return typeof (el as SinkTarget | null)?.setSinkId === 'function';
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

/** Aponta o som de um <video>/<audio> para a saída escolhida. Nunca lança: dispositivo removido ou sem permissão só devolve false. */
export async function applySinkId(el: HTMLMediaElement, id: string): Promise<boolean> {
  if (!id || !supportsSinkId(el)) return false;
  try {
    await (el as unknown as Required<SinkTarget>).setSinkId(id);
    return true;
  } catch {
    return false;
  }
}

const asId = (v: unknown) => (typeof v === 'string' && v ? v : null);

export function loadDevicePrefs(storage?: Pick<Storage, 'getItem'>): DevicePrefs {
  try {
    const raw = (storage ?? localStorage).getItem(PREFS_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === 'object') {
      const p = parsed as Record<string, unknown>;
      const prefs: DevicePrefs = { micId: asId(p.micId), outputId: asId(p.outputId) };
      const micLabel = asId(p.micLabel);
      const outputLabel = asId(p.outputLabel);
      if (micLabel) prefs.micLabel = micLabel;
      if (outputLabel) prefs.outputLabel = outputLabel;
      return prefs;
    }
  } catch {
    /* sem localStorage ou conteúdo inválido: segue sem preferências */
  }
  return { micId: null, outputId: null };
}

export function saveDevicePrefs(prefs: DevicePrefs, storage?: Pick<Storage, 'setItem'>): void {
  try {
    (storage ?? localStorage).setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    /* modo privado ou cota cheia: a escolha só vale nesta visita */
  }
}
