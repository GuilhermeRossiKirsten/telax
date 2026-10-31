'use client';

import Link from 'next/link';
import { useEffect, useId, useState, type FormEvent } from 'react';
import type { RoomLock } from '@/hooks/use-room';
import { PASSWORD_MAX, countdownSeconds, passwordErrorText, type RoomNotice } from '@/lib/room-password';

type PromptProps = {
  room: string;
  lock: RoomLock;
  /** a nova tentativa está em andamento (o cliente já chamou o servidor) */
  busy: boolean;
  onSubmit(password: string): void;
  backHref: string;
};

/** Tela mostrada quando a sala exige senha (ou a senha estava errada, ou há tentativas demais). */
export function RoomPasswordPrompt({ room, lock, busy, onSubmit, backHref }: PromptProps) {
  const inputId = useId();
  const [password, setPassword] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const until = lock.until;

  // cada novo bloqueio (senha errada, tentativas demais) começa com o campo limpo
  useEffect(() => {
    setPassword('');
  }, [lock]);

  // contagem regressiva enquanto o servidor segura novas tentativas (429)
  useEffect(() => {
    if (until === undefined) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 500);
    return () => clearInterval(id);
  }, [until]);

  const secondsLeft = until === undefined ? 0 : countdownSeconds(until, now);
  const waiting = lock.reason === 'too_many_attempts' && secondsLeft > 0;
  // a primeira vez ("exige senha") não é erro; só senha errada e tentativas demais viram aviso
  const error =
    lock.reason === 'wrong_password' || lock.reason === 'too_many_attempts'
      ? passwordErrorText(lock.reason, secondsLeft)
      : null;
  const locked = busy || waiting;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (locked || !password) return;
    onSubmit(password);
  }

  return (
    <main className="join-page">
      <form className="join-card" onSubmit={submit} noValidate data-testid="room-password-prompt">
        <h1 className="brand">
          tela<span>X</span>
        </h1>
        <p>
          Esta sala é protegida por senha: <strong>{room}</strong>
        </p>
        <label htmlFor={inputId}>
          Senha da sala
          <input
            id={inputId}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={PASSWORD_MAX}
            autoComplete="off"
            autoFocus
            disabled={locked}
            data-testid="room-lock-password"
          />
        </label>
        {error && (
          <p className="form-error" role="alert" data-testid="room-lock-error">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={locked || !password} data-testid="room-lock-submit">
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
        <Link className="ghost link-btn" href={backHref}>
          Voltar
        </Link>
      </form>
    </main>
  );
}

const NOTICE_TEXT: Record<RoomNotice, string> = {
  protected: 'A sala agora tem senha',
  unprotected: 'A senha da sala foi removida',
};

/** Aviso curto (fechável) quando outra pessoa liga, troca ou remove a senha da sala. */
export function RoomPasswordNotice({ notice, onDismiss }: { notice: RoomNotice; onDismiss(): void }) {
  return (
    <div className="banner" role="status" data-testid="room-password-notice">
      <span className="grow">{NOTICE_TEXT[notice]}</span>
      <button className="ghost" onClick={onDismiss}>
        Fechar
      </button>
    </div>
  );
}
