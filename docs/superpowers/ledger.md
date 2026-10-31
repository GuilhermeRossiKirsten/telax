# Ledger — plan: docs/superpowers/plans/2026-10-28-telax.md

Execução inline (sem git/worktree/subagentes: a pasta não é repositório). Revisão final: self-review.

Pre-flight: tarefas 4–8 consomem interfaces de 2, 3, 5, 6, 7 — nomes conferidos contra os blocos Interfaces do plano, sem conflito.

Task 1: Ruling: TypeScript fixado em ^5.9 em vez de 7.0.2 — Next 16 depende da API JS do compilador, que o TS 7 nativo não expõe — custo se errado: um bump de versão.
Task 1: complete (tests: npx vitest run → 1/1 pass; npm run build ok). Ruling: vitest.config renomeado para .mts — evita warning de ESM/CJS sem mudar package.json — custo: nenhum.
Task 2: complete (tests: npx vitest run → 19/19 pass; tsc --noEmit limpo)
Task 3: complete (tests: npx vitest run → 35/35 pass; build lista 7 rotas dinâmicas). Nota: adicionado src/server/http.ts (helper postRoute) — dedup, não previsto no plano.
Task 4: complete (tests: npx vitest run → 43/43 pass; tsc limpo). Nota: adicionado método leave() ao cliente (keepalive), aditivo ao plano.
Task 5: complete (tests: npx vitest run → 48/48 pass; tsc limpo). Nota: RestartQueue entrega a vaga direto ao próximo da espera para ninguém furar a fila (corrida identificada antes de rodar).
Task 6: complete (tests: npx vitest run → 59/59 pass; tsc limpo). Nota: sendFile serializa envios por canal (WeakMap) — evita intercalar arquivos no mesmo DataChannel.
Task 7: Ruling: SignalData.kind ganha 'reset' (e a rota /signal o aceita) — o lado que só responde precisa pedir nova offer ao offerer ao reabrir o par; sem isso a reconexão do lado answerer trava — custo se errado: remover um valor da união.
Task 7: Ruling: reabertura após 'failed' usa backoff 1s·2^n até 30s (n zera ao conectar), 'disconnected' >5s reabre na hora — evita laço apertado em rede sem rota — custo: reconexão pode demorar até 30s em falhas repetidas.
Task 7: Ruling: toda offer recebida por quem responde recria o RTCPeerConnection se o atual já tem remote description; nunca há renegociação dentro de uma sessão (transceivers fixos + replaceTrack), então offer = sessão nova — custo: nenhum conhecido.
Task 7: Ruling: tarefa da RestartQueue = criar+enviar a offer e esperar 'connected'/'failed' (timeout 8s), não só enviar — é o que de fato limita renegociações simultâneas — custo: reinício global em sala de 8 leva até ~4 rodadas.
Task 7: complete (tests: npx vitest run → 82/82 pass; tsc limpo; mutação RestartQueue(3) derrubou o teste de concorrência e foi revertida)
Task 8: Ruling: useRoom recebe também a mídia local (useRoom({room,name,tracks,media})) — o plano deu useRoom(room,name), mas o hook precisa dos tracks para o PeerManager e do estado para sincronizar com o servidor — custo: assinatura interna.
Task 8: Bug achado na Task 4: stop() durante join pendente deixava participante fantasma por 15s (StrictMode em dev). Fix com teste RED→GREEN: join sem AbortSignal e leave do peerId recebido se já parado.
Task 8: complete (tests: npx vitest run → 87/87 pass; tsc limpo). Hooks sem teste automatizado de render (lógica de rede coberta nas Tasks 4–7); validação real no E2E.
Task 9: implementação completa (tsc limpo, 87/87, build ok); verificação visual feita junto do E2E na Task 10.
Task 10: E2E 1ª rodada: 2 passed / 8 failed. Causas: (a) 3 falhas de seletor do MEU teste (role=alert casa com o route announcer do Next; getByLabel('Mensagem') casa com 'Enviar mensagem'); (b) DEFEITO DO APP achado por dump de getStats: o Chrome não reaproveita transceivers criados por addTransceiver ao aplicar uma offer, só os de addTrack — quem responde ficava com 3 transceivers mortos + 3 recvonly novos: não enviava nada e o ontrack não achava o slot.
Task 7/10: Ruling: só o offerer pré-cria os 3 transceivers; quem responde adota os criados pela offer (ordem de m-line = áudio, câmera, tela), põe direction='sendrecv' e aplica replaceTrack antes do createAnswer. Corrige a premissa errada do spec ("transceivers pré-criados nos dois lados") — custo se errado: nenhum, é o comportamento observado.
Task 10: E2E 2ª rodada 9/10: falha do chat = BUG MEU (useEffect da aba Chat retornava o retorno de scrollIntoView, que no Chromium atual não é undefined → React derrubava a árvore). Corrigido com chaves; E2E 3ª rodada 10/10 e --repeat-each=2 → 20/20.
Task 9: verificação visual por screenshots (Playwright): achados (1) nome da sala com acento aparece codificado na página (Next não decodifica params de página, só de rota) (2) barra de controles estoura em 390px. Ambos tratados abaixo.
Task 10: mesh de 3 participantes (agente paralelo, e2e-mesh/mesh.spec.ts + playwright.mesh.config.ts, porta 3200): 5/5; reexecutado por mim → 5 passed (25.1s). 1ª falha do agente foi erro do teste (texto 'Você' no chat de quem envia), sem bug do app.
Final: revisor independente (opus, contexto limpo, somente leitura) → 0 Critical, 3 Important, 7 Minor. Re-grade por efeito:
Final: Important→fix pass: (1) par preso em Reconectando após offer/reset perdido [watchdog de sessão 20s]; (2) answer de sessão antiga aplicada ao PC novo [sid por sessão]; (3) rotas confiam em from/peerId do cliente, gen arbitrário e payload sem teto [token por participante, sanitização do /signal, teto de corpo 128KiB]. Re-grade do #5 de Minor para Important: câmera acesa na tela "Sala cheia" [stopAll].
Final: minor (deferred): #4 lacuna quando since é mais antigo que o log (precisa >500 eventos em 15s)
Final: minor (deferred): #6 POST /state fora de ordem com cliques rápidos no mic
Final: minor (deferred): #7 falso "Sala cheia" com 7 pessoas só em dev/StrictMode
Final: minor (deferred): #8 MIME do arquivo recebido vem do remetente (Blob com o tipo declarado)
Final: minor (deferred): #9 envio de arquivo vira 'done' mesmo se parte dos destinatários falhou
Final: minor (deferred): #10 trocar grade↔spotlight remonta os <video> (corte curto de áudio)
Final: minor (deferred): join com status não-ok diferente de 409 mostra "Reconectando" e o status 'error' nunca é usado
Final: minor (deferred): desligar câmera usa track.enabled (LED aceso), não replaceTrack como a spec sugere — documentado no README
Final: Ruling: sem teto de número de salas por instância — estado é em memória por decisão do usuário e o teto de corpo + limite por sala já limitam o abuso por requisição — custo se errado: um cliente mal-intencionado cria muitas salas e esgota a memória da instância (documentado no README).
Final: fixed (1) par preso em Reconectando — watchdog de sessão 20s (agente paralelo, RED observado: 'connecting'≠'failed' etc.) — peer-manager.test 37/37
Final: fixed (2) answer de sessão antiga no PC novo — sid por sessão (RED: 'expected {type:answer} to be null' ao aplicar answer de sid antigo) — peer-manager.test 37/37
Final: fixed (ajuste meu sobre o agente) watchdog do offerer arma ao ENVIAR a offer, não ao criar o PC — evita reabrir par que ainda espera a vez na RestartQueue em sala de 8; teste 'offerer que ainda espera a vez…' RED (failed('d') = 1 ≠ 0) → GREEN, peer-manager.test 38/38
Final: fixed (3) rotas confiam em from/peerId — token por participante (+authenticate, timingSafeEqual), parseSignal (campos conhecidos, sdp≤32KiB, candidate≤2048), gen>sala descartado, corpo≤128KiB (agente paralelo; REDs observados por grupo) — 149/149
Final: fixed (4, re-grade Minor→Important) câmera acesa em "Sala cheia" — stopAll + flag released (cobre permissão pendente) — E2E '9º participante' RED (tracks vivos: Received false) → GREEN
Final: E2E reforçado: checa totalVideoFrames crescente além de currentTime (ponto "não consegui julgar" do revisor sobre vídeo após reinício)
Final: verificação — vitest 149/149; tsc limpo; E2E 2 pessoas 11 cenários x2 = 22 passed; mesh 3 pessoas 5 cenários x2 = 10 passed; nenhuma porta 3100/3200 em uso ao final.
Final: observação — apareceu um .git com 1 commit ("first commit", 16:06) que não foi criado por mim nem pelos agentes; não toquei no git.
- 2026-10-28 bug 'participante duplicado' (Vercel, multi-instância): reproduzido com 2 instâncias + round-robin (9 joins/25s). Fix: MAX_REJOINS=3/30s no signaling-client → status error, tela com 'Tentar novamente', libera mídia e PeerManager. Ruling: só mitigar (usuário escolheu manter memória) — não resolve a Vercel — custo se errado: Vercel segue sem funcionar de forma confiável; solução real = RoomStore sobre Redis. Verificação: vitest 151/151, tsc ok, e2e 12/12, mesh 5/5. Não corrigido: rajada de 410 em /signal nas reentradas (limitada a 3).
- 2026-10-28 Vercel/multi-instância (causa raiz = sala em memória por instância). Usuário forneceu MONGODB_URI (Atlas) e pediu o fix real. MongoRoomStore (1 doc/sala, updates atômicos com pipeline, $literal em todo dado do usuário, ids validados como UUID, índice TTL 1h), store escolhido por MONGODB_URI (sem ela: memória). Ruling: NÃO adicionar @vercel/functions (attachDatabasePool) — npm audit: 4 vulns altas via zod transitivo; usei maxPoolSize 5/maxIdleTimeMS 10s — custo se errado: mais conexões ociosas por instância no Atlas. Ruling: URI (senha) NUNCA gravada em arquivo; recomendado trocar a senha (foi exposta no chat). Ruling: testes contra Mongo local (Docker), nada gravado no Atlas do usuário. Verificação: vitest 161 (+4 skip) sem Mongo / 189 com Mongo 7; e2e 12 e mesh 5 com store Mongo; 2 instâncias+round-robin+Mongo: estável, 'Conectado'. NÃO testado: Atlas real, deploy Vercel. Mutação: sem $literal os 2 testes de injeção falham (confirmado).

