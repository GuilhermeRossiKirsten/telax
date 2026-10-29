'use client';

import { Icon, type IconName } from './Icon';

type Props = {
  micOn: boolean;
  camOn: boolean;
  sharing: boolean;
  /** quantas telas a pessoa compartilha agora e se ainda cabe outra */
  screenCount: number;
  canAddScreen: boolean;
  /** alguma tela compartilhada está levando o som da aba */
  sharingAudio: boolean;
  hasMic: boolean;
  hasCam: boolean;
  panelOpen: boolean;
  restarting: boolean;
  onMic(): void;
  onCam(): void;
  /** adiciona uma tela (o navegador abre o seletor) */
  onScreen(): void;
  onStopScreens(): void;
  onPanel(): void;
  onSettings(): void;
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
      <Btn
        icon="screen"
        label="Tela"
        pressed={p.sharing}
        disabled={!p.canAddScreen}
        title={
          !p.canAddScreen
            ? `Limite de ${p.screenCount} telas ao mesmo tempo: pare uma para compartilhar outra`
            : p.sharing
              ? `Compartilhar mais uma tela (${p.screenCount} agora${p.sharingAudio ? '; o som da aba está sendo enviado' : ''})`
              : 'Compartilhar tela ou aba (marque "Compartilhar áudio" para enviar o som da aba)'
        }
        onClick={p.onScreen}
      />
      {p.sharing && <Btn icon="screenOff" label="Parar compartilhamento" title="Parar todas as telas que você compartilha" onClick={p.onStopScreens} />}
      <Btn icon="panel" label="Painel" pressed={p.panelOpen} title="Mostrar ou ocultar o painel lateral" onClick={p.onPanel} />
      <Btn icon="settings" label="Configurações" title="Escolher microfone e saída de áudio" onClick={p.onSettings} />
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
