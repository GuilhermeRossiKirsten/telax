'use client';

import type { AdminCommand, AdminPeer } from '@/lib/admin-types';
import { formatWhen, mediaSummary, shortDevice } from '@/lib/admin-ui';
import { ConfirmAction } from './ConfirmAction';
import './admin.css';

type Props = {
  peers: AdminPeer[];
  now: number;
  onKick(peer: AdminPeer, reason: string | undefined): Promise<void>;
  onBan(peer: AdminPeer, reason: string | undefined): Promise<void>;
  onCommand(peer: AdminPeer, cmd: AdminCommand): Promise<void>;
};

/** Participantes da sala com IP, dispositivo e estado de mídia, e as ações por pessoa (todas com confirmação). */
export function PeopleTable({ peers, now, onKick, onBan, onCommand }: Props) {
  const people = peers.filter((p) => !p.observer);
  const observers = peers.length - people.length;

  if (people.length === 0) {
    return <p className="adm-muted">Ninguém na sala no momento.{observers > 0 ? ` (${observers} observador${observers > 1 ? 'es' : ''})` : ''}</p>;
  }

  return (
    <div className="adm-table-wrap">
      <table className="adm-table">
        <caption className="adm-muted" style={{ textAlign: 'left', padding: '8px 12px' }}>
          {people.length === 1 ? '1 participante' : `${people.length} participantes`}
          {observers > 0 ? ` · ${observers} observador${observers > 1 ? 'es' : ''}` : ''}
        </caption>
        <thead>
          <tr>
            <th scope="col">Nome</th>
            <th scope="col">IP</th>
            <th scope="col">Dispositivo</th>
            <th scope="col">Entrou</th>
            <th scope="col">Microfone</th>
            <th scope="col">Câmera</th>
            <th scope="col">Telas</th>
            <th scope="col">Ações</th>
          </tr>
        </thead>
        <tbody>
          {people.map((p) => {
            const m = mediaSummary(p);
            const hasScreens = m.screens !== 'nenhuma';
            return (
              <tr key={p.id}>
                <th scope="row">{p.name}</th>
                <td className="adm-mono">{p.ip ?? '—'}</td>
                <td className="adm-mono" title={p.deviceId ?? undefined}>
                  {shortDevice(p.deviceId)}
                </td>
                <td>{formatWhen(p.joinedAt, now)}</td>
                <td>{m.mic}</td>
                <td>{m.cam}</td>
                <td>{m.screens}</td>
                <td className="adm-wrap">
                  <div className="adm-actions">
                    <ConfirmAction
                      label={`Expulsar ${p.name}`}
                      description={`Tira ${p.name} da sala agora. Ela pode voltar a entrar, a menos que seja banida.`}
                      confirmLabel="Expulsar"
                      withReason
                      onConfirm={(reason) => onKick(p, reason)}
                    />
                    <ConfirmAction
                      label={`Banir ${p.name} (IP + dispositivo)`}
                      description={`Bloqueia o IP ${p.ip ?? 'desconhecido'} e o dispositivo de ${p.name} em TODAS as salas e a expulsa. IP compartilhado pode bloquear outras pessoas.`}
                      confirmLabel="Banir"
                      withReason
                      onConfirm={(reason) => onBan(p, reason)}
                    />
                    <ConfirmAction
                      label={`Parar telas de ${p.name}`}
                      description={`Pede ao app de ${p.name} que pare todas as telas que ela compartilha.`}
                      confirmLabel="Parar telas"
                      disabled={!hasScreens}
                      onConfirm={() => onCommand(p, { what: 'screens' })}
                    />
                    <ConfirmAction
                      label={`Parar câmera de ${p.name}`}
                      description={`Pede ao app de ${p.name} que desligue a câmera.`}
                      confirmLabel="Parar câmera"
                      disabled={!p.video}
                      onConfirm={() => onCommand(p, { what: 'camera' })}
                    />
                    <ConfirmAction
                      label={`Parar microfone de ${p.name}`}
                      description={`Pede ao app de ${p.name} que mute o microfone.`}
                      confirmLabel="Parar microfone"
                      disabled={!p.audio}
                      onConfirm={() => onCommand(p, { what: 'mic' })}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
