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
