'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatMessage, Participant, RoomFile } from '@/hooks/use-room';
import type { ViewApi } from '@/hooks/use-view-state';
import { LAYOUTS, MAX_COLUMNS, orderedTiles, tileLabel, type Layout } from '@/lib/view-state';
import { Icon } from './Icon';
import { CONN_LABEL } from './VideoTile';

export type Tab = 'participants' | 'tiles' | 'chat' | 'files';
const TABS: Array<[Tab, string]> = [
  ['participants', 'Participantes'],
  ['tiles', 'Telas'],
  ['chat', 'Chat'],
  ['files', 'Arquivos'],
];

const LAYOUT_LABEL: Record<Layout, string> = {
  auto: 'Automático',
  grid: 'Grade',
  spotlight: 'Destaque (um grande e os outros embaixo)',
  sidebar: 'Lateral (um grande e os outros ao lado)',
};

type Props = {
  tab: Tab;
  onTab(t: Tab): void;
  tiles: ViewApi['tiles'];
  view: ViewApi['view'];
  onView: ViewApi['dispatch'];
  participants: Participant[];
  messages: ChatMessage[];
  files: RoomFile[];
  selfId: string | null;
  nameOf(id: string): string;
  onSendChat(text: string): void;
  onSendFile(file: File): void;
};

const formatSize = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const formatTime = (at: number) => new Date(at).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });

export function SidePanel(p: Props) {
  return (
    <aside className="panel" aria-label="Painel lateral">
      <div className="tabs" role="tablist">
        {TABS.map(([id, label]) => (
          <button key={id} role="tab" aria-selected={p.tab === id} className={p.tab === id ? 'active' : ''} onClick={() => p.onTab(id)}>
            {label}
            {id === 'participants' && <span className="count">{p.participants.length}</span>}
          </button>
        ))}
      </div>
      <div className="panel-body" role="tabpanel">
        {p.tab === 'participants' && <ParticipantList participants={p.participants} />}
        {p.tab === 'tiles' && <TilesPanel tiles={p.tiles} view={p.view} onView={p.onView} />}
        {p.tab === 'chat' && <Chat messages={p.messages} selfId={p.selfId} onSend={p.onSendChat} />}
        {p.tab === 'files' && <Files files={p.files} nameOf={p.nameOf} onSend={p.onSendFile} />}
      </div>
    </aside>
  );
}

function ParticipantList({ participants }: { participants: Participant[] }) {
  return (
    <ul className="list" data-testid="participants">
      {participants.map((m) => (
        <li key={m.id}>
          <span className="avatar-sm" aria-hidden="true">
            {m.name.slice(0, 1).toUpperCase()}
          </span>
          <span className="grow">
            {m.name}
            {m.conn === 'self' && <em> (você)</em>}
          </span>
          {!m.audio && <Icon name="micOff" size={14} />}
          {!m.video && <Icon name="videoOff" size={14} />}
          {m.sharing && <Icon name="screen" size={14} />}
          <span className={`badge badge-${m.conn}`}>{CONN_LABEL[m.conn]}</span>
        </li>
      ))}
    </ul>
  );
}

