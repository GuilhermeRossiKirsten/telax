'use client';

import Link from 'next/link';
import type { RemovalReason } from '@/lib/admin-types';

/** Mensagem que o administrador mandou à sala; fechável. */
export function AdminMessageBanner({ text, onDismiss }: { text: string; onDismiss(): void }) {
  return (
    <div className="banner warn" role="alert" data-testid="admin-message">
      <span className="grow">
        <strong>Mensagem do administrador:</strong> {text}
      </span>
      <button className="ghost" onClick={onDismiss}>
        Fechar
      </button>
    </div>
  );
}

/** Aviso fixo e visível enquanto um administrador pode estar vendo as câmeras e telas da sala. */
export function MonitorNotice() {
  return (
    <div className="banner" role="status" data-testid="admin-monitor">
      Um administrador pode estar vendo as câmeras e telas desta sala.
    </div>
  );
}

const REMOVED_TITLE: Record<RemovalReason, string> = {
  kicked: 'Você foi removido da sala pelo administrador.',
  banned: 'Seu acesso foi bloqueado.',
  closed: 'Esta sala foi encerrada pelo administrador.',
};

const BLOCKED_TITLE = {
  banned: 'Seu acesso a esta sala foi bloqueado.',
  closed: 'Esta sala está encerrada.',
} as const;

export type EndedInfo =
  | { kind: 'removed'; reason: RemovalReason; detail?: string }
  | { kind: 'blocked'; reason: 'banned' | 'closed'; detail?: string };

/** Tela final quando o administrador removeu a pessoa ou barrou a entrada. */
export function AdminEndedScreen({ info, backHref }: { info: EndedInfo; backHref: string }) {
  const title = info.kind === 'removed' ? REMOVED_TITLE[info.reason] : BLOCKED_TITLE[info.reason];
  const detail = info.detail;
  return (
    <main className="join-page">
      <div className="join-card">
        <h1 className="brand">
          tela<span>X</span>
        </h1>
        <p role="alert" data-testid="admin-ended">
          {title}
        </p>
        {detail && <p className="muted">Motivo: {detail}</p>}
        <Link className="primary link-btn" href={backHref}>
          Voltar
        </Link>
      </div>
    </main>
  );
}
