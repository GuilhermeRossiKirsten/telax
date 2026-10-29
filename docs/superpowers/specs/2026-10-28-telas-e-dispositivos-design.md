# Controle de telas e dispositivos — design

Pedido do usuário (resumo fiel):

- cada usuário controla as telas exibidas: **não escutar** uma tela, **ocultar** a visualização, **reordenar**, e **clicar numa tela para maximizar**;
- **menu de configurações** para escolher o **microfone** (entrada) e o **fone/alto-falante** (saída) usados pelo app;
- **painel** para separar as telas em grids e organizá-las;
- (mensagem anterior) as telas compartilhadas por outros começam sem aparecer; a pessoa liga a que quer ver.

Tudo é decisão **local**: o que um usuário oculta, silencia ou reordena não muda nada para os outros nem passa pelo servidor.

## Modelo

- **Tile** = uma câmera (`camera:<peerId>`) ou uma tela compartilhada (`screen:<peerId>`). Ids estáveis durante a sessão.
- **ViewState** (cliente): `layout` (`auto | grid | spotlight | sidebar`), `columns` (0 = automático, 1–4), `order` (ids na ordem escolhida), `hidden`, `muted`, `maximized`, `known` (tiles já vistos).
- Regras:
  - tile novo entra no fim da ordem; tile que some é removido de `order/hidden/muted/maximized`;
  - **tela compartilhada de outra pessoa entra oculta e silenciada** (a pessoa clica em "Mostrar" e depois em "Ativar som"); a própria tela e as câmeras entram normais. *Decisão minha* a partir da frase "iniciar com a tela mutada e a pessoa desmuta a tela que quer"; é uma constante (`HIDE_NEW_REMOTE_SCREENS`);
  - **ocultar** só esconde a imagem; o áudio continua, a menos que também seja silenciado. **Silenciar** só corta o áudio daquela pessoa neste navegador;
  - `maximized` mostra só aquele tile ocupando a área da sala; `Esc` ou o botão restaura. Os outros continuam montados (o áudio não para);
  - layouts: `auto` = grade, e vira destaque se houver uma tela visível (comportamento antigo); `grid` = grade com N colunas; `spotlight` = o 1º visível grande e os demais numa faixa embaixo; `sidebar` = o 1º grande e os demais numa coluna à direita;
  - só `layout` e `columns` são lembrados (localStorage); o resto vale para a sala atual.

## Interface

- Cada tile: botões **Silenciar/Ativar som**, **Ocultar**, **Maximizar/Restaurar**; clicar no corpo do tile também maximiza.
- Faixa "Ocultas" acima da grade com um botão **Mostrar …** por tile oculto.
- Nova aba **Telas** no painel lateral: escolher layout e colunas; lista de tiles com subir/descer, mostrar/ocultar e silenciar.
- Botão **Configurações** na barra: janela com **Microfone** e **Saída de áudio** (`<select>`). Trocar o microfone captura o novo dispositivo e faz `replaceTrack` nas conexões, mantendo o estado mutado/ligado. A saída usa `HTMLMediaElement.setSinkId` em cada vídeo remoto; onde o navegador não suporta (ex.: Safari) o seletor fica desabilitado com aviso. As escolhas ficam no localStorage.
- Nomes de dispositivos só aparecem depois da permissão de mídia (já pedida na entrada).
- Alguns navegadores (o Chromium de teste inclusive) geram **ids novos a cada carregamento**; por isso a escolha é salva com id **e** rótulo, e o rótulo é a reserva quando o id some.
- **Som da aba compartilhada** (pedido posterior): `getDisplayMedia({ video: true, audio: true })`; se o navegador entregar um track de áudio, ele sai por um **4º transceiver** (`screenAudio`), separado do microfone, e no destino entra no mesmo `MediaStream` do tile da tela. Telas de outras pessoas podem ser silenciadas como as câmeras. O botão "Tela" informa se o som está sendo enviado.

## Fora do escopo (decidi não fazer)

- Arrastar e soltar para reordenar (a reordenação é por botões, acessível e testável).
- Escolher a câmera.
- Sincronizar preferências com outros usuários ou entre sessões além de layout/colunas/dispositivos.

## Revisão de escopo (pedido posterior do usuário)