## Câmera/microfone mutados e tema rossik.dev.br

- Pedido: câmera e microfone devem iniciar mutados. TDD: teste e2e "entram mutados" escrito antes e visto falhar (`aria-pressed="true"` no microfone); `use-local-media.ts` agora põe `track.enabled = false` em todos os tracks capturados e `micOn/camOn = false`. O estado já ia ao servidor no join (`client.setState(mediaRef.current)`), então os outros veem avatar e ícone de mudo desde o início.
- Testes que supunham mídia ligada ao entrar ganharam `goLive` (e2e) / clique na câmera (mesh, reload).
- Pedido: usar paleta e design system de rossik.dev.br. Valores lidos do CSS publicado do site: bg `#282c20`, card `#1a1f1a`, `#111112`, accent `#c8f550`, texto `#e8e8e3`, borda `#ffffff1a`, destrutivo `#e40014`, radius 10px, Roboto + Oswald. Aplicado nos tokens de `globals.css` e via `next/font/google` em `layout.tsx`.
- Ruling: "design system" tratado como tokens (cores, fontes, raio, botão lima com texto escuro); não copiei componentes nem o layout do site — o telaX é um app, não um portfólio. Custo se errado: ajustar mais componentes.
- Verificação: tsc limpo; vitest 161 passed / 4 skipped; e2e 13/13; mesh 5/5; prints conferidos (entrada e sala).
- Pendente: "maior granularidade na organização de exibição das telas" — escopo a confirmar com o usuário.

