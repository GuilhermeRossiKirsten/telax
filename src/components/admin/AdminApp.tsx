'use client';

import { useState } from 'react';
import { useAdminSession } from '@/hooks/use-admin-session';
import { BansTab } from './BansTab';
import { DisabledCard, LoginCard } from './LoginCard';
import { RoomsTab } from './RoomsTab';
import './admin.css';

type Tab = 'rooms' | 'bans';

/** Raiz do painel: login, painel desativado ou o painel (abas Salas e Bloqueios). `loginError` já vem traduzido. */
export function AdminApp({ loginError }: { loginError: string | null }) {
  const { api, state, check, expire, logout } = useAdminSession();
  const [tab, setTab] = useState<Tab>('rooms');

  if (state.kind === 'loading') {
    return (
      <main className="adm-page">
        <p role="status" className="adm-muted">
          Verificando a sessão…
        </p>
      </main>
    );
  }
  if (state.kind === 'disabled') return <DisabledCard />;
  if (state.kind === 'anon') return <LoginCard error={loginError} />;
  if (state.kind === 'error') {
    return (
      <main className="adm-page">
        <div className="adm-shell" style={{ maxWidth: 460 }}>
          <section className="adm-card">
            <p role="alert" className="adm-feedback" data-kind="error">
              {state.message}
            </p>
            <button type="button" className="adm-btn" onClick={() => void check()}>
              Tentar de novo
            </button>
          </section>
        </div>
      </main>
    );
  }

  return (
    <main className="adm-page">
      <div className="adm-shell">
        <header className="adm-header">
          <h1 className="adm-brand">
            tela<span>X</span> · Administração
          </h1>
          <div className="adm-header-who">
            <span>
              Conectado como <strong>{state.login}</strong>
            </span>
            <button type="button" className="adm-btn adm-btn-sm" onClick={() => void logout()}>
              Sair
            </button>
          </div>
        </header>

        <div className="adm-tabs" role="tablist" aria-label="Seções do painel">
          <button type="button" role="tab" className="adm-tab" aria-selected={tab === 'rooms'} onClick={() => setTab('rooms')}>
            Salas
          </button>
          <button type="button" role="tab" className="adm-tab" aria-selected={tab === 'bans'} onClick={() => setTab('bans')}>
            Bloqueios
          </button>
        </div>

        {tab === 'rooms' ? <RoomsTab api={api} onExpired={expire} /> : <BansTab api={api} onExpired={expire} />}
      </div>
    </main>
  );
}
