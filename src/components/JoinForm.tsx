'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { useRoomPreview } from '@/hooks/use-room-preview';
import { describeRoomPreview } from '@/lib/room-preview';
import { saveRoomPassword } from '@/lib/room-password-store';
import { normalizeName, normalizeRoom } from '@/lib/validation';

export function JoinForm({ initialRoom = '' }: { initialRoom?: string }) {
  const router = useRouter();
  const [room, setRoom] = useState(initialRoom);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const preview = useRoomPreview(room);
  const info = describeRoomPreview(preview);
  const askPassword = !!preview?.protected && !preview.closed;

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!normalizeRoom(room)) return setError('Informe o nome da sala (até 40 caracteres).');
    if (!normalizeName(name)) return setError('Informe seu nome (até 40 caracteres).');
    // a senha vai só para esta aba (nunca na URL); a página da sala a usa ao entrar
    if (askPassword) saveRoomPassword(room, password);
    router.push(`/room/${encodeURIComponent(room.trim())}?name=${encodeURIComponent(name.trim())}`);
  }

  return (
    <form className="join-card" onSubmit={submit} noValidate>
      <h1 className="brand">
        tela<span>X</span>
      </h1>
      <p className="muted">Videoconferência direta entre navegadores. Sem cadastro.</p>
      <label>
        Nome da sala
        <input value={room} onChange={(e) => setRoom(e.target.value)} maxLength={40} autoComplete="off" autoFocus={!initialRoom} />
      </label>
      {info && (
        <p className="room-preview" data-tone={info.tone} data-testid="room-preview" role="status" aria-live="polite">
          {info.text}
        </p>
      )}
      <label>
        Seu nome
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="nickname" autoFocus={!!initialRoom} />
      </label>
      {askPassword && (
        <label>
          Senha da sala
          <input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            maxLength={64}
            autoComplete="off"
            data-testid="room-password"
          />
        </label>
      )}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
      <button type="submit" className="primary">
        Entrar na sala
      </button>
    </form>
  );
}