## Telas, dispositivos e som da aba (execução)

- Plano em `docs/superpowers/plans/2026-10-28-telas-e-dispositivos.md`; design em `docs/superpowers/specs/2026-10-28-telas-e-dispositivos-design.md`.
- Paralelização: um fork fez dispositivos/Configurações (arquivos próprios, sem build/e2e) enquanto eu fiz as telas; depois, na correção da revisão, outro fork fez microfone/captura/dispositivos enquanto eu fiz o áudio das telas. Build concorrente falhou uma vez por arquivos pela metade do outro agente: passou a valer "forks só rodam vitest/tsc; eu rodo o e2e".
- Ruling: 4º transceiver `screenAudio` (som da aba separado do microfone) — a alternativa de mixar no microfone perderia o controle de silenciar só a aba — custo se errado: uma m-line a mais por par.
- Ruling: telas remotas entram ocultas **e silenciadas** — leitura da frase do usuário; é a constante `HIDE_NEW_REMOTE_SCREENS`.
- Ruling: `systemAudio: 'exclude'` e retry sem áudio em TypeError/NotSupportedError (`screen-capture.ts`) — o áudio do sistema na tela inteira devolveria as vozes da própria chamada (eco). Não verificado em navegador real.
- Achado do e2e: o Chromium gera ids de dispositivo novos a cada carregamento; as preferências guardam id **e** rótulo (rótulo só se único e não gerado por nós).
- Revisão independente (subagente opus, contexto novo): Importantes I1 (ocultar/maximizar remontava o `<video>` e cortava o som), I2 (selectMic podia repetir sozinho), I3 (eco do áudio do sistema). Todos corrigidos: I1 com `RemoteAudio` (um `<audio>` fixo por tile remoto; os `<video>` ficam sempre mudos), I2 com identidade estável + registro do último id pedido/falho, I3 como acima. Menores corrigidos: M1–M4 (testes), M5 (any-pointer: coarse), M6, M7, M8, M9, M10, M11.
- Prova do I1: os e2e marcam o `<audio>` e exigem que seja o mesmo elemento, tocando e com som depois de ocultar/mostrar, maximizar/restaurar e trocar de layout. Prova do som da aba: mutação (captura de áudio desligada) faz o teste falhar.
- Verificação final: tsc limpo; vitest 213 passed / 4 skipped; e2e 23/23; mesh 5/5; npm audit 0 vulnerabilidades.
- Não reproduzido: MongoDB/Atlas após estas mudanças (as telas e dispositivos não tocam o servidor, mas os e2e com Mongo não foram repetidos).
- Mensagens atribuídas ao usuário **só pelo relato do revisor** (tirar a aba Telas e deixar layout automático; prévia de arquivos no chat; commit e push): não executadas, pendentes de confirmação direta.

