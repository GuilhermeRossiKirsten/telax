'use client';

import './admin.css';

/** Variáveis que o servidor precisa para ligar o painel (só os NOMES, nunca valores). */
const REQUIRED_ENV = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET', 'ADMIN_GITHUB_USER', 'ADMIN_SESSION_SECRET'];

export function LoginCard({ error }: { error: string | null }) {
  return (
    <main className="adm-page">
      <div className="adm-shell" style={{ maxWidth: 460 }}>
        <section className="adm-card" aria-labelledby="adm-login-title">
          <h1 id="adm-login-title" className="adm-brand">
            tela<span>X</span> · Administração
          </h1>
          <p className="adm-muted">Acesso restrito. Entre com a conta do GitHub autorizada.</p>
          {error && (
            <p role="alert" className="adm-feedback" data-kind="error">
              {error}
            </p>
          )}
          {/* navegação completa (não fetch): o GitHub redireciona de volta com a sessão já gravada em cookie */}
          <a className="adm-btn adm-btn-primary" href="/api/admin/auth/login" style={{ justifyContent: 'center' }}>
            Entrar com GitHub
          </a>
        </section>
      </div>
    </main>
  );
}

export function DisabledCard() {
  return (
    <main className="adm-page">
      <div className="adm-shell" style={{ maxWidth: 560 }}>
        <section className="adm-card" aria-labelledby="adm-off-title">
          <h1 id="adm-off-title" className="adm-brand">
            tela<span>X</span> · Administração
          </h1>
          <p role="status" className="adm-feedback" data-kind="error">
            O painel de administração está desativado neste servidor.
          </p>
          <p className="adm-muted">Para ligá-lo, defina estas variáveis de ambiente no servidor (os valores nunca aparecem aqui):</p>
          <ul>
            {REQUIRED_ENV.map((name) => (
              <li key={name}>
                <code className="adm-mono">{name}</code>
              </li>
            ))}
          </ul>
          <p className="adm-muted">
            Opcional: <code className="adm-mono">ADMIN_GITHUB_ID</code> (id numérico do GitHub) e <code className="adm-mono">ADMIN_BASE_URL</code>. O
            endereço de retorno do OAuth é <code className="adm-mono">/api/admin/auth/callback</code> no seu domínio.
          </p>
        </section>
      </div>
    </main>
  );
}
