'use client';

import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { normalizeName, normalizeRoom } from '@/lib/validation';

export function JoinForm({ initialRoom = '' }: { initialRoom?: string }) {
  const router = useRouter();
  const [room, setRoom] = useState(initialRoom);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!normalizeRoom(room)) return setError('Informe o nome da sala (até 40 caracteres).');
    if (!normalizeName(name)) return setError('Informe seu nome (até 40 caracteres).');
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
      <label>
        Seu nome
        <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoComplete="nickname" autoFocus={!!initialRoom} />
      </label>
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