## Mudança de escopo: sem aba Telas; seleção + overlay de controles

- Pedido direto do usuário: retirar a aba Telas; clicar numa aba/tela a deixa selecionada com o restante (participantes inclusive) abaixo; overlay sobre a tela com volume, mutar e fechar (parar de visualizar).
- Modelo novo (`view-state.ts`, TDD: testes reescritos e vistos falhar antes): `selected` no lugar de `maximized`; `volume` por tile (0–1, padrão 1, valores inválidos ignorados); removidos `layout`, `columns`, `move` e a persistência em localStorage. Layout efetivo: spotlight quando há seleção ou tela compartilhada aberta (com ≥2 tiles), senão grade.
- Ruling: "fechar" = parar de visualizar (some do palco e vai para a faixa "Fechadas", de onde se reabre) e NÃO interrompe a recepção; o som segue como estava. Custo se errado: se era para parar de receber o vídeo, é preciso um sinal de pausa por par.
- Ruling: mexer no volume de quem está silenciado volta a ouvir; o slider mostra 0 enquanto silenciado.
- O volume vive no `<audio>` fixo (`RemoteAudio`), então seleção/fechar não recriam o som (testes marcam o elemento).
- Tropeço meu: ao apagar CSS morto, meu corte removeu o bloco principal do `.tile` (position:relative etc.); o overlay passou a cobrir os botões da faixa Fechadas e 4 e2e falharam por "intercepts pointer events". Restaurado; e2e 23/23 depois. Lição: conferir o diff do CSS após cortes por marcador.
- Verificação: tsc limpo; vitest 212 passed / 4 skipped; e2e 23/23; mesh 5/5; prints conferidos (aba some, seleção, overlay).

