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

## Várias telas por pessoa (pedido posterior) — CONTRATO

Uma pessoa pode compartilhar até `MAX_SCREENS = 3` telas ao mesmo tempo (`src/lib/screens.ts`, já existe).

**Slots fixos.** Cada tela ocupa um slot 0..2 enquanto dura; parar uma não muda os slots das outras (a identidade de uma tela não "escorrega").

**Servidor/estado (sinalização).** `PeerMediaState`/`PeerInfo` ganham `screenSlots: number` (máscara de bits dos slots ativos, validada com `isSlotMask`). `sharing` continua existindo e vale `screenSlots > 0`. Compatibilidade na entrada de `POST .../state`: se vier `screenSlots` (inteiro 0..7) o servidor deriva `sharing = screenSlots > 0`; se vier só `sharing` (boolean), vira `screenSlots = sharing ? 1 : 0`; `screenSlots` inválido → 400 como os demais campos. Entrada no `join` é `sharing:false, screenSlots:0`. Memory e Mongo guardam e devolvem os dois.

**PeerManager.** 8 transceivers por par, nesta ordem: `audio, camera, screen0, screenAudio0, screen1, screenAudio1, screen2, screenAudio2`. `LocalTracks = { audio, camera, screens: Array<{ video: MediaStreamTrack | null; audio: MediaStreamTrack | null }> }` (`screens` tem sempre `MAX_SCREENS` posições; posição vazia = `{video:null,audio:null}`). `onRemoteTracks(peerId, { audio?, camera?, screens: Array<{ video?: MediaStreamTrack; audio?: MediaStreamTrack }> })` (também `MAX_SCREENS` posições). `SendQuality.screen` vale para TODOS os senders de vídeo de tela. `use-room`: `RemoteStreams = { camera: MediaStream; screens: MediaStream[] }` com `MAX_SCREENS` streams estáveis (cada um com [vídeo, áudio] da posição).

**Tiles.** Um tile por participante (como hoje) mais um tile extra por tela ADICIONAL: a tela de menor slot ativo ocupa o lugar do avatar/câmera no tile da pessoa; cada outra tela ativa vira um tile próprio ("Tela 2 de Ana"). Se a de menor slot para, a seguinte assume o tile da pessoa. Ids: tile da pessoa = `peerId`; tile extra = `peerId#slot`. Identidade da tela = `peerId#slot` (abertas, som e volume usam essa chave: `screen:<peerId>#<slot>`; a voz segue `camera:<peerId>`).
- Quem vê: toda tela de outra pessoa começa FECHADA e com o som da aba MUTADO. Tile da pessoa: avatar/câmera + botão `Ver tela de Ana` (slot 0) ou `Ver tela 2 de Ana`. Tile extra fechado: fundo escuro com ícone + o mesmo botão `Ver tela 2 de Ana`. Aberta: a tela ocupa o tile; legenda `Tela de Ana` / `Tela 2 de Ana`.
- Quem compartilha: vê as próprias telas abertas (no próprio tile e em tiles extras).
- Atributos de teste do `figure[data-testid="tile"]`: `data-kind="person"|"screen"`, `data-slot` (slot da tela mostrada ou do tile extra; ausente se o tile da pessoa não compartilha), `data-showing="camera"|"screen"`, `data-sharing`, `data-selected`. `<audio data-testid="audio-screen:<peerId>#<slot>">` para cada tela remota ativa (toca só enquanto aberta).
- Overlay (hover) de tile mostrando tela remota: `Silenciar som da aba de Ana` / `Ativar som da aba de Ana` e slider `Volume da aba de Ana` (slot 0); para slot n>0: `...da aba 2 de Ana`, `Volume da aba 2 de Ana`. `Fechar tela de Ana` / `Fechar tela 2 de Ana` fecha a tela (volta ao avatar/câmera, ou ao fundo escuro no tile extra) e PARA o som dela. Tela própria: botão `Parar de compartilhar tela` (slot 0) / `Parar de compartilhar tela 2` no overlay; sem botão "Ver tela".
- Barra de controles: botão `Tela` ADICIONA uma tela (abre o seletor do navegador); `aria-pressed` = está compartilhando; desabilitado com `title` explicando ao chegar em 3. Quando há alguma tela, aparece também o botão `Parar compartilhamento` que para TODAS.
- Participantes (painel): o ícone de tela mostra a quantidade quando > 1; cada linha de outra pessoa tem o mesmo controle de voz do overlay: botão `Silenciar {nome}`/`Ativar som de {nome}` e slider `Volume de {nome}` (os do painel ficam dentro de `[data-testid="participants"]`).
- Layout: destaque quando há tile selecionado ou algum tile visível mostrando tela.

