'use client';

import { Icon, type IconName } from './Icon';

type Props = {
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
  hasMic: boolean;
  hasCam: boolean;
  panelOpen: boolean;
  restarting: boolean;
  onMic(): void;
  onCam(): void;
  onScreen(): void;
  onPanel(): void;
  onRestart(): void;
  onLeave(): void;
};

function Btn(props: {
  icon: IconName;
  label: string;
  onClick(): void;
  pressed?: boolean;
  off?: boolean;
  danger?: boolean;
  disabled?: boolean;
  title?: string;
}) {
  const { icon, label, onClick, pressed, off, danger, disabled, title } = props;
  return (
    <button
      className={`ctl ${off ? 'off' : ''} ${danger ? 'danger' : ''}`}
      onClick={onClick}
      aria-label={label}
      aria-pressed={pressed}
      disabled={disabled}
      title={title ?? label}
    >
      <Icon name={icon} />
      <span className="ctl-text">{label}</span>
    </button>
  );
}

export function ControlBar(p: Props) {
  return (
    <nav className="controls" aria-label="Controles da reunião">
      <Btn
        icon={p.micOn ? 'mic' : 'micOff'}
        label="Microfone"
        pressed={p.micOn}
        off={!p.micOn}
        disabled={!p.hasMic}
        title={p.hasMic ? (p.micOn ? 'Desligar microfone' : 'Ligar microfone') : 'Microfone indisponível'}
        onClick={p.onMic}
      />
      <Btn
        icon={p.camOn ? 'video' : 'videoOff'}
        label="Câmera"
        pressed={p.camOn}
        off={!p.camOn}
        disabled={!p.hasCam}
        title={p.hasCam ? (p.camOn ? 'Desligar câmera' : 'Ligar câmera') : 'Câmera indisponível'}
        onClick={p.onCam}
      />
      <Btn icon="screen" label="Tela" pressed={p.sharing} title={p.sharing ? 'Parar compartilhamento' : 'Compartilhar tela'} onClick={p.onScreen} />
      <Btn icon="panel" label="Painel" pressed={p.panelOpen} title="Mostrar ou ocultar o painel lateral" onClick={p.onPanel} />
      <Btn
        icon="refresh"
        label={p.restarting ? 'Reiniciando…' : 'Reiniciar conexões'}
        disabled={p.restarting}
        title="Renegocia as conexões com todos, sem ninguém sair da sala"
        onClick={p.onRestart}
      />
      <Btn icon="leave" label="Sair" danger onClick={p.onLeave} />
    </nav>
  );
}
