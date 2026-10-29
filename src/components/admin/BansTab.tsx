'use client';

import { useCallback } from 'react';
import { useAdminPoll, useNow } from '@/hooks/use-admin-poll';
import { AdminApiError, type AdminClient } from '@/lib/admin-client';
import { MAC_NOTICE, banKindLabel, formatWhen } from '@/lib/admin-ui';
import { ConfirmAction } from './ConfirmAction';
import { Feedback, useFeedback } from './Feedback';
import './admin.css';

type Props = { api: AdminClient; onExpired(): void };

/** Bloqueios ativos (por IP e por dispositivo), com o aviso honesto sobre os limites (sem MAC) e "Remover bloqueio". */
export function BansTab({ api, onExpired }: Props) {
  const fetchBans = useCallback(() => api.bans(), [api]);
  // bloqueios mudam pouco: sem atualização automática (economiza invocações); "Atualizar" e as ações recarregam
  const { data, error, reload } = useAdminPoll(fetchBans, { onExpired, intervalMs: null });
  const now = useNow(15_000);
  const { feedback, show } = useFeedback(onExpired);

  return (
    <div className="adm-shell" style={{ gap: 14 }}>
      <section className="adm-card" aria-labelledby="adm-bans-title">
        <div className="adm-row">
          <h2 id="adm-bans-title">Bloqueios</h2>
          <span className="adm-spacer" />
          <button type="button" className="adm-btn adm-btn-sm" onClick={() => void reload()}>
            Atualizar
          </button>
        </div>
        <p className="adm-note">{MAC_NOTICE}</p>
        {error && (
          <p role="alert" className="adm-feedback" data-kind="error">
            {error}
          </p>
        )}
        <Feedback feedback={feedback} />

        {data === null ? (
          error ? null : <p className="adm-muted">Carregando bloqueios…</p>
        ) : data.length === 0 ? (
          <p className="adm-muted">Nenhum bloqueio ativo.</p>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <caption className="adm-muted" style={{ textAlign: 'left', padding: '8px 12px' }}>
                {data.length === 1 ? '1 bloqueio' : `${data.length} bloqueios`}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Tipo</th>
                  <th scope="col">Valor</th>
                  <th scope="col">Motivo</th>
                  <th scope="col">Quando</th>
                  <th scope="col">Nome</th>
                  <th scope="col">Ações</th>
                </tr>
              </thead>
              <tbody>
                {data.map((b) => (
                  <tr key={b.id}>
                    <th scope="row">{banKindLabel(b)}</th>
                    <td className="adm-mono">{b.value}</td>
                    <td className="adm-wrap">{b.reason || '—'}</td>
                    <td>{formatWhen(b.createdAt, now)}</td>
                    <td>{b.bannedName ?? '—'}</td>
                    <td>
                      <ConfirmAction
                        label={`Remover bloqueio ${banKindLabel(b)} ${b.value}`}
                        description={`${banKindLabel(b) === 'IP' ? 'Este IP' : 'Este dispositivo'} poderá entrar nas salas de novo.`}
                        confirmLabel="Remover bloqueio"
                        danger={false}
                        onConfirm={async () => {
                          try {
                            await api.unban(b.id);
                          } catch (e) {
                            if (e instanceof AdminApiError && e.status === 401) onExpired();
                            throw e;
                          }
                          show({ kind: 'ok', text: 'Bloqueio removido.' });
                          await reload();
                        }}
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
