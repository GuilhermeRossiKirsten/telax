'use client';

import { useCallback, useMemo, useState } from 'react';
import { useAdminPoll, useNow } from '@/hooks/use-admin-poll';
import { AdminApiError, type AdminClient } from '@/lib/admin-client';
import { formatWhen, sortRooms, updatedLabel } from '@/lib/admin-ui';
import { ConfirmAction } from './ConfirmAction';
import { Feedback, useFeedback } from './Feedback';
import { MessageForm } from './MessageForm';
import { RoomDetail } from './RoomDetail';
import './admin.css';

type Props = { api: AdminClient; onExpired(): void };

/** Lista de salas (atualiza a cada 5 s, pausa com a aba oculta), mensagem global e ações por sala. */
export function RoomsTab({ api, onExpired }: Props) {
  const fetchRooms = useCallback(() => api.rooms(), [api]);
  const { data, error, secondsAgo, reload } = useAdminPoll(fetchRooms, { onExpired });
  const now = useNow(15_000);
  const { feedback, show, run } = useFeedback(onExpired);
  const [selected, setSelected] = useState<string | null>(null);
  const [messaging, setMessaging] = useState<string | null>(null);
  const [globalOpen, setGlobalOpen] = useState(false);

  const rooms = useMemo(() => (data ? sortRooms(data) : null), [data]);

  /** repassa 401 ao login e deixa os demais erros (já amigáveis) para o formulário mostrar */
  const guarded = useCallback(
    async <T,>(fn: () => Promise<T>): Promise<T> => {
      try {
        return await fn();
      } catch (e) {
        if (e instanceof AdminApiError && e.status === 401) onExpired();
        throw e;
      }
    },
    [onExpired],
  );

  if (selected) {
    return (
      <RoomDetail
        api={api}
        room={selected}
        onBack={() => {
          setSelected(null);
          void reload();
        }}
        onExpired={onExpired}
      />
    );
  }

  return (
    <div className="adm-shell" style={{ gap: 14 }}>
      <section className="adm-card" aria-labelledby="adm-rooms-title">
        <div className="adm-row">
          <h2 id="adm-rooms-title">Salas</h2>
          <span className="adm-muted" aria-live="off">
            {updatedLabel(secondsAgo)}
          </span>
          <span className="adm-spacer" />
          <button type="button" className="adm-btn adm-btn-sm" onClick={() => void reload()}>
            Atualizar
          </button>
          <button type="button" className="adm-btn adm-btn-sm adm-btn-primary" aria-expanded={globalOpen} onClick={() => setGlobalOpen((v) => !v)}>
            Mensagem global
          </button>
        </div>

        {error && (
          <p role="alert" className="adm-feedback" data-kind="error">
            {error}
          </p>
        )}
        <Feedback feedback={feedback} />

        {globalOpen && (
          <MessageForm
            title="Mensagem para TODAS as salas"
            description="Aparece como aviso do administrador para todos que estão em qualquer sala agora."
            submitLabel="Enviar a todas as salas"
            onSend={async (text) => (await guarded(() => api.broadcast(text))).delivered}
            onCancel={() => setGlobalOpen(false)}
          />
        )}

        {rooms === null ? (
          <p className="adm-muted">Carregando salas…</p>
        ) : rooms.length === 0 ? (
          <p className="adm-muted">Nenhuma sala no momento.</p>
        ) : (
          <div className="adm-table-wrap">
            <table className="adm-table">
              <caption className="adm-muted" style={{ textAlign: 'left', padding: '8px 12px' }}>
                {rooms.length === 1 ? '1 sala' : `${rooms.length} salas`}
              </caption>
              <thead>
                <tr>
                  <th scope="col">Sala</th>
                  <th scope="col">Pessoas</th>
                  <th scope="col">Observadores</th>
                  <th scope="col">Criada</th>
                  <th scope="col">Atividade</th>
                  <th scope="col">Situação</th>
                  <th scope="col">Ações</th>
                </tr>
              </thead>
              <tbody>
                {rooms.map((r) => (
                  <tr key={r.name}>
                    <th scope="row" className="adm-mono">
                      {r.name}
                    </th>
                    <td>{r.peerCount}</td>
                    <td>{r.observerCount}</td>
                    <td>{formatWhen(r.createdAt, now)}</td>
                    <td>{formatWhen(r.lastActivity, now)}</td>
                    <td>
                      {r.closed ? (
                        <span className="adm-badge" data-tone="warn" title={r.closedReason}>
                          fechada
                        </span>
                      ) : (
                        <span className="adm-badge" data-tone="ok">
                          aberta
                        </span>
                      )}
                      {r.passwordProtected && (
                        <>
                          {' '}
                          <span className="adm-badge" data-tone="info" data-testid="badge-password">
                            com senha
                          </span>
                        </>
                      )}
                    </td>
                    <td className="adm-wrap">
                      <div className="adm-actions">
                        <button type="button" className="adm-btn adm-btn-sm" aria-label={`Ver sala ${r.name}`} onClick={() => setSelected(r.name)}>
                          Ver sala
                        </button>
                        {!r.closed && (
                          <button type="button" className="adm-btn adm-btn-sm" aria-label={`Mensagem para a sala ${r.name}`} onClick={() => setMessaging(messaging === r.name ? null : r.name)}>
                            Mensagem
                          </button>
                        )}
                        {r.closed ? (
                          <button
                            type="button"
                            className="adm-btn adm-btn-sm"
                            aria-label={`Reabrir sala ${r.name}`}
                            onClick={() => void run(() => api.reopen(r.name).then(reload), `Sala "${r.name}" reaberta.`)}
                          >
                            Reabrir
                          </button>
                        ) : (
                          <ConfirmAction
                            label={`Fechar sala ${r.name}`}
                            description={`Remove todas as pessoas de "${r.name}" e impede novas entradas até você reabrir.`}
                            confirmLabel="Fechar sala"
                            withReason
                            onConfirm={async (reason) => {
                              const res = await guarded(() => api.close(r.name, reason));
                              show({ kind: 'ok', text: `Sala "${r.name}" fechada (${res.removed === 1 ? '1 pessoa removida' : `${res.removed} pessoas removidas`}).` });
                              await reload();
                            }}
                          />
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {messaging && (
          <MessageForm
            key={messaging}
            title={`Mensagem para a sala "${messaging}"`}
            submitLabel="Enviar à sala"
            onSend={async (text) => (await guarded(() => api.message(messaging, text))).delivered}
            onCancel={() => setMessaging(null)}
          />
        )}
      </section>
    </div>
  );
}