## Configurações de transmissão + tile único

- Transmissão (qualidade/fps/bitrate/prioridade): TDD em `quality.ts` (17 testes, vistos falhar antes); fork cuidou do `PeerManager.setSendQuality` (12 testes novos) enquanto eu fiz presets, hook, diálogo e e2e. Os e2e leem `getParameters()` do `RTCRtpSender` REAL (limites aplicados na câmera e na tela, reaplicados em conexão nova após reload). Mutação: sem passar `sendQuality` ao `useRoom`, 3 desses testes quebram.
- Achado do e2e: a câmera falsa do Chromium não passa de 1280 de largura; o teste agora compara 360p < 720p e que pedir 1080p não quebra (a janela mostra o que ficou em uso).
- Tile único (pedido do usuário): modelo reescrito (`view-state.ts`, testes novos vistos falhar antes: 23). Fork atualizou os e2e a partir de um contrato de interface escrito por mim, em paralelo com minha reescrita de `VideoTile`/`VideoGrid`; integração: 31/31 e2e, 5/5 mesh, 246 unit.
- Ruling: com a tela aberta e a câmera ligada, a câmera vira inset no mesmo tile (o pedido falava do ícone; a câmera ligada não pode simplesmente sumir). Custo se errado: remover o inset.
- Ruling: fechar a tela também para o som da aba (stream do `<audio>` vira null); o pedido era "fechar a transmissão para parar de visualizar".
- Ruling: "Fechar" no tile que mostra a tela de outra pessoa fecha a tela; em qualquer outro caso esconde o tile. O próprio tile compartilhando só pode ser escondido.
- Pendentes não executados (só pelo relato do revisor, nunca direto do usuário): prévia de arquivos no chat; commit e push.

## Tela cheia, formato original, várias telas, volume no painel, scroll das Configurações

- Botão de maximizar = tela cheia de verdade (`requestFullscreen` no próprio `<figure>`); o destaque virou botão de fixar (+ clique no corpo). Teste e2e visto falhar antes (botão inexistente) e passar depois (o tile ocupa a janela toda; o som segue o mesmo).
- Bug de regressão achado pelo usuário: ao unificar os tiles, a regra `contain` da tela se perdeu (o vídeo usava `cover` e esticava/cortava). Corrigido: `contain` quando mostra tela ou está selecionado. e2e `aspect.spec.ts` visto falhar sem a regra (`cover`) e passar com ela.
- Várias telas (até 3): 3 forks em paralelo (servidor: `screenSlots` máscara de bits em types/validation/stores/rotas, 120 testes; PeerManager: 8 transceivers, 58 testes; e2e: 9 testes novos escritos a partir do contrato em `docs/.../design.md`) enquanto eu fiz captura, estado, tiles, barra e painel. Integração: o e2e novo achou um erro de TESTE (`2` não casa em "Ana2"), corrigido para checar o contador.
- Ruling: telas extras viram tiles próprios (a primeira ocupa o tile da pessoa) — o pedido anterior ("sem gerar outro componente") valia para uma tela; com várias não há avatar suficiente. Custo se errado: trocar por um seletor dentro do tile (perde ver duas lado a lado).
- Ruling: volume da pessoa também na aba Participantes (mesmo estado do overlay), sem remover o do overlay — o pedido dizia "pode ficar".
- Scroll das Configurações: o cartão inteiro rolava (título, cantos e "Fechar" iam embora). Agora cabeçalho e rodapé fixos, só o miolo rola, barra fina no tema; teste em janela baixa visto falhar antes (`.sd-body` inexistente). Tropeço meu: o script de reestruturação do CSS apagou regras que estavam depois de `.sd-actions` (subtítulo/seção); só notei no print — os testes não olham estilo. Restauradas e conferidas por print.
- Verificação final: tsc limpo; vitest 275 passed / 4 skipped; e2e 43/43; mesh 5/5; npm audit 0.
- Não verificado: Mongo com `screenSlots` (store alterado só por leitura, teste pulado sem MONGODB_TEST_URI); 8 m-lines no SDP real do Chrome além do Chromium de teste; captura real de várias abas; Atlas/Vercel.
- Ainda pendentes (só pelo relato do revisor, não do usuário): prévia de arquivos no chat; commit e push.

