# telaX — Design

Data: 2026-10-28

## Intenção

Plataforma de videoconferência simples: o usuário informa só **nome da sala** e **nome**, sem cadastro, e entra numa chamada com vídeo, áudio, compartilhamento de tela, chat e troca de arquivos. A mídia trafega direto entre os navegadores (WebRTC P2P mesh). O servidor só intermedeia sinalização, presença e chat.

## Metas

- Entrada sem cadastro (sala + nome).
- Áudio e vídeo P2P em mesh, compartilhamento de tela, chat, arquivos, lista de participantes com estado de conexão.
- Botão global "Reiniciar conexões": renegocia todos os pares sem ninguém sair da sala.
- Reconexão automática e limpeza correta de tracks, conexões e listeners.
- Interface escura com detalhes roxos, vídeos ao centro, painel lateral (Participantes / Chat / Arquivos) e barra inferior de controles. Responsiva.
- Pronto para deploy na Vercel; STUN público, TURN configurável por variáveis de ambiente.

## Não-metas

- Sem SFU, sem servidor de mídia, sem gravação.
- Sem contas, senha, e-mail, persistência de histórico.
- Sem serviço externo (Redis, Pusher etc.). Decisão do usuário.
- Sem criptografia de aplicação além da do WebRTC (DTLS-SRTP).

## Anti-metas (seria falha mesmo que compile)

- Botões decorativos, dados fictícios, mocks apresentados como funcionalidade.
- Reinício global que derruba ou expulsa participantes.
- Ofertas simultâneas conflitantes (glare) travando pares.

## Decisão do usuário e limitação conhecida

O usuário escolheu **tudo em memória, sem serviço externo**, e aceitou a consequência: na Vercel cada instância serverless tem a própria memória, então participantes da mesma sala podem cair em instâncias diferentes e não se enxergar. Em `next dev` e `next start` (instância única) funciona de forma confiável; na Vercel funciona em "melhor esforço". O README documenta isso. O armazenamento fica atrás de uma interface pequena (`RoomStore`) para trocar por Redis depois mexendo em um arquivo, mas **não** implementamos Redis agora.

## Escolhas minhas (não decididas pelo usuário)

- Next.js (App Router) + TypeScript, Vitest para unidade, Playwright para o teste de dois contextos.
- Sinalização por **polling curto** (~1 s) em rotas `/api/rooms/...`, sem WebSocket nem SSE.
- Estilo em CSS puro (módulos/arquivo global), sem biblioteca de UI.
- Limite de arquivo: 25 MB, enviado em pedaços pelo DataChannel P2P (nunca passa pelo servidor).
- Limite de sala: 8 participantes (mesh).

## Arquitetura

### Servidor (`src/server/`)

`RoomStore` (interface) + `MemoryRoomStore` (implementação, singleton em `globalThis` para sobreviver a hot reload).

Por sala: mapa de participantes `{ id, name, joinedAt, lastSeen, audio, video, sharing }`, log de eventos com `seq` crescente (últimos 500), geração de renegociação `gen` (inteiro).

Evento: `{ seq, type, from, to?, payload }`, onde `type` ∈ `join | leave | state | chat | signal | restart`. Eventos com `to` só são entregues a esse participante; os demais são broadcast.

Expiração: participante sem poll por 15 s é removido (evento `leave`). Sala vazia é apagada.

Rotas (todas JSON):

| Rota | Função |
|---|---|
| `POST /api/rooms/[room]/join` `{name}` | cria participante; devolve `{ peerId, participants, cursor, gen, iceServers }` |
| `GET /api/rooms/[room]/events?peerId&since` | devolve eventos com `seq > since` visíveis ao peer e novo `cursor`; atualiza `lastSeen`. Se o peer não existe mais, `410` |
| `POST /api/rooms/[room]/signal` `{from,to,gen,data}` | repassa offer/answer/ICE |
| `POST /api/rooms/[room]/chat` `{from,text}` | broadcast de mensagem |
| `POST /api/rooms/[room]/state` `{from,audio,video,sharing}` | atualiza estado e faz broadcast |
| `POST /api/rooms/[room]/restart` `{from}` | incrementa `gen` e faz broadcast de `restart` |
| `POST /api/rooms/[room]/leave` `{peerId}` | remove participante |

`iceServers` vem do servidor: STUN `stun:stun.l.google.com:19302` mais TURN de `TURN_URLS`, `TURN_USERNAME`, `TURN_CREDENTIAL` quando definidos.

Validação: nome da sala e nome do participante com trim, 1–40 caracteres; chat até 2000 caracteres.

### Cliente (`src/lib/`, `src/components/`)

- `signaling-client`: join, loop de polling com backoff, envio de sinais; ao receber `410` faz novo join automático (reconexão) e reconstrói os pares.
- `peer-manager`: um `RTCPeerConnection` por participante remoto.
  - **Papéis fixos:** o par com `peerId` lexicograficamente menor é o *offerer*; o outro só responde. Isso elimina glare por construção.
  - **Transceivers pré-criados** na mesma ordem nos dois lados: áudio, vídeo da câmera, vídeo da tela. Ligar/desligar câmera, microfone e tela é `replaceTrack`, sem renegociar. O lado receptor identifica "tela" pela posição do transceiver (mid) e pelo estado `sharing` do remetente.
  - Um `RTCDataChannel` (criado pelo offerer) para arquivos.
  - **Geração:** todo sinal carrega `gen`. Sinais com `gen` menor que o atual são descartados.
  - **Reinício global:** ao receber `restart` com `gen` maior, cada par fecha seu `RTCPeerConnection` e recria; o offerer manda nova offer após uma pequena fila com concorrência limitada (máx. 2 renegociações simultâneas), com jitter para espalhar a carga.
  - **Reconexão automática:** estado `failed`, ou `disconnected` por mais de 5 s, dispara reinício *local* daquele par (mesma rotina, sem bump de `gen` global; o offerer reabre).
  - ICE candidates que chegam antes da remote description ficam em fila.
- `files`: pedaços de 16 KB com cabeçalho `{id,name,size,mime}`, backpressure por `bufferedAmount`.
- UI: tela de entrada; sala com grade de vídeos, painel lateral com abas, barra inferior (microfone, câmera, tela, chat/painel, reiniciar conexões, sair). O estado de conexão de cada participante (conectando / conectado / reconectando / falhou) aparece na lista e no tile.

### Limpeza

Ao sair ou desmontar: parar todos os tracks locais (câmera, microfone, tela), fechar todos os `RTCPeerConnection` e DataChannels, remover listeners, abortar o polling, enviar `leave` via `sendBeacon`/`fetch keepalive` no `pagehide`.

## Testes

- Unidade (Vitest, TDD): `MemoryRoomStore` (join, visibilidade de eventos, cursor, expiração, geração, limite de sala), validação, rotas, regra de papéis, descarte de `gen` antigo, fila de reinício, framing de arquivo.
- E2E (Playwright, Chromium com mídia falsa, dois contextos independentes): entrada sem cadastro, vídeo remoto recebido, mute/câmera, compartilhamento de tela, chat, saída de participante, reinício global sem expulsão.
- Verificação manual documentada onde a automação não alcança (TURN real, redes restritivas).

## Entrega

README com: como rodar, variáveis de ambiente (TURN), deploy na Vercel, limitação da memória por instância, limitações de mesh (≈ 4–6 pessoas confortável) e de NAT simétrico sem TURN, e o que foi realmente testado.

## Deixado ao implementador

Detalhes visuais finos (a imagem de referência não chegou; seguir a descrição textual), nomes internos, estrutura exata de CSS.
