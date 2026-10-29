# telaX

Videoconferência no navegador, sem cadastro: informe **nome da sala** e **seu nome** e entre.
Áudio, vídeo e arquivos vão **direto entre os navegadores** (WebRTC P2P em malha); o servidor só
intermedeia a sinalização, a presença e o chat.

- Áudio e vídeo, compartilhamento de tela, chat em tempo real, envio de arquivos (até 25 MB)
- Lista de participantes com estado de conexão (Conectando / Conectado / Reconectando / Falhou)
- **Reiniciar conexões**: renegocia todos os pares sem ninguém sair da sala
- Reconexão automática de pares e do canal de sinalização
- **Um tile por participante:** quando alguém compartilha a tela, ela aparece **no lugar do avatar/câmera, no mesmo tile**
  (nada de um segundo componente). Para quem vê, a tela começa **fechada** (o tile mostra o avatar e o botão
  "Ver tela"); ao abrir, a tela ocupa o tile e o **som da aba continua mutado** até você ativar. Se a câmera de quem
  compartilha está ligada, ela vira um quadro pequeno no canto do mesmo tile
- **Várias telas por pessoa (até 3):** o botão **Tela** adiciona mais uma; **Parar compartilhamento** para todas, e cada
  tela própria tem o seu "Parar de compartilhar". A primeira ocupa o tile da pessoa; as adicionais viram tiles extras
  ("Tela 2 de Ana"), cada um com o seu volume do som da aba. Slots fixos: parar uma tela não mexe nas outras
- **Formato original:** a tela aberta e o tile selecionado mostram a imagem **inteira, sem esticar nem cortar**
  (`object-fit: contain`); a câmera na grade continua preenchendo o tile
- **Controle das telas (só para quem o faz):** clique num tile para **selecioná-lo**: ele fica grande e os demais,
  participantes inclusive, ficam numa faixa embaixo (clique de novo ou Esc solta). Um overlay sobre cada tile, ao
  passar o mouse, controla o **volume** e **silenciar** (da voz e, com a tela aberta, do som da aba), **fixar**,
  **tela cheia** de verdade (API de fullscreen) e **fechar** (fechar a tela volta ao avatar/câmera e para o som da aba;
  fechar o tile o manda para a faixa "Fechadas"). O volume de cada pessoa também fica na aba **Participantes** do painel
  (é o mesmo controle do overlay)
- **Configurações → Transmissão:** qualidade do que você envia, separada para câmera e tela: resolução, FPS, taxa de
  bits máxima e, na tela, prioridade (movimento fluido ou nitidez do texto). Vale na hora e fica lembrada; mostra o
  que a captura realmente entrega e uma estimativa do envio total (malha: cada par recebe um fluxo seu)
- **Compartilhar o som da aba:** ao compartilhar uma aba, marque "Compartilhar áudio da guia" no seletor
  do navegador; o som vai numa faixa própria, separada do microfone
- **Configurações:** escolha do microfone e da saída de áudio (fone ou alto-falante), lembradas no
  navegador. A saída depende de `setSinkId` (Chrome, Edge e Firefox recentes; não o Safari)
- Até 8 participantes por sala; interface escura (paleta e fontes do rossik.dev.br: fundo oliva, destaque lima, Roboto/Oswald), responsiva; câmera e microfone entram mutados

## Como rodar

```bash
npm install
npm run dev          # desenvolvimento em http://localhost:3000
# ou
npm run build && npm start
```

Câmera e microfone exigem **HTTPS ou `localhost`** (regra dos navegadores). Na Vercel o HTTPS já vem pronto.

Para testar sozinho, abra a mesma sala em duas abas (ou em dois navegadores) com nomes diferentes.

## Configuração (variáveis de ambiente)

Tudo é opcional. Copie `.env.example` para `.env.local` se precisar de TURN ou MongoDB.

| Variável | Para que serve |
|---|---|
| `TURN_URLS` | URLs do servidor TURN, separadas por vírgula (`turn:host:3478,turns:host:5349`) |
| `TURN_USERNAME` | usuário do TURN |
| `TURN_CREDENTIAL` | senha do TURN |
| `MONGODB_URI` | guarda as salas no MongoDB, compartilhadas entre instâncias (**necessário na Vercel**). Sem ela, as salas ficam na memória do processo |
| `MONGODB_DB` | nome do banco (padrão `telax`) |

