'use client';

import { useId, useState, type FormEvent } from 'react';
import { ADMIN_MESSAGE_MAX } from '@/lib/admin-types';
import { validateText } from '@/lib/admin-ui';
import './admin.css';

type Props = {
  title: string;
  description?: string;
  placeholder?: string;
  submitLabel: string;
  /** envia a mensagem; lançar erro o mostra. Devolve quantas pessoas receberam. */
  onSend(text: string): Promise<number>;
  onCancel?(): void;
};

/** Mensagem do administrador (à sala ou a todas as salas): valida, envia e mostra quantas pessoas receberam. */
export function MessageForm({ title, description, placeholder = 'Escreva a mensagem…', submitLabel, onSend, onCancel }: Props) {
  const id = useId();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<string | null>(null);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const problem = validateText(text, ADMIN_MESSAGE_MAX);
    if (problem) {
      setError(problem);
      setSent(null);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const delivered = await onSend(text.trim());
      setSent(delivered === 1 ? 'Mensagem entregue a 1 pessoa.' : `Mensagem entregue a ${delivered} pessoas.`);
      setText('');
    } catch (err) {
      setSent(null);
      setError(err instanceof Error ? err.message : 'Não foi possível enviar.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="adm-card" onSubmit={submit} aria-label={title}>
      <h3>{title}</h3>
      {description && <p className="adm-muted">{description}</p>}
      <div>
        <label htmlFor={id} className="adm-muted">
          Mensagem
        </label>
        <textarea
          id={id}
          className="adm-textarea"
          value={text}
          maxLength={ADMIN_MESSAGE_MAX}
          placeholder={placeholder}
          onChange={(e) => setText(e.target.value)}
        />
        <span className="adm-muted">
          {text.length}/{ADMIN_MESSAGE_MAX}
        </span>
      </div>
      {error && (
        <p role="alert" className="adm-feedback" data-kind="error">
          {error}
        </p>
      )}
      {sent && (
        <p role="status" className="adm-feedback" data-kind="ok">
          {sent}
        </p>
      )}
      <div className="adm-row">
        <button type="submit" className="adm-btn adm-btn-primary" disabled={busy}>
          {busy ? 'Enviando…' : submitLabel}
        </button>
        {onCancel && (
          <button type="button" className="adm-btn" onClick={onCancel}>
            Cancelar
          </button>
        )}
      </div>
    </form>
  );
}
