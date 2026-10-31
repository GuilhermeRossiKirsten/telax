'use client';

import { useId, useState, type FormEvent } from 'react';
import {
  PASSWORD_MAX,
  PASSWORD_MIN,
  passwordErrorText,
  validatePassword,
  type PasswordError,
  type PasswordResult,
} from '@/lib/room-password';

export type RoomPasswordControls = {
  /** o servidor confere de novo; aqui só decide o que mostrar */
  isHost: boolean;
  protected: boolean;
  onSet(password: string): Promise<PasswordResult>;
  onClear(): Promise<PasswordResult>;
};

/** Configurações → Sala: ligar, trocar e remover a senha (anfitrião) ou só ver o estado (demais). */
export function RoomPasswordSection({ isHost, protected: isProtected, onSet, onClear }: RoomPasswordControls) {
  const checkId = useId();
  const fieldId = useId();
  const [wantProtect, setWantProtect] = useState(false);
  const [changing, setChanging] = useState(false);
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<PasswordError | null>(null);
  const [done, setDone] = useState<string | null>(null);

  function reset() {
    setWantProtect(false);
    setChanging(false);
    setPassword('');
    setError(null);
  }

  async function run(job: () => Promise<PasswordResult>, message: string) {
    setBusy(true);
    setError(null);
    setDone(null);
    const result = await job();
    setBusy(false);
    if (result.ok) {
      reset();
      setDone(message);
    } else setError(result.error);
  }

  function save(e: FormEvent) {
    e.preventDefault();
    if (busy) return;
    if (!validatePassword(password)) return setError('invalid');
    void run(() => onSet(password), isProtected ? 'Senha alterada.' : 'Senha ativada.');
  }

  const status = done && (
    <p className="sd-note" role="status" data-testid="room-password-done">
      {done}
    </p>
  );
  const problem = error && (
    <p className="form-error" role="alert" data-testid="room-password-error">
      {passwordErrorText(error)}
    </p>
  );

  if (!isHost) {
    return (
      <section className="sd-section" aria-label="Sala" data-testid="room-password-section">
        <h3 className="sd-subtitle">Sala</h3>
        <p className="sd-note" data-testid="room-password-readonly">
          {isProtected
            ? 'Esta sala está protegida por senha. Só a pessoa mais antiga na sala pode alterar.'
            : 'Esta sala não tem senha. Só a pessoa mais antiga na sala pode ativar.'}
        </p>
      </section>
    );
  }

  const showField = isProtected ? changing : wantProtect;
  return (
    <section className="sd-section" aria-label="Sala" data-testid="room-password-section">
      <h3 className="sd-subtitle">Sala</h3>

      {!isProtected && (
        <div className="sd-check">
          <input
            id={checkId}
            type="checkbox"
            checked={wantProtect}
            disabled={busy}
            onChange={(e) => {
              setWantProtect(e.target.checked);
              setPassword('');
              setError(null);
              setDone(null);
            }}
          />
          <label htmlFor={checkId}>Proteger esta sala com senha</label>
        </div>
      )}

      {isProtected && (
        <>
          <p className="sd-note" data-testid="room-password-state">
            A sala está protegida por senha.
          </p>
          {!changing && (
            <div className="sd-row">
              <button
                type="button"
                className="ghost"
                disabled={busy}
                onClick={() => {
                  setChanging(true);
                  setDone(null);
                  setError(null);
                }}
              >
                Alterar senha
              </button>
              <button type="button" className="ghost" disabled={busy} onClick={() => void run(onClear, 'Senha removida.')}>
                Remover senha
              </button>
            </div>
          )}
        </>
      )}

      {showField && (
        <form className="sd-field" onSubmit={save} noValidate>
          <label htmlFor={fieldId}>{isProtected ? 'Nova senha da sala' : 'Senha da sala'}</label>
          <input
            id={fieldId}
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            minLength={PASSWORD_MIN}
            maxLength={PASSWORD_MAX}
            autoComplete="new-password"
            disabled={busy}
            data-testid="room-password-new"
          />
          <p className="sd-note">
            De {PASSWORD_MIN} a {PASSWORD_MAX} caracteres. Vale para quem entrar depois; quem já está na sala continua.
          </p>
          <div className="sd-row">
            <button type="submit" className="primary" disabled={busy || !validatePassword(password)} data-testid="room-password-save">
              {isProtected ? 'Salvar nova senha' : 'Ativar senha'}
            </button>
            {isProtected && (
              <button type="button" className="ghost" disabled={busy} onClick={reset}>
                Cancelar
              </button>
            )}
          </div>
        </form>
      )}

      {problem}
      {status}
    </section>
  );
}
