# telaX

Videoconferência no navegador, sem cadastro: informe **nome da sala** e **seu nome** e entre.
Áudio, vídeo e arquivos vão **direto entre os navegadores** (WebRTC P2P em malha); o servidor só
intermedeia a sinalização, a presença e o chat.

- Áudio e vídeo, compartilhamento de tela, chat em tempo real, envio de arquivos (até 25 MB)
- Lista de participantes com estado de conexão (Conectando / Conectado / Reconectando / Falhou)
- **Reiniciar conexões**: renegocia todos os pares sem ninguém sair da sala
- Reconexão automática de pares e do canal de sinalização
- Até 8 participantes por sala; interface escura com detalhes roxos, responsiva

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

Tudo é opcional. Copie `.env.example` para `.env.local` se precisar de TURN.

| Variável | Para que serve |
|---|---|
| `TURN_URLS` | URLs do servidor TURN, separadas por vírgula (`turn:host:3478,turns:host:5349`) |
| `TURN_USERNAME` | usuário do TURN |
| `TURN_CREDENTIAL` | senha do TURN |

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

### ⚠️ Limitação importante: estado em memória

Por decisão de projeto, **não há serviço externo**: as salas ficam na memória do processo do
servidor. Na Vercel cada instância serverless tem a própria memória, então dois participantes da
mesma sala podem ser atendidos por instâncias diferentes e **não se enxergarem**. Em `next dev` e
`next start` (uma única instância) funciona de forma confiável; na Vercel funciona em "melhor
esforço" (por exemplo, com pouco tráfego e a mesma instância reaproveitada), sem garantia.

O armazenamento fica atrás da interface `RoomStore` (`src/server/room-store.ts`). Para um deploy
confiável na Vercel, implemente essa interface sobre Redis (ou outro armazenamento compartilhado) e
troque o retorno de `getStore()` em `src/server/store.ts`; nada mais precisa mudar. Isso **não** foi
implementado.

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
- **Mídia sem renegociar:** o offerer cria 3 transceivers (áudio, vídeo da câmera, vídeo da tela) e
  quem responde adota os criados pela offer; ligar/desligar câmera, microfone e tela é
  `replaceTrack`, sem nova negociação.
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

- **Estado em memória** (ver acima): confiável só em instância única.
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
- **Sem limite de número de salas por instância:** como tudo é memória, um cliente mal-intencionado
  pode criar muitas salas e esgotar a memória da instância. As requisições e cada sala têm limites,
  o total de salas não.
- **Histórico e MIME:** o tipo (MIME) de um arquivo recebido é o declarado por quem enviou.
- Sem tratamento de troca de dispositivo (câmera/microfone) durante a chamada.
- Um erro de join diferente de "sala cheia" (por exemplo, 500 do servidor) aparece como
  "Reconectando" e o app segue tentando; não há tela de erro dedicada.

## Testes

```bash
npx vitest run         # unidade (regras, store, rotas, cliente de sinalização, PeerManager, arquivos)
npx tsc --noEmit       # tipos
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
| Unidade (store, rotas, token, sinais, cliente, PeerManager, arquivos) | `npx vitest run` | 149 passaram, 0 falharam |
| Tipos | `npx tsc --noEmit` | sem erros |
| Build de produção | `npm run build` (feito pelo Playwright antes de subir o servidor) | ok |
| E2E, 2 participantes (11 cenários), repetido 2× | `npx playwright test --repeat-each=2` | 22 passaram |
| E2E, 3 participantes (5 cenários), repetido 2× | `npx playwright test -c playwright.mesh.config.ts --repeat-each=2` | 10 passaram |

O que os E2E de fato verificam: entrada só com sala e nome; dois participantes conectados com
vídeo cujo contador de quadros decodificados avança e bytes de áudio/vídeo recebidos, com o par
ICE escolhido entre os dois navegadores (sem relay); mic/câmera refletidos nos outros;
compartilhamento de tela; chat nos dois sentidos; arquivo de 70 KB íntegro; **reinício global**
(novas `RTCPeerConnection` nos dois lados, ninguém sai, vídeo volta); saída de participante; recarregar
a aba; sala com acento no nome; 9º participante ("Sala cheia", com câmera e microfone liberados);
em 3 pessoas, as 3 conexões do mesh, chat, reinício global feito por uma pessoa e por duas ao mesmo
tempo, e saída de um participante.

Não foi executado: TURN real, redes com NAT simétrico, Firefox/Safari, câmeras reais, mais de 3
participantes em paralelo, e deploy real na Vercel (o projeto é um app Next.js padrão, mas não foi
publicado nem testado lá).

## Estrutura

```
src/server/      RoomStore (interface), MemoryRoomStore, ICE, helpers das rotas
src/app/api/     rotas de sinalização (join, events, signal, chat, state, restart, leave)
src/lib/         cliente de sinalização, PeerManager, regras de negociação, arquivos, validação
src/hooks/       useLocalMedia (câmera/mic/tela), useRoom (sala + mesh)
src/components/  JoinForm, RoomView, VideoGrid, VideoTile, SidePanel, ControlBar
e2e/             testes Playwright
docs/superpowers/  spec, plano e ledger do desenvolvimento
```