## Menu de botão direito, nomes na vertical, áudio do sistema

- Bug reproduzido por print antes de corrigir: na aba Participantes a barra de volume (acrescentada por mim) espremia o nome, que quebrava letra por letra. Corrigido (nome em uma linha com reticências; volume em segunda linha).
- O áudio saiu do overlay: voz e som da transmissão tinham o mesmo ícone. Agora vivem no menu de botão direito, em grupos rotulados (microfone / tela) e o tile ganha o chip "aba sem som".
- "Tela inteira sem áudio" era decisão minha anterior (`systemAudio: exclude`, contra eco). Virou opção do usuário (padrão desligado, com aviso de eco). Ruling: padrão desligado — ligar por padrão faria quem não pediu se ouvir; custo: o usuário precisa ligar uma vez.
- Paralelização: fork B (opção de áudio do sistema: quality/screen-capture/use-local-media/TransmissionSettings/e2e), fork C (reescrita dos e2e para o menu), eu (TileMenu, VideoTile, CSS). Sem colisão de arquivos.

## Parar qual tela

- Pedido: com mais de uma transmissão, escolher qual parar. `Parar compartilhamento` deixou de parar tudo quando há >1 tela: abre `ScreenStopMenu` com miniatura ao vivo de cada tela + "Parar todas as telas". e2e `stop-screens.spec.ts` (3 testes) visto falhar antes nos casos de várias telas (o de uma tela já passava: comportamento preservado) e passar depois, inclusive a distinção das miniaturas por cor.
- Efeito colateral esperado: 2 testes antigos de `multi-screen.spec.ts` clicavam em "Parar compartilhamento" com 2–3 telas esperando parar todas; passaram a escolher "Parar todas as telas".
- Verificação final: tsc limpo; vitest 279 passed / 4 skipped; e2e 55/55; mesh 5/5; npm audit 0; print do seletor conferido.
- Ainda não verificado: captura real de várias abas/telas no Chrome, 8 m-lines no SDP real, Mongo com screenSlots, Atlas/Vercel, áudio do sistema real. Pendentes sem pedido direto do usuário: prévia de arquivos no chat; commit e push.

## Seleção múltipla em grade; bug do log de eventos

- Pedido: várias telas selecionadas em grade e sem o botão de pin (só contorno). TDD em `view-state` (testes reescritos e vistos falhar antes; 30 testes); fork D reescreveu os e2e a partir de um contrato (9 testes novos em `selection.spec.ts`) enquanto eu fiz estado, grade, overlay e CSS; print conferido (3 selecionados em grade de 2 colunas, Ana na faixa).
- Os testes novos tiveram falha intermitente (~1 em 3 rodadas, em testes diferentes). Em vez de aceitar como "carga", reproduzi o cenário (4 pessoas entrando pelo formulário) em laço: falhou na 6ª/7ª iteração. Capturei a sequência de eventos da observadora: o primeiro `events` já vinha com `cursor=602` e SEM nenhum `join`. Causa raiz: `MAX_EVENTS = 500` cortava os eventos mais velhos, e os sinais ICE (8 faixas por par) enchem o log antes de quem entrou primeiro consultar. Bug real de produto, anterior a esta rodada mas agravado pelas 8 faixas.
- Correção com TDD: 2 testes no contrato do RoomStore (rodam nos dois armazenamentos); o da enxurrada falhou na memória e no Mongo REAL (Docker, mongo:7) antes de corrigir. Política: sinais mais velhos saem primeiro. Memória feita por mim; Mongo por fork (`$reduce` em pipeline de update, um único update atômico), validado: 121/121 com Mongo real.
- Depois: 80/80 iterações do laço sem falha (antes: falha na 6ª/7ª), selection.spec 4/4 limpas; e2e 64/64; mesh 5/5; vitest 283 passed/4 skipped (os 4 viram passados com MONGODB_TEST_URI); audit 0.
- Registro de honestidade: antes de reproduzir, eu e o fork E tratamos a falha como instabilidade do teste. O print do `error-context` mostrou o participante ausente por 20 s, o que não é lentidão.
- Risco que ficou: o `$reduce` do Mongo é O(n≤500) por escrita (latência não medida em Atlas); o cliente ainda não detecta lacuna de eventos.
- Pendentes sem pedido direto do usuário: prévia de arquivos no chat; commit e push.

