'use client';

import { useId } from 'react';
import type { QualityApi } from '@/hooks/use-quality';
import { CAMERA_OPTIONS, DEFAULT_QUALITY, SCREEN_OPTIONS, estimateUploadKbps } from '@/lib/quality';

type Props = {
  api: QualityApi;
  /** o que a captura realmente entrega, por tipo ("1280×720 a 30 fps") */
  inUse: { camera: string; screen: string };
  participants: number;
  sharing: boolean;
};

function Select<T extends string | number>(p: {
  label: string;
  value: T;
  options: ReadonlyArray<{ value: T; label: string }>;
  onChange(v: T): void;
}) {
  const id = useId();
  return (
    <div className="sd-field">
      <label htmlFor={id}>{p.label}</label>
      <select
        id={id}
        value={String(p.value)}
        onChange={(e) => {
          const picked = p.options.find((o) => String(o.value) === e.target.value);
          if (picked) p.onChange(picked.value);
        }}
      >
        {p.options.map((o) => (
          <option key={String(o.value)} value={String(o.value)}>
            {o.label}
          </option>
        ))}
      </select>
    </div>
  );
}

const formatMbps = (kbps: number) => (kbps >= 1000 ? `${(kbps / 1000).toFixed(1).replace('.', ',')} Mbps` : `${kbps} kbps`);

/** Seção "Transmissão" das Configurações: qualidade do que EU envio. Vale na hora e é lembrada. */
export function TransmissionSettings({ api, inUse, participants, sharing }: Props) {
  const { quality: q } = api;
  const sysAudioId = useId();
  const upload = estimateUploadKbps(q, participants, sharing);
  const isDefault = JSON.stringify(q) === JSON.stringify(DEFAULT_QUALITY);

  return (
    <section className="sd-section" aria-labelledby="sd-tx-title">
      <h3 id="sd-tx-title" className="sd-subtitle">
        Transmissão
      </h3>
      <p className="sd-help">
        Qualidade do que <strong>você envia</strong>. Mais resolução, fps e taxa de bits deixam a imagem melhor e usam mais internet e processamento.
      </p>

      <h4 className="sd-group">Câmera</h4>
      <Select label="Resolução da câmera" value={q.camera.resolution} options={CAMERA_OPTIONS.resolution} onChange={(resolution) => api.setCamera({ resolution })} />
      <Select label="FPS da câmera" value={q.camera.fps} options={CAMERA_OPTIONS.fps} onChange={(fps) => api.setCamera({ fps })} />
      <Select label="Taxa de bits máxima da câmera" value={q.camera.bitrateKbps} options={CAMERA_OPTIONS.bitrateKbps} onChange={(bitrateKbps) => api.setCamera({ bitrateKbps })} />
      {inUse.camera && <p className="sd-note" data-testid="in-use-camera">Em uso agora: {inUse.camera}</p>}

      <h4 className="sd-group">Tela compartilhada</h4>
      <Select label="Resolução da tela" value={q.screen.resolution} options={SCREEN_OPTIONS.resolution} onChange={(resolution) => api.setScreen({ resolution })} />
      <Select label="FPS da tela" value={q.screen.fps} options={SCREEN_OPTIONS.fps} onChange={(fps) => api.setScreen({ fps })} />
      <Select label="Taxa de bits máxima da tela" value={q.screen.bitrateKbps} options={SCREEN_OPTIONS.bitrateKbps} onChange={(bitrateKbps) => api.setScreen({ bitrateKbps })} />
      <Select label="Prioridade da tela" value={q.screen.priority} options={SCREEN_OPTIONS.priority} onChange={(priority) => api.setScreen({ priority })} />
      {sharing && inUse.screen && <p className="sd-note" data-testid="in-use-screen">Em uso agora: {inUse.screen}</p>}
      <div className="sd-check">
        <input
          id={sysAudioId}
          type="checkbox"
          checked={q.screen.systemAudio}
          onChange={(e) => api.setScreen({ systemAudio: e.target.checked })}
        />
        <label htmlFor={sysAudioId}>Incluir o áudio do sistema ao compartilhar a tela inteira</label>
      </div>
      <p className="sd-note" data-testid="system-audio-help">
        Vale para a próxima tela que você compartilhar{sharing ? ' (as que já estão abertas não mudam)' : ''}. O navegador só oferece o áudio do
        sistema ao compartilhar a tela inteira (Chrome/Edge no Windows); em abas o som da aba já vai. Atenção: o áudio do sistema
        inclui as vozes da chamada, então use fone para ninguém se ouvir (eco).
      </p>

      <p className="sd-note" data-testid="upload-estimate">
        {upload === undefined
          ? 'Sem limite de taxa definido: o navegador adapta à sua rede.'
          : `Com ${participants} ${participants === 1 ? 'pessoa' : 'pessoas'} na sala, o envio total pode chegar a ${formatMbps(upload)} (cada participante recebe um fluxo seu).`}
      </p>

      <div>
        <button type="button" className="ghost" onClick={api.reset} disabled={isDefault}>
          Restaurar automático
        </button>
      </div>
    </section>
  );
}