A aba **Telas** do painel foi **retirada**, junto com o seletor de layout/colunas e a reordenação. Em seu lugar:

- **Selecionar:** clicar numa tela a seleciona; ela fica grande e todas as outras (participantes inclusive) ficam numa faixa embaixo. Clicar de novo ou Esc solta. Sem seleção, o layout é automático (grade; destaque se há uma tela compartilhada aberta).
- **Overlay sobre cada tela** (ao passar o mouse/foco; sempre visível em toque): **volume** (0–100), **silenciar**, **destacar/soltar** e **fechar**. Fechar = parar de visualizar (a faixa "Fechadas" traz de volta); o som segue como estava, a menos que também silenciado. Mexer no volume de quem está silenciado volta a ouvir.
- O volume é por tile, só no navegador de quem ajusta, aplicado no `<audio>` fixo de cada tile (`RemoteAudio`). As seções acima que falam de aba Telas, layout, colunas e reordenação ficam substituídas por esta.
- Layout e colunas deixam de existir como preferência; nada é salvo em localStorage para as telas (só os dispositivos de áudio).

## Configurações de transmissão (pedido posterior)

Seção **Transmissão** na janela de Configurações, separada para **câmera** e **tela**, valendo só para o que **eu envio**:

- **Câmera:** resolução (Automática, 360p, 480p, 720p, 1080p), FPS (Automático, 15, 24, 30), taxa de bits máxima (Automática, 300 kbps, 800 kbps, 1,5 Mbps, 3 Mbps).
- **Tela:** resolução (Automática/nativa, 720p, 1080p), FPS (Automático, 5, 15, 30, 60), taxa de bits máxima (Automática, 1, 2,5, 5, 8 Mbps), prioridade (Equilibrada, Movimento fluido = `contentHint 'motion'`, Nitidez do texto = `'detail'`).
- Como se aplica (sem renegociar): resolução e FPS por `track.applyConstraints` (câmera ao vivo; tela no início do compartilhamento e a cada mudança); `contentHint` na faixa da tela; taxa de bits e FPS máximos por `RTCRtpSender.setParameters` em **todas** as conexões (e nas novas), reaplicados depois de `replaceTrack` e quando o par conecta.
- Malha completa: cada par recebe um fluxo próprio, então o envio total é a taxa × (participantes − 1). A janela mostra essa estimativa.
- Mudar alguma configuração vale na hora e é lembrada no navegador (`telax:quality`, validada ao ler; valor desconhecido volta ao automático). "Restaurar automático" zera tudo.
- Se o navegador não aceitar uma restrição (câmera sem aquele modo, por exemplo), a captura segue como estava e a janela diz o que ficou valendo de verdade ("em uso: 1280×720 a 30 fps").
- Fora do escopo: escolher o codec, simulcast/SVC, adaptação automática por perda de pacotes além do que o navegador já faz.

## Tile único por participante (pedido posterior)

Substitui, no que diz respeito a "tela compartilhada como tile separado", as seções anteriores:

- **Um tile por participante** (id = peerId). Compartilhando, a **tela ocupa o lugar do avatar/câmera no mesmo tile** (o mesmo `<video>` troca de fonte); se a câmera está ligada, vira um quadro pequeno (`.tile-inset`) no canto. Quem compartilha vê a própria tela direto no próprio tile.
- Para os outros, a tela **começa fechada** (tile com avatar/câmera + botão "Ver tela") e o **som da aba começa mutado**; abrir não ativa o som. Fechar a tela (overlay) volta ao avatar/câmera **e para o som da aba**. Se a pessoa para e volta a compartilhar, volta fechada e mutada.
- Estado (`view-state.ts`): `screens` (telas abertas), `sharing` (quem compartilha agora), `muted`/`volume` por chave de áudio `camera:<peer>` (voz) e `screen:<peer>` (som da aba, só existe enquanto a pessoa compartilha). `hidden` passa a ser só do tile inteiro (faixa "Fechadas").
- Layout: destaque quando há tile selecionado ou algum tile visível mostrando tela; senão grade.
- Atributos de teste: `figure[data-testid="tile"]` com `data-showing="camera|screen"`, `data-sharing`, `data-selected`; `<audio data-testid="audio-camera:<peer>">` e `audio-screen:<peer>`.