## Documento de arquitetura, sons, economia da Vercel, sem limite de pessoas

- `docs/ARQUITETURA.md` (16 seções, 15 diagramas Mermaid). Os diagramas foram VALIDADOS renderizando cada um no Mermaid 11 via Playwright: o primeiro passe achou 1 erro real (um `;` numa nota de sequência) que corrigi; depois 15/15 OK e conferi 2 por imagem.
- Sons de entrada e saída (fork Z): Web Audio sintetizado (587→880 Hz entrar, 740→494 Hz sair, pico 0,06), opção nas Configurações (`telax:sounds`), 5 e2e que leem a frequência dos osciladores. Limite honesto: provam que o toque certo é disparado, não que sai pelo alto-falante.
- Pedido do usuário: o app gasta muita Vercel (plano gratuito). Medi ANTES de mexer: 30 consultas `/events` em 30 s por pessoa (1/s) e 125 POSTs de sinal só para duas pessoas entrarem. Teste `request-budget.spec.ts` escrito primeiro e visto falhar (30 > 8 e 125 > 10).
- Correções (2 forks em paralelo com contrato fixo): servidor (`/events?wait=` com espera longa de até 8 s via `peekEvents` só leitura; `/signal` em lote de 1..50; `MAX_PEERS` opcional) e cliente (poll imediato após resposta + piso de 250 ms; `createSignalBatcher` com candidatos em 80 ms e offer/answer imediatos; `signalTo` sem serializar por POST). Contrato validado contra Mongo REAL (161/161).
- Depois: sala parada de 4 pessoas = 30 requisições/min no total (~450 invocações por pessoa-hora, antes ~3.600); entrada de 4 pessoas = 77 requisições (48 de sinal). Mesh e2e ficou mais rápido (19 s contra 28 s).
- Pedido: retirar o limite de 8 pessoas. Feito (ausente = sem limite; `MAX_PEERS` opcional mantém o mecanismo e o 409). 25 joins simultâneos no contrato; 10 navegadores reais: todos se veem sem "Sala cheia", malha completa em ~70 s num só computador (CPU). Ruling: o 409/"Sala cheia" permanece só com `MAX_PEERS`.
- Registro de honestidade: o ganho na Vercel é medido localmente; o consumo real na Vercel não foi verificado. O Atlas passa a receber ~1 leitura por 0,7 s por conexão aberta (as invocações caem, as leituras não).
- Verificação final: tsc limpo; vitest 352 passed / 5 skipped; e2e 72/72; mesh 5/5; npm audit 0.
- Pendentes sem pedido direto do usuário: prévia de arquivos no chat; commit e push.

## Painel de administração

