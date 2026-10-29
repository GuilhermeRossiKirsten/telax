'use client';

import { useEffect, useId, useRef, useState } from 'react';
import { normalizeReason } from '@/lib/admin-ui';
import { AdminApiError } from '@/lib/admin-client';
import './admin.css';

type Props = {
  /** texto do botão que abre a confirmação (já com o alvo: "Expulsar Beto") */
  label: string;
  /** frase que explica o efeito, mostrada antes de confirmar */
  description: string;
  confirmLabel?: string;
  /** pede um motivo (opcional) antes de confirmar */
  withReason?: boolean;
  danger?: boolean;
  small?: boolean;
  disabled?: boolean;
  /** executa a ação; o motivo já vem aparado (ou undefined). Lançar erro mostra a mensagem. */
  onConfirm(reason: string | undefined): Promise<void>;
};

/**
 * Ação destrutiva com confirmação EXPLÍCITA: o botão só abre o aviso; nada acontece até "Confirmar".
 * Esc ou "Cancelar" fecham. O foco vai para o motivo (ou para "Confirmar") ao abrir.
 */
export function ConfirmAction({ label, description, confirmLabel = 'Confirmar', withReason = false, danger = true, small = true, disabled, onConfirm }: Props) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const reasonId = useId();
  const first = useRef<HTMLInputElement>(null);
  const confirmBtn = useRef<HTMLButtonElement>(null);
  const opener = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    (first.current ?? confirmBtn.current)?.focus();
  }, [open]);

  function close() {
    setOpen(false);
    setReason('');
    setError(null);
    opener.current?.focus();
  }

  async function confirm() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm(withReason ? normalizeReason(reason) : undefined);
      setOpen(false);
      setReason('');
    } catch (e) {
      setError(e instanceof AdminApiError ? e.message : 'Não foi possível concluir a ação.');
    } finally {
      setBusy(false);
    }
  }

  if (!open) {
    return (
      <button
        ref={opener}
        type="button"
        className={`adm-btn ${small ? 'adm-btn-sm' : ''} ${danger ? 'adm-btn-danger' : ''}`}
        aria-haspopup="true"
        aria-expanded={false}
        disabled={disabled}
        onClick={() => setOpen(true)}
      >
        {label}
      </button>
    );
  }

  return (
    <div
      className="adm-confirm"
      role="group"
      aria-label={`Confirmar: ${label}`}
      onKeyDown={(e) => {
        if (e.key === 'Escape') {
          e.stopPropagation();
          close();
        }
      }}
    >
      <p>{description}</p>
      {withReason && (
        <div>
          <label htmlFor={reasonId} className="adm-muted">
            Motivo (opcional, aparece para a pessoa)
          </label>
          <input
            id={reasonId}
            ref={first}
            className="adm-input"
            value={reason}
            maxLength={200}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !busy) void confirm();
            }}
          />
        </div>
      )}
      {error && (
        <p role="alert" className="adm-feedback" data-kind="error">
          {error}
        </p>
      )}
      <div className="adm-confirm-buttons">
        <button ref={confirmBtn} type="button" className={`adm-btn adm-btn-sm ${danger ? 'adm-btn-confirm' : 'adm-btn-primary'}`} disabled={busy} onClick={() => void confirm()}>
          {busy ? 'Aguarde…' : confirmLabel}
        </button>
        <button type="button" className="adm-btn adm-btn-sm" disabled={busy} onClick={close}>
          Cancelar
        </button>
      </div>
    </div>
  );
}