## Menu de botão direito e áudio do sistema (pedido posterior)

- O overlay de hover **perde todo controle de áudio** (o ícone de som no overlay não deixava distinguir a voz da pessoa do som da transmissão). Fica com: fixar, tela cheia, parar de compartilhar (própria tela), fechar e **Mais opções**.
- Botão direito no tile (ou "Mais opções") abre `role="menu"` em portal (no próprio elemento quando em tela cheia): grupo **Voz de {nome}** (microfone) e grupo **Som da transmissão** (tela; `Som da transmissão 2` etc.), cada um com silenciar e volume; ajustar volume não fecha; ações (destacar, tela cheia, ver/fechar tela, parar de compartilhar, fechar) fecham. Esc/clique fora/resize fecham; setas navegam.
- Tile com som da transmissão silenciado mostra o chip "aba sem som" (a voz silenciada segue sendo o ícone).
- Aba Participantes: o nome é uma linha com reticências e o volume fica numa segunda linha da própria linha (antes a barra espremia o nome e ele quebrava letra por letra).
- **Áudio do sistema ao compartilhar a tela inteira:** opção em Configurações → Transmissão ("Incluir o áudio do sistema ao compartilhar a tela inteira"), desligada por padrão (o áudio do sistema inclui as vozes da chamada: eco sem fone), lembrada no navegador; a captura pede `systemAudio: 'include'` quando ligada e `'exclude'` quando desligada.

## Parar qual tela (pedido posterior)

- O botão **Parar compartilhamento** da barra: com **uma** tela, para direto; com **mais de uma**, abre o menu "Parar qual tela?" (acima do botão, em portal) com um item por tela, cada um com **miniatura ao vivo** da tela (é assim que se reconhece qual é qual) e o texto "Parar tela"/"Parar tela 2"/"Parar tela 3", mais "Parar todas as telas". Esc, clique fora e resize fecham sem parar nada; setas navegam.
- Parar uma tela não mexe nas outras (slots fixos); se a de menor slot para, a seguinte assume o tile da pessoa.

## Seleção múltipla em grade, sem botão de pin (pedido posterior)

- O botão de pin saiu do overlay; a seleção é o clique no corpo do tile e aparece só como **contorno** (borda + brilho na cor de destaque). O menu de botão direito mantém "Destacar/Soltar {rótulo}" (acessibilidade por teclado).
- `ViewState.selected` agora é uma lista: clicar alterna só aquele tile, `select null` (Esc) limpa tudo, esconder um tile o tira da seleção, quem sai da sala some dela.
- Palco = tiles selecionados; sem seleção, os que mostram tela (aberta ou própria). Com palco menor que o total de tiles visíveis: `data-layout="spotlight"` com o palco em GRADE (`.tiles-primary`, `--cols` = ceil(sqrt(N))) e os demais na faixa `.tiles-rest`; senão `grid` normal.

## Eventos de controle não podem ser cortados por sinais (bug real, achado por teste instável)

- O log de eventos da sala guarda no máximo `MAX_EVENTS = 500`. Com 4+ pessoas, os sinais (SDP/ICE, e agora 8 faixas por par) lotam o log em segundos; o corte "mais velhos primeiro" apagava os `join` de quem ainda não tinha consultado, e essa pessoa nunca mais via aqueles participantes (cursor já avançado).
- Política nova (memória e Mongo): ao estourar o limite, saem primeiro os **sinais** mais velhos; entrada, saída, estado, chat e restart só saem se, sem nenhum sinal, ainda exceder. Teste de contrato novo nos dois armazenamentos.
- Não resolvido: o cliente avança o cursor mesmo quando o servidor cortou eventos (não detecta lacuna). Com a política nova isso só ocorre se houver mais de 500 eventos de controle.