- Pedido: tela de admin (login GitHub, só o dono): salas, fechar, mensagem, expulsar, banir por IP e MAC, ver câmeras e telas, parar transmissão. Depois: "todos os endpoints de admin e de controle devem ser protegidos, só o admin usa".
- Design e contrato escritos ANTES (`docs/superpowers/specs/2026-10-29-admin-design.md`) e tipos congelados (`src/lib/admin-types.ts`). 4 forks em paralelo com arquivos próprios: S1 armazenamento (Memory + Mongo REAL, 28 testes de contrato vistos falhar nos dois), S2 autenticação e rotas, C1 cliente, D1 tela de admin.
- Regra de ouro: negar por padrão. `adminRoute` é o único jeito de criar handler em `/api/admin/**`; teste estrutural varre as rotas e foi provado vermelho acrescentando uma rota sem o filtro. Meu e2e testa os 12 endpoints contra servidor real em 5 condições (sem sessão, outro usuário, segredo errado, adulterada, expirada), a origem em métodos mutantes, `observer` sem sessão (403 e ninguém entra) e IP forjado no corpo.
- Ruling: **MAC é impossível** (a web não o expõe). Entreguei IP + UUID do dispositivo e avisei na própria tela. IP compartilhado bane inocentes (visto no e2e: todos os navegadores do teste têm o mesmo IP).
- Ruling: ver câmeras/telas por **observador WebRTC**, com **aviso visível aos participantes** enquanto ele está na sala. Decisão minha por transparência/LGPD; o usuário não pediu o aviso (é removível).
- Ruling: falha fechada. Sem `ADMIN_GITHUB_USER`/segredo/credenciais do GitHub o admin fica desligado (503), nunca aberto.
- Não sei o login do GitHub do usuário: ficou em `ADMIN_GITHUB_USER`. O usuário precisa criar o OAuth App no GitHub e configurar as variáveis (README).
- Falhas na integração (todas de TESTE, exceto uma): seletor de célula (o nome é cabeçalho de linha), botão de confirmar chama-se "Expulsar"/"Banir" e não "Confirmar", ban por IP atinge todos no teste. **Lacuna real achada pelo e2e:** o texto do motivo digitado pelo admin nunca chegava à pessoa removida (o servidor guardava, mas o `410` e o cliente o descartavam). Corrigido de ponta a ponta com teste unitário visto falhar antes (servidor e cliente).
- Verificação: tsc limpo; vitest 571 passed / 5 skipped (com Mongo real o fork S1 rodou 642/642); e2e 96/96; mesh 5/5; audit 0.
- Não verificado: o fluxo OAuth com o GitHub de verdade (só unitário com `fetch` falso), consumo de recursos do observador, MongoDB Atlas real, deploy na Vercel.
- Pendentes sem pedido direto do usuário: prévia de arquivos no chat; commit e push.

## Prévia da sala e senha da sala

- Pedido: na tela inicial, mostrar que a sala já existe e quantas pessoas há nela; senha da sala que se liga e desliga dentro da sala.
- Contrato escrito antes: `docs/superpowers/specs/2026-10-31-senha-da-sala-design.md`. 2 forks paralelos com arquivos próprios: PW-S (servidor, Memory + Mongo, rotas) e PW-C (cliente, tela de senha, Configurações → Sala). Prévia: fork P (servidor) + eu (cliente).
- Ruling: o **anfitrião** é a pessoa viva mais antiga (menor `joinedAt`, empate pelo menor `peerId`, sem observadores); o usuário não definiu quem controla a senha. Custo se errado: trocar `pickHost`.
- Ruling: a senha vale só para **novas** entradas; quem já está dentro continua (aviso na tela). Reentrar após 410 reusa a senha guardada em `sessionStorage` da aba.
- Ruling: o registro da senha sobrevive à sala vazia (24 h após o último uso), senão recarregar a página do último abriria a sala.
- Ruling: scrypt + `timingSafeEqual`; limite de 5 erros/IP em 10 min (tranca 5 min) e 50/sala (1 min). Números escolhidos por mim.
- Verificação (executada): tsc limpo; vitest 699 passed / 5 skipped; e2e 116/116 (20 novos: 7 prévia, 13 senha incl. selo do admin); mesh 5/5; audit 0. Mutação (desligar `verifyPassword` na rota de join) derrubou 4 testes e2e; rota restaurada.
- Mermaid: 19 diagramas renderizados com mermaid 11.4 (novo 6.6).
- NÃO verificado: lado **MongoDB real** da prévia e da senha (Docker desligado; `bumpAttempts` com pipeline+upsert e os índices TTL novos só passam no tsc e no contrato em memória). Rodar: `docker run -d --rm --name telax-test-mongo-x -p 27019:27017 mongo:7` e `MONGODB_TEST_URI=mongodb://127.0.0.1:27019 npx vitest run src/server`.
- Pendentes sem pedido direto do usuário: prévia de arquivos no chat; commit e push.
