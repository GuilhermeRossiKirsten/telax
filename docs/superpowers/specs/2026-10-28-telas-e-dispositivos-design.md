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