O TURN só é incluído se **as três** estiverem definidas. O STUN público do Google
(`stun:stun.l.google.com:19302`) é sempre usado. As credenciais TURN são entregues a quem entra na
sala (o navegador precisa delas); use credenciais próprias para este fim, de preferência
temporárias/limitadas, e não reutilize uma senha sua.

### Quando o TURN é necessário

O STUN só descobre o endereço público de cada navegador. Se os dois lados estiverem atrás de NAT
simétrico, de firewall corporativo que bloqueia UDP ou de algumas redes móveis, a conexão P2P direta
**falha** e o tile fica em "Falhou" (o app continua tentando reabrir com intervalo crescente, de
1 s até 30 s). Nesses casos é preciso um servidor TURN para retransmitir a mídia (por exemplo, um
[coturn](https://github.com/coturn/coturn) próprio ou um provedor de TURN).
Com TURN, a mídia passa a trafegar pelo relay (cifrada de ponta a ponta pelo WebRTC, mas consumindo a
banda do servidor TURN).

## Deploy na Vercel

O projeto é um app Next.js padrão (sem `vercel.json`, sem variáveis obrigatórias):

```bash
npx vercel          # ou importe o repositório no painel da Vercel
```

### Salas compartilhadas: MongoDB (necessário na Vercel)

Na Vercel cada requisição pode ser atendida por uma instância diferente, e cada instância tem a própria
memória. Sem armazenamento compartilhado, a instância que recebe o `/events` não conhece quem entrou pela
outra: responde 410, o cliente reentra como "participante novo" e a sala nunca se estabiliza.

Com `MONGODB_URI` definida, as salas ficam no MongoDB e todas as instâncias enxergam as mesmas:

1. Crie um cluster (o plano gratuito do Atlas serve) ou conecte o banco ao projeto na Vercel
   (Storage / Marketplace), o que já cria a variável `MONGODB_URI` no projeto.
2. No Atlas, libere o acesso de rede para a Vercel (Network Access; as funções da Vercel não têm IP fixo,
   então costuma ser `0.0.0.0/0` com usuário e senha fortes).
3. Faça um novo deploy para a variável valer.

Para rodar localmente contra o mesmo banco, ponha `MONGODB_URI` no `.env.local` (arquivo ignorado pelo git).
**Não coloque a URI com senha no README, no código nem em arquivo versionado.** Sem a variável o app
continua funcionando em memória, o que é confiável com uma única instância (`next dev`, `next start`).

Como as salas são guardadas: um documento por sala (coleção `rooms`, banco `telax`) com participantes e log
de eventos. Toda operação é um único update atômico desse documento, então duas instâncias disputando a
8ª vaga, ou enviando eventos ao mesmo tempo, não se atropelam. Salas sem escrita há 1 h são apagadas por um
índice TTL. O conteúdo dos usuários (chat, nome, SDP) sempre entra como valor literal, nunca como expressão,
e todo `peerId` é validado como UUID antes de virar parte de um caminho do banco.

Se o banco ficar inacessível, as chamadas falham e o app mostra "Reconectando"; depois de 3 reentradas
seguidas em 30 s ele desiste e mostra "Não foi possível manter a sala" com o botão "Tentar novamente".

## Como funciona

- **Sinalização:** o navegador entra com `POST /api/rooms/:sala/join` e faz *polling* de
  `GET /api/rooms/:sala/events` a cada ~1 s. Offers, answers, candidatos ICE, presença, estado
  (mic/câmera/tela) e chat passam por `/signal`, `/state`, `/chat`. Quem para de consultar por
  15 s é removido da sala.
- **Token por participante:** o `join` devolve um token secreto, exigido em todas as chamadas
  seguintes. O `peerId` é público (aparece na lista), então sem o token ninguém consegue ler os
  sinais de outro, mandar chat em nome dele nem tirá-lo da sala. O `/signal` só aceita campos
  conhecidos (SDP até 32 KiB, `gen` nunca à frente da sala) e o corpo das requisições é limitado
  a 128 KiB.
- **Mesh P2P:** um `RTCPeerConnection` por par de participantes. O menor `peerId` do par é sempre
  quem oferece, o outro só responde, o que elimina ofertas simultâneas conflitantes.
- **Mídia sem renegociar:** o offerer cria 4 transceivers (áudio do microfone, vídeo da câmera, vídeo da
  tela e áudio da tela/aba) e quem responde adota os criados pela offer, na mesma ordem; ligar/desligar
  câmera, microfone e tela, e trocar de microfone, é `replaceTrack`, sem nova negociação.
- **Telas e dispositivos são decisões locais:** fechar, silenciar, volume, seleção e
  dispositivos de áudio ficam no navegador de cada pessoa (`src/lib/view-state.ts`, um reducer puro); nada
  disso passa pelo servidor nem muda para os outros.
- **Reinício global:** o botão incrementa um número de geração (`gen`) no servidor e avisa todos.
  Cada cliente recria seus pares; só o lado offerer reoferta, por uma fila que limita a 2
  renegociações simultâneas. Sinais de geração anterior são descartados.
- **Reconexão:** par em `failed` é reaberto com backoff (1 s → 30 s); `disconnected` por mais de 5 s é
  reaberto na hora; se o servidor esquecer o participante (`410`), o cliente entra de novo e refaz
  os pares. Um par que não chega a `connected` em 20 s (por exemplo, offer perdida numa queda de
  rede) também é reaberto. Cada sessão de negociação tem um id (`sid`), então respostas e
  candidatos de uma sessão antiga são descartados e não contaminam a nova.
- **Arquivos:** enviados em pedaços de 16 KB por um DataChannel P2P (com controle de fluxo), nunca
  passam pelo servidor.

## Limitações conhecidas

- **Sem `MONGODB_URI` o estado é em memória** (ver acima): confiável só em instância única. Na Vercel, use o MongoDB.
- **Custo do MongoDB:** cada chamada à API faz de 1 a 3 idas ao banco (o polling de ~1 s por participante vira
  leitura/escrita). O log de eventos fica dentro do documento da sala (até 500 eventos / 5 min); um
  participante autenticado mal-intencionado pode encher a própria sala de sinais grandes até o documento
  estourar o limite de 16 MB, o que só derruba aquela sala.
- **Malha completa:** cada participante envia o próprio vídeo a todos os outros. É confortável até
  ~4–6 pessoas; o limite da sala é 8. Não há SFU nem servidor de mídia (requisito do projeto).
- **Sem TURN configurado**, redes com NAT simétrico/firewall restritivo não conectam.
- **Latência de sinalização:** o polling de ~1 s atrasa a entrada de participantes, o chat e o
  início das conexões em até ~1 s. A mídia em si não é afetada depois de conectada.
- **Chat e arquivos não têm histórico:** quem entra depois não vê mensagens anteriores; arquivos
  só chegam a quem está conectado no momento do envio. Nada é gravado no servidor.
- **Desligar a câmera** usa `track.enabled = false` (envia quadros pretos e o LED da câmera
  continua aceso); o compartilhamento de tela não envia áudio.
- **Sem autenticação de sala:** quem souber o nome da sala entra (o token protege um participante
  dos outros, não a sala de quem chega). Não há senha nem convite.
- **Sem limite de número de salas:** um cliente mal-intencionado pode criar muitas salas e esgotar a memória
  da instância (ou o armazenamento do cluster, com MongoDB; lá o TTL de 1 h apaga as abandonadas). As
  requisições e cada sala têm limites, o total de salas não.
- **Histórico e MIME:** o tipo (MIME) de um arquivo recebido é o declarado por quem enviou.
- Só o **microfone** e a **saída de áudio** podem ser trocados durante a chamada; a câmera não.
- O **som da aba** só existe se o navegador o entregar (Chrome/Edge, ao compartilhar uma aba ou, no Windows, a
  tela inteira, com a caixa de áudio marcada); janelas e o Safari costumam não oferecer. Não há mixagem: o som
  da aba e o microfone viajam em faixas separadas.
- Um erro de join diferente de "sala cheia" (por exemplo, 500 do servidor) aparece como
  "Reconectando" e o app segue tentando; não há tela de erro dedicada.

## Testes

```bash
npx vitest run         # unidade (regras, store, rotas, cliente de sinalização, PeerManager, arquivos)
npx tsc --noEmit       # tipos
# testes do store contra um MongoDB real (descartável; sem a variável eles são pulados):
docker run -d --rm --name telax-mongo -p 27018:27017 mongo:7
MONGODB_TEST_URI=mongodb://127.0.0.1:27018 npx vitest run
npm run test:e2e       # Playwright: sobe build + servidor na porta 3100 e abre dois navegadores
```

Os testes E2E usam Chromium com câmera/microfone falsos (`--use-fake-device-for-media-stream`) e
contextos de navegador independentes. Eles **não** cobrem: câmeras/microfones reais, Firefox/Safari,
dispositivos móveis reais, conexão através de TURN real nem redes com NAT restritivo.
O teste de 3 participantes está em `e2e-mesh/` e roda com `npx playwright test -c playwright.mesh.config.ts`.

### O que foi executado

Resultados da última verificação (28/10/2026, Windows 11, Node 24, Chromium do Playwright 1.64):

| Verificação | Comando | Resultado |
|---|---|---|
| Unidade (store em memória, rotas, token, sinais, cliente, PeerManager, arquivos, view-state, dispositivos, captura de tela) | `npx vitest run` | 275 passaram, 4 pulados (os do MongoDB, sem `MONGODB_TEST_URI`), 0 falharam |
| Unidade + contrato do store contra **MongoDB 7 real** (Docker local) | `MONGODB_TEST_URI=mongodb://127.0.0.1:27018 npx vitest run` | 189 passaram, 0 falharam |
| Tipos | `npx tsc --noEmit` | sem erros |
| Build de produção | `npm run build` (feito pelo Playwright antes de subir o servidor) | ok |
| E2E, 2 participantes (43 cenários, incluindo mutados ao entrar, tile único com a tela no lugar do avatar, várias telas, formato original, tela cheia, fechar/silenciar/volume/selecionar, som da aba, dispositivos, rolagem das Configurações e transmissão (limites lidos do RTCRtpSender real)), 1 execução, store em memória | `npx playwright test` | 43 passaram |
| E2E, 2 participantes, **store MongoDB** | `MONGODB_URI=mongodb://127.0.0.1:27018 npx playwright test` | 12 passaram na versão **anterior** às telas/dispositivos; **não repetido** depois |
| E2E, 3 participantes (5 cenários), 1 execução, store em memória | `npx playwright test -c playwright.mesh.config.ts` | 5 passaram |
| E2E, 3 participantes, **store MongoDB** | `MONGODB_URI=… npx playwright test -c playwright.mesh.config.ts` | 5 passaram na versão anterior; **não repetido** depois |
| Duas instâncias de produção atrás de um balanceador round-robin, **sem MongoDB** (manual, 1 aba, 20 s) | script ad hoc | 4 `join` e tela de erro (antes: 9 em 25 s, sem parar) |
| Duas instâncias atrás do round-robin, **com MongoDB** (manual, 2 pessoas, 26 s) | script ad hoc | "2 na sala" estável nos dois, 1 `join` cada, "Conectado" com vídeo avançando, 0 erros HTTP/console/servidor |

O que os E2E de fato verificam: entrada só com sala e nome; dois participantes conectados com
vídeo cujo contador de quadros decodificados avança e bytes de áudio/vídeo recebidos, com o par
ICE escolhido entre os dois navegadores (sem relay); mic/câmera refletidos nos outros;
compartilhamento de tela; chat nos dois sentidos; arquivo de 70 KB íntegro; **reinício global**
(novas `RTCPeerConnection` nos dois lados, ninguém sai, vídeo volta); saída de participante; recarregar
a aba; sala com acento no nome; 9º participante ("Sala cheia", com câmera e microfone liberados);
em 3 pessoas, as 3 conexões do mesh, chat, reinício global feito por uma pessoa e por duas ao mesmo
tempo, e saída de um participante.

Não foi executado: **MongoDB Atlas real e o deploy na Vercel** (os testes usaram um MongoDB 7 local em Docker), **o som da aba com captura real** (os e2e simulam `getDisplayMedia` com um tom de 440 Hz; como o Chrome trata `systemAudio: 'exclude'` e o Safari trata `audio: true` não foi verificado), dispositivos de áudio reais (os e2e usam os falsos do Chromium), TURN real, redes com NAT simétrico, Firefox/Safari, câmeras reais, mais de 3
participantes em paralelo, e deploy real na Vercel (o projeto é um app Next.js padrão, mas não foi
publicado nem testado lá).

## Estrutura

```
src/server/      RoomStore (interface), MemoryRoomStore, MongoRoomStore, escolha por ambiente (store.ts), ICE, helpers das rotas
src/app/api/     rotas de sinalização (join, events, signal, chat, state, restart, leave)
src/lib/         cliente de sinalização, PeerManager, regras de negociação, arquivos, validação, view-state (exibição das telas), devices (dispositivos de áudio)
src/hooks/       useLocalMedia (câmera/mic/tela/som da aba), useRoom (sala + mesh), useViewState, useDevices
src/components/  JoinForm, RoomView, VideoGrid, VideoTile, SidePanel, ControlBar, SettingsDialog
e2e/             testes Playwright
docs/superpowers/  spec, plano e ledger do desenvolvimento
```