function TilesPanel({ tiles, view, onView }: { tiles: ViewApi['tiles']; view: ViewApi['view']; onView: ViewApi['dispatch'] }) {
  const ordered = orderedTiles(tiles, view);
  const gridLike = view.layout === 'auto' || view.layout === 'grid';
  return (
    <div className="tiles-panel">
      <label className="field">
        Layout
        <select value={view.layout} onChange={(e) => onView({ type: 'layout', layout: e.target.value as Layout })}>
          {LAYOUTS.map((l) => (
            <option key={l} value={l}>
              {LAYOUT_LABEL[l]}
            </option>
          ))}
        </select>
      </label>
      <label className="field">
        Colunas
        <select
          value={view.columns}
          disabled={!gridLike}
          onChange={(e) => onView({ type: 'columns', columns: Number(e.target.value) })}
        >
          <option value={0}>Automático</option>
          {Array.from({ length: MAX_COLUMNS }, (_, i) => i + 1).map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
      </label>
      <p className="muted small">
        Vale só para você. Ocultar tira a imagem da grade (o som continua); silenciar corta o som. Clique numa tela para maximizar.
      </p>
      <ul className="list" data-testid="tile-list">
        {ordered.length === 0 && <li className="muted">Nenhuma tela ainda.</li>}
        {ordered.map((t, i) => {
          const label = tileLabel(t);
          const hidden = view.hidden.includes(t.id);
          const muted = view.muted.includes(t.id);
          return (
            <li key={t.id} data-hidden={hidden || undefined}>
              <span className="grow">
                {label}
                {hidden && <em> · oculta</em>}
              </span>
              <button className="icon-mini" aria-label={`Subir ${label}`} disabled={i === 0} onClick={() => onView({ type: 'move', id: t.id, dir: 'up' })}>
                <Icon name="arrowUp" size={14} />
              </button>
              <button
                className="icon-mini"
                aria-label={`Descer ${label}`}
                disabled={i === ordered.length - 1}
                onClick={() => onView({ type: 'move', id: t.id, dir: 'down' })}
              >
                <Icon name="arrowDown" size={14} />
              </button>
              {!t.self && (
                <button
                  className="icon-mini"
                  aria-pressed={muted}
                  aria-label={muted ? `Ativar som de ${label}` : `Silenciar ${label}`}
                  onClick={() => onView({ type: 'toggleMuted', id: t.id })}
                >
                  <Icon name={muted ? 'volumeOff' : 'volume'} size={14} />
                </button>
              )}
              <button
                className="icon-mini"
                aria-label={hidden ? `Mostrar ${label}` : `Ocultar ${label}`}
                onClick={() => onView({ type: 'toggleHidden', id: t.id })}
              >
                <Icon name={hidden ? 'eye' : 'eyeOff'} size={14} />
              </button>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function Chat({ messages, selfId, onSend }: { messages: ChatMessage[]; selfId: string | null; onSend(t: string): void }) {
  const [text, setText] = useState('');
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // bloco com chaves: o retorno de scrollIntoView não pode virar "função de limpeza" do effect
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [messages.length]);

  function submit(e: FormEvent) {
    e.preventDefault();
    if (!text.trim()) return;
    onSend(text);
    setText('');
  }

  return (
    <div className="chat">
      <div className="messages" data-testid="messages">
        {messages.length === 0 && <p className="muted">Nenhuma mensagem ainda.</p>}
        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.from === selfId ? 'mine' : ''}`}>
            <div className="msg-meta">
              <strong>{m.from === selfId ? 'Você' : m.name}</strong> <time>{formatTime(m.at)}</time>
            </div>
            <div className="msg-text">{m.text}</div>
          </div>
        ))}
        <div ref={end} />
      </div>
      <form className="chat-form" onSubmit={submit}>
        <input value={text} onChange={(e) => setText(e.target.value)} maxLength={2000} placeholder="Escreva uma mensagem" aria-label="Mensagem" />
        <button type="submit" className="icon-btn primary" aria-label="Enviar mensagem">
          <Icon name="send" size={18} />
        </button>
      </form>
    </div>
  );
}

function Files({ files, nameOf, onSend }: { files: RoomFile[]; nameOf(id: string): string; onSend(f: File): void }) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="files">
      <input
        ref={input}
        type="file"
        hidden
        data-testid="file-input"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onSend(f);
          e.target.value = '';
        }}
      />
      <button className="primary wide" onClick={() => input.current?.click()}>
        <Icon name="file" size={18} /> Enviar arquivo (até 25 MB)
      </button>
      <p className="muted small">O arquivo vai direto para quem está conectado agora; não passa pelo servidor.</p>
      <ul className="list" data-testid="files">
        {files.length === 0 && <li className="muted">Nenhum arquivo compartilhado.</li>}
        {files.map((f) => (
          <li key={f.id}>
            <span className="grow">
              <a href={f.url} download={f.name}>
                {f.name}
              </a>
              <small className="muted">
                {' '}
                · {formatSize(f.size)} · {f.direction === 'in' ? `de ${nameOf(f.peerId)}` : 'enviado por você'}
              </small>
              {f.status === 'sending' && <progress value={f.progress} max={1} aria-label={`Enviando ${f.name}`} />}
              {f.status === 'error' && <small className="err"> falhou</small>}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
