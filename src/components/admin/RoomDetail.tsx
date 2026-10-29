'use client';

import { useCallback, useState } from 'react';
import { useAdminPoll, useNow } from '@/hooks/use-admin-poll';
import { AdminApiError, type AdminClient } from '@/lib/admin-client';
import type { AdminCommand, AdminPeer } from '@/lib/admin-types';
import { updatedLabel } from '@/lib/admin-ui';
import { ConfirmAction } from './ConfirmAction';
import { Feedback, useFeedback } from './Feedback';
import { LiveRoom } from './LiveRoom';
import { MessageForm } from './MessageForm';
import { PeopleTable } from './PeopleTable';
import './admin.css';

type Props = { api: AdminClient; room: string; onBack(): void; onExpired(): void };

const COMMAND_DONE: Record<AdminCommand['what'], string> = {
  screens: 'pediu para parar as telas',
  screen: 'pediu para parar a tela',
  camera: 'pediu para desligar a câmera',
  mic: 'pediu para mutar o microfone',
  all: 'pediu para parar tudo',
};

/** "Ver sala": participantes com IP e ações por pessoa, mensagem e fechamento da sala, e a visão ao vivo. */
export function RoomDetail({ api, room, onBack, onExpired }: Props) {
  const fetchRoom = useCallback(() => api.room(room), [api, room]);
  const { data: detail, error, secondsAgo, reload } = useAdminPoll(fetchRoom, { onExpired });
  const now = useNow(15_000);
  const { feedback, show } = useFeedback(onExpired);
  const [live, setLive] = useState(true);
  const [messaging, setMessaging] = useState(false);

  /** 401 leva ao login; outros erros sobem para a confirmação mostrar */
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

  async function kick(peer: AdminPeer, reason: string | undefined) {
    await guarded(() => api.kick(room, peer.id, reason));
    show({ kind: 'ok', text: `${peer.name} foi expulsa da sala.` });
    await reload();
  }

  async function ban(peer: AdminPeer, reason: string | undefined) {
    const res = await guarded(() => api.banPeer(room, peer.id, reason));
    show({ kind: 'ok', text: `${peer.name} foi banida (IP e dispositivo). ${res.removed === 1 ? '1 pessoa removida' : `${res.removed} pessoas removidas`}.` });
    await reload();
  }

  async function command(peer: AdminPeer, cmd: AdminCommand) {
    await guarded(() => api.command(room, peer.id, cmd));
    show({ kind: 'ok', text: `Administração ${COMMAND_DONE[cmd.what]} de ${peer.name}.` });
  }

  const closed = detail?.closed ?? false;

  return (
    <div className="adm-shell" style={{ gap: 14 }}>
      <section className="adm-card" aria-labelledby="adm-room-title">
        <div className="adm-row">
          <button type="button" className="adm-btn adm-btn-sm" onClick={onBack}>
            ← Salas
          </button>
          <h2 id="adm-room-title" className="adm-mono" style={{ textTransform: 'none' }}>
            {room}
          </h2>
          {detail &&
            (closed ? (
              <span className="adm-badge" data-tone="warn" title={detail.closedReason}>
                fechada
              </span>
            ) : (
              <span className="adm-badge" data-tone="ok">
                aberta
              </span>
            ))}
          <span className="adm-muted">{updatedLabel(secondsAgo)}</span>
          <span className="adm-spacer" />
          {!closed && (
            <button type="button" className="adm-btn adm-btn-sm" aria-expanded={messaging} onClick={() => setMessaging((v) => !v)}>
              Mensagem à sala
            </button>
          )}
          {detail && closed && (
            <button
              type="button"
              className="adm-btn adm-btn-sm"
              onClick={async () => {
                try {
                  await guarded(() => api.reopen(room));
                  show({ kind: 'ok', text: `Sala "${room}" reaberta.` });
                  await reload();
                } catch (e) {
                  show({ kind: 'error', text: e instanceof Error ? e.message : 'Não foi possível reabrir.' });
                }
              }}
            >
              Reabrir sala
            </button>
          )}
          {detail && !closed && (
            <ConfirmAction
              label={`Fechar sala ${room}`}
              description={`Remove todas as pessoas de "${room}" e impede novas entradas até você reabrir.`}
              confirmLabel="Fechar sala"
              withReason
              onConfirm={async (reason) => {
                const res = await guarded(() => api.close(room, reason));
                show({ kind: 'ok', text: `Sala fechada (${res.removed === 1 ? '1 pessoa removida' : `${res.removed} pessoas removidas`}).` });
                await reload();
              }}
            />
          )}
        </div>

        {error && (
          <p role="alert" className="adm-feedback" data-kind="error">
            {error}
          </p>
        )}
        <Feedback feedback={feedback} />

        {messaging && !closed && (
          <MessageForm
            title={`Mensagem para a sala "${room}"`}
            submitLabel="Enviar à sala"
            onSend={async (text) => (await guarded(() => api.message(room, text))).delivered}
            onCancel={() => setMessaging(false)}
          />
        )}

        {detail === null ? (
          error ? null : <p className="adm-muted">Carregando a sala…</p>
        ) : (
          <>
            <h3>Participantes</h3>
            <PeopleTable peers={detail.peers} now={now} onKick={kick} onBan={ban} onCommand={command} />
          </>
        )}
      </section>

      {detail && !closed && (
        <section className="adm-card" aria-labelledby="adm-live-title">
          <div className="adm-row">
            <h2 id="adm-live-title">Câmeras e telas ao vivo</h2>
            <span className="adm-spacer" />
            <button type="button" className="adm-btn adm-btn-sm" aria-pressed={live} onClick={() => setLive((v) => !v)}>
              {live ? 'Pausar visão ao vivo' : 'Ver ao vivo'}
            </button>
          </div>
          {live ? (
            <LiveRoom room={room} peers={detail.peers} />
          ) : (
            <p className="adm-muted">Pausada: a administração saiu da sala (os participantes deixam de ver o aviso).</p>
          )}
        </section>
      )}
    </div>
  );
}
