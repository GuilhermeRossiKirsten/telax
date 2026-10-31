'use client';

import { useEffect, useId, useRef } from 'react';
import type { useDevices } from '@/hooks/use-devices';
import type { QualityApi } from '@/hooks/use-quality';
import type { SoundsApi } from '@/hooks/use-sounds';
import { RoomPasswordSection, type RoomPasswordControls } from './RoomPasswordSection';
import { TransmissionSettings } from './TransmissionSettings';
import './settings-dialog.css';

type Props = {
  open: boolean;
  onClose(): void;
  devices: ReturnType<typeof useDevices>;
  quality: QualityApi;
  sounds: SoundsApi;
  /** o que a captura realmente entrega, por tipo */
  inUse: { camera: string; screen: string };
  participants: number;
  sharing: boolean;
  /** Seção "Sala" (senha); sem isto a seção não aparece. */
  roomPassword?: RoomPasswordControls;
};

const FOCUSABLE = 'select:not(:disabled), button:not(:disabled), [href], input:not(:disabled), [tabindex]:not([tabindex="-1"])';

export function SettingsDialog({ open, onClose, devices, sounds, quality, inUse, participants, sharing, roomPassword }: Props) {
  const card = useRef<HTMLDivElement>(null);
  const micField = useRef<HTMLSelectElement>(null);
  const micId = useId();
  const outId = useId();
  const soundsId = useId();
  // ref: um `onClose` inline do pai não pode reexecutar o efeito a cada render (roubaria o foco)
  const closeRef = useRef(onClose);
  useEffect(() => {
    closeRef.current = onClose;
  });

  useEffect(() => {
    if (!open) return;
    const opener = document.activeElement as HTMLElement | null;
    // sem microfone o campo está desabilitado e não recebe foco: o foco entra no próprio cartão
    if (micField.current && !micField.current.disabled) micField.current.focus();
    else card.current?.focus();

    // captura no document: o Esc fecha só a janela e não chega ao Esc da sala (que restaura a tela maximizada)
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        e.preventDefault();
        closeRef.current();
        return;
      }
      if (e.key !== 'Tab' || !card.current) return;
      const items = Array.from(card.current.querySelectorAll<HTMLElement>(FOCUSABLE));
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!card.current.contains(active)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('keydown', onKey, true);
      if (opener?.isConnected) opener.focus();
    };
  }, [open]);

  if (!open) return null;

  const { inputs, outputs, micId: mic, outputId: out, canChooseOutput } = devices;

  return (
    <div
      className="sd-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div ref={card} className="sd-card" role="dialog" aria-modal="true" aria-label="Configurações" tabIndex={-1}>
        <header className="sd-header">
          <h2 className="sd-title">Configurações</h2>
          <p className="sd-help">A troca vale na hora e fica lembrada neste navegador.</p>
        </header>

        {/* só o miolo rola: título e "Fechar" ficam sempre à vista */}
        <div className="sd-body">
        <h3 className="sd-subtitle">Áudio</h3>

        <div className="sd-field">
          <label htmlFor={micId}>Microfone</label>
          <select
            id={micId}
            ref={micField}
            value={mic}
            disabled={inputs.length === 0}
            onChange={(e) => devices.setMicId(e.target.value)}
          >
            {inputs.length === 0 && <option value="">Nenhum microfone encontrado</option>}
            {inputs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
        </div>

        <div className="sd-field">
          <label htmlFor={outId}>Saída de áudio (fone ou alto-falante)</label>
          <select
            id={outId}
            value={out}
            disabled={!canChooseOutput || outputs.length === 0}
            onChange={(e) => devices.setOutputId(e.target.value)}
          >
            {outputs.length === 0 && <option value="">Nenhuma saída encontrada</option>}
            {outputs.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </select>
          {!canChooseOutput && (
            <p className="sd-note">Este navegador não permite escolher a saída de áudio; o som sai pelo dispositivo padrão do sistema.</p>
          )}
        </div>

        <div className="sd-check">
          <input id={soundsId} type="checkbox" checked={sounds.enabled} onChange={(e) => sounds.setEnabled(e.target.checked)} />
          <label htmlFor={soundsId}>Tocar um som baixo quando alguém entrar ou sair da sala</label>
        </div>

        <TransmissionSettings api={quality} inUse={inUse} participants={participants} sharing={sharing} />

        {roomPassword && <RoomPasswordSection {...roomPassword} />}
        </div>

        <footer className="sd-actions">
          <button type="button" className="primary" onClick={onClose}>
            Fechar
          </button>
        </footer>
      </div>
    </div>
  );
}
