'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { ChatMessage, Participant, RoomFile } from '@/hooks/use-room';
import { Icon } from './Icon';
import { CONN_LABEL } from './VideoTile';

export type Tab = 'participants' | 'chat' | 'files';
const TABS: Array<[Tab, string]> = [
  ['participants', 'Participantes'],
  ['chat', 'Chat'],
  ['files', 'Arquivos'],
];

type Props = {
  tab: Tab;
  onTab(t: Tab): void;
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
