# telaX — Ideias para o futuro

> Só ideias. **Nada aqui foi implementado.** Cada item traz o esforço estimado (P/M/G), o efeito na cota da Vercel e o que toca no código, para ajudar a escolher.
> Legenda de esforço: **P** = algumas horas · **M** = um dia ou dois · **G** = vários dias ou mudança de arquitetura.
> Legenda de custo na Vercel: 🟢 nenhum · 🟡 pouco · 🔴 pesa (cada requisição conta; veja `ARQUITETURA.md` seção 15).

---

## 1. Já combinado, ainda sem decisão

| Ideia | Esforço | Vercel | Observação |
|---|---|---|---|
| Prévia de arquivos no chat (imagem, PDF, áudio, vídeo) | M | 🟢 | Os arquivos já vão por P2P; a prévia seria só no navegador de quem recebe. Cuidado com o MIME, que é o declarado por quem envia. |
| Commit e push do projeto | P | 🟢 | Nada foi commitado até agora. Antes: conferir que nenhum segredo está em arquivo versionado. |
| Rodar o contrato do store contra um MongoDB real (prévia e senha) | P | 🟢 | Já houve um bug que só um Mongo real pegaria (`$p` em vez de `$$p`). Idealmente vira CI. |

---

## 2. Controle da sala (anfitrião)

| Ideia | Esforço | Vercel | Observação |
|---|---|---|---|
| **Sala de espera**: quem chega fica esperando e o anfitrião admite ou recusa | M | 🟡 | Alternativa à senha. Exige um estado novo "aguardando" e um evento para o anfitrião. |
| **Trancar a sala**: ninguém novo entra, com ou sem senha | P | 🟢 | Reaproveita o caminho da senha. Boa para "já começamos". |
| Passar o posto de anfitrião a outra pessoa, manualmente | P | 🟢 | Hoje é sempre a pessoa mais antiga. |
| Anfitrião expulsa alguém da sala (sem precisar do admin do site) | M | 🟢 | O admin já tem expulsar/banir; seria uma versão limitada à própria sala. |
| Silenciar todos / pedir para desligar câmeras | P | 🟢 | O admin já tem comandos de "parar mídia"; falta a versão do anfitrião. |
| Link de convite com a senha embutida no fragmento (`#`) | P | 🟢 | O fragmento nunca vai ao servidor, então a senha não vaza em logs. |
| Sala com prazo: apaga sozinha depois de N horas | P | 🟢 | O Mongo já tem TTL. |
| Mostrar também salas **vazias** que ainda existem (por exemplo, com senha) na prévia | P | 🟢 | Hoje a sala vazia sem senha não aparece, porque deixa de existir. |

---

## 3. Durante a chamada

| Ideia | Esforço | Vercel | Observação |
|---|---|---|---|
| **Quem está falando**: destaque no tile pelo volume do áudio | M | 🟢 | Medição local com `AnalyserNode`, sem servidor. |
| Mão levantada e reações (👍 👏) | P | 🟡 | Usa o `/state`. Um evento por clique, então vale limitar a frequência. |
| Layout "palestrante": uma tela grande e os outros em faixa | M | 🟢 | Hoje há grade e seleção. |
| ~~Picture-in-Picture da tela compartilhada~~ — **feito** (botão no tile da tela; ver `ARQUITETURA.md` 7.3) | P | 🟢 | `requestPictureInPicture()` do navegador. |
| Fundo desfocado ou virtual da câmera | G | 🟢 | Segmentação no navegador (MediaPipe). Pesa na CPU. |
| Legendas ao vivo | M | 🟢 | `SpeechRecognition` do navegador; só Chrome, e depende da língua. |
| Gravação local da chamada | M | 🟢 | `MediaRecorder` no navegador de quem grava. Avisar os demais é questão de privacidade. |
| Teste de câmera e microfone **antes** de entrar (lobby de mídia) | M | 🟢 | Hoje a mídia abre já na entrada, mutada. Resolveria também o caso da tela de senha. |
| Compartilhar só uma aba/janela com áudio dela, com aviso de eco | P | 🟢 | Já existe a opção de áudio do sistema; falta orientar a pessoa. |
| Indicador de qualidade da conexão por pessoa | M | 🟢 | `getStats()` já está disponível no `RTCPeerConnection`. |

---

## 4. Chat e arquivos

| Ideia | Esforço | Vercel | Observação |
|---|---|---|---|
| Links clicáveis (com cuidado: `rel="noopener noreferrer"`, só `http/https`) | P | 🟢 | |
| Colar imagem da área de transferência | P | 🟢 | Entra no mesmo caminho dos arquivos P2P. |
| Responder e citar mensagem | M | 🟡 | O corpo da mensagem ganha um campo. |
| Notificação sonora e contador de não lidas com o chat fechado | P | 🟢 | Os sons de entrada e saída já existem; seria a mesma estrutura. |
| Indicador "fulano está digitando…" | P | 🔴 | Gera muitas requisições. Só valeria por P2P (DataChannel), nunca pelo servidor. |
| Histórico do chat para quem entra depois | M | 🟡 | Hoje o log guarda 500 eventos e 5 min. Exige decidir por quanto tempo guardar texto (privacidade). |

---

## 5. Escala e custo (o ponto mais importante a longo prazo)

| Ideia | Esforço | Vercel | Observação |
|---|---|---|---|
| **SFU** (LiveKit, mediasoup ou similar) para salas grandes | G | 🟢 | A malha completa com 10 pessoas levou ~70 s num computador só; acima de ~6 a experiência cai. É a mudança que mais muda o produto. |
| Sinalização por **SSE ou WebSocket** em um serviço fora da Vercel | G | 🟢 (ganha) | Tira o long-poll das funções serverless. Hoje: ~450 invocações por pessoa-hora parada. |
| **TURN** próprio (coturn) ou gerenciado | M | 🟢 | Hoje depende de TURN configurado por variável. Sem ele, redes com NAT simétrico falham. |
| Trocar a sinalização do Mongo por Redis (Upstash) | G | 🟡 | Menos carga no Atlas; exige reescrever o `RoomStore` Mongo. A interface já existe, e o mesmo contrato de testes serve. |
| Qualidade adaptativa por número de pessoas (baixar bitrate automaticamente) | M | 🟢 | Já existem limites no `RTCRtpSender`; falta a regra automática. |
| Limite opcional de salas simultâneas | P | 🟢 | Hoje não há limite de salas. |

---

## 6. Segurança e privacidade

| Ideia | Esforço | Vercel | Observação |
|---|---|---|---|
| Limite de requisições por IP também no `join` (sem senha) e no `preview` | P | 🟡 | Hoje só a senha tem limite. A prévia pública poderia ser usada para varrer nomes de sala. |
| Captcha leve ao criar muitas salas seguidas | M | 🟡 | |
| Chat com criptografia ponta a ponta | G | 🟢 | Exige distribuir chaves entre os participantes; complica entrada tardia. |
| Registro de auditoria das ações do admin (quem fez o quê, quando) | M | 🟡 | Hoje há tombstones, mas não um histórico. |
| Aviso de monitoramento configurável (texto e idioma) | P | 🟢 | O aviso visível já existe quando o admin observa. |
| Política de privacidade e termos em uma página | P | 🟢 | Vale se for abrir ao público (LGPD). |

---

## 7. Painel de administração

| Ideia | Esforço | Vercel | Observação |
|---|---|---|---|
| Métricas simples: salas por dia, pico de pessoas, tempo médio | M | 🟡 | Precisa guardar contadores (Mongo). |
| Lista de banidos com opção de desfazer | P | 🟢 | |
| Banir faixa de IP ou deviceId em lote | P | 🟢 | |
| Mensagem global a todas as salas ("manutenção em 5 min") | P | 🟢 | |
| Mais de um administrador | M | 🟢 | Hoje é um único `ADMIN_GITHUB_USER`. Uma lista seria o caminho simples. |

---

## 8. Experiência e acessibilidade

| Ideia | Esforço | Vercel | Observação |
|---|---|---|---|
| Tema claro (hoje só o tema escuro da rossik.dev.br) | P | 🟢 | |
| Atalhos de teclado (mudo, câmera, tela, chat) | P | 🟢 | |
| Layout para celular (controles maiores, grade vertical) | M | 🟢 | O compartilhamento de tela no celular é limitado pelos navegadores. |
| PWA instalável | P | 🟢 | |
| Internacionalização (pt-BR e en) | M | 🟢 | Os textos estão no código; precisariam sair para um dicionário. |
| Revisão com leitor de tela e navegação só pelo teclado | M | 🟢 | Há `role` e `aria-live` em alguns pontos, mas nenhuma auditoria feita. |
| Nome e câmera/microfone preferidos lembrados entre visitas | P | 🟢 | Parte já está em `localStorage`. |

---

## 9. Qualidade do projeto

| Ideia | Esforço | Vercel | Observação |
|---|---|---|---|
| **CI** (GitHub Actions): `tsc`, `vitest`, Playwright, `npm audit` | M | 🟢 | Hoje tudo é rodado à mão. |
| Mongo real no CI (serviço `mongo:7`) | P | 🟢 | Teria pego o bug da prévia antes de chegar ao usuário. |
| Testes de componente (jsdom ou Playwright CT) | M | 🟢 | Hoje o Vitest roda em Node puro, então a interface só é coberta pelo e2e. |
| Monitoramento de erros (Sentry ou similar) | P | 🟢 | |
| Teste de carga da sinalização (muitas salas) | M | 🟢 | O consumo da Vercel foi medido só em testes locais. |
| Teste em Firefox e Safari | M | 🟢 | Nada foi verificado fora do Chromium. |

---

## 10. Dívidas e pontos a rever (coisas que já sabemos)

- A câmera e o microfone abrem (mutados) mesmo na tela de senha, antes de a pessoa entrar.
- O README ainda descreve o *polling* de ~1 s; o comportamento atual é long-poll de até 8 s.
- O lado MongoDB real da prévia e da senha só foi validado por teste unitário de forma, não por contrato executado.
- OAuth do GitHub, Atlas e deploy na Vercel nunca foram exercitados de ponta a ponta.
- O e2e usa o armazenamento em memória; um e2e com Mongo foi feito uma vez e **não** foi repetido depois das últimas mudanças.
- Banir por MAC é impossível na web; o que existe é IP + identificador do dispositivo. IP compartilhado (empresa, escola) pode banir inocentes.

---

## 11. Usabilidade (pensando em quem usa)

> Também só ideias. Partem do que o app já faz hoje: formulário de entrada, grade de tiles com menu por clique direito, seleção múltipla, Configurações, chat e compartilhamento de até 3 telas.

### 11.1 Antes de entrar

| Ideia | Esforço | Vercel | Observação |
|---|---|---|---|
| **Copiar link da sala** em um clique, com o nome da sala já preenchido (hoje existe `?room=`, falta o botão visível no formulário e dentro da sala) | P | 🟢 | Convidar é o primeiro passo de toda reunião. |
| **Gerar um nome de sala** ("sala-azul-47") quando a pessoa não souber o que digitar | P | 🟢 | |
| **Lembrar o último nome e as últimas salas** (lista "Salas recentes" abaixo do formulário) | P | 🟢 | `localStorage`, nada no servidor. |
| Prévia de câmera e microfone na tela inicial, com medidor de volume e escolha de dispositivo | M | 🟢 | Hoje só se descobre que o microfone está errado depois de entrar. |
| Dizer **por que** pedimos câmera e microfone, e o que acontece se a pessoa negar | P | 🟢 | Entrar sem câmera deve ser um caminho normal, não um erro. |
| Botão para mostrar/ocultar a senha no campo de senha | P | 🟢 | Evita errar a senha digitando às cegas. |
| Mensagem de erro que diz o que fazer ("Sala cheia", "Sala encerrada", "Senha errada: tente de novo ou peça a senha a quem convidou") | P | 🟢 | Alguns erros hoje só dizem o que houve, não o próximo passo. |

### 11.2 Dentro da chamada: descobrir e entender

| Ideia | Esforço | Vercel | Observação |
|---|---|---|---|
| **Menu de tile também por pressão longa e por botão "⋯"** visível ao passar o mouse | M | 🟢 | O menu atual é só por clique direito: no celular e para quem não conhece o gesto, ele não existe. |
| **Dica de primeira vez** ("clique com o botão direito num participante para ajustar o volume") que some depois de usada | P | 🟢 | Guardar "já viu" em `localStorage`. |
| Painel de **atalhos** (tecla `?`), com atalhos para mutar (`M`), câmera (`V`), tela (`S`), chat (`C`), tela cheia (`F`) | M | 🟢 | Também ajuda quem usa só o teclado. |
| **Rótulos nos ícones** dos controles na primeira vez (ou ao passar o mouse, com atraso curto) | P | 🟢 | |
| Mostrar **quem está sem câmera/microfone** com ícone claro no próprio nome do tile | P | 🟢 | Já existe estado de mic e câmera por pessoa; é só tornar a marca mais visível. |
| Aviso claro quando **eu** estou mudo e começo a falar ("Você está no mudo") | M | 🟢 | O erro de uso mais comum em videochamada. Medição local do volume. |
| Contador de **tempo da reunião** e de quantas pessoas estão na sala | P | 🟢 | |
| Indicador discreto de **conexão fraca** por pessoa, com sugestão de desligar a câmera | M | 🟢 | Usa `getStats()`. |

### 11.3 Grade, telas e seleção

| Ideia | Esforço | Vercel | Observação |
|---|---|---|---|
| **Recolher quem não fala**: modo "só quem fala ou compartilha" para salas grandes | M | 🟢 | A grade com 8+ pessoas fica pequena. |
| **Duplo clique** num tile para ampliar só ele (e outro duplo clique para voltar) | P | 🟢 | Hoje a seleção é por clique; o duplo clique seria um atalho. |
| **Arrastar para reordenar** os tiles, só na minha tela | M | 🟢 | Combina com a ideia de estado local de exibição que o app já segue. |
| Manter minha própria câmera como **miniatura flutuante** que posso arrastar | M | 🟢 | |
| Quando alguém compartilha a tela, **ampliar sozinho** (com opção de desligar isso) | P | 🟢 | Hoje é preciso selecionar. |
| Na seleção, um **botão "limpar seleção"** visível, além do clique fora | P | 🟢 | |
| Lembrar o layout escolhido (grade, foco) entre reuniões | P | 🟢 | |

### 11.4 Compartilhar tela

| Ideia | Esforço | Vercel | Observação |
|---|---|---|---|
| **Aviso antes de compartilhar** ("Tudo que aparecer será visto por todos. Feche abas privadas.") com "não mostrar de novo" | P | 🟢 | |
| Faixa fixa **"Você está compartilhando"** com botão de parar sempre à vista | P | 🟢 | Hoje, depois de compartilhar, pode-se esquecer que está no ar. |
| Explicar por que o **áudio do sistema** pode gerar eco, no próprio lugar da opção | P | 🟢 | |
| Miniaturas ao vivo na hora de escolher qual tela parar (já feito) — estender à escolha de **qual tela ampliar** | P | 🟢 | |

### 11.5 Chat e arquivos

| Ideia | Esforço | Vercel | Observação |
|---|---|---|---|
| **Arrastar e soltar** arquivos sobre a janela inteira, com indicação "solte para enviar" | P | 🟢 | |
| **Barra de progresso** e botão cancelar no envio e no recebimento de arquivos | M | 🟢 | O envio é P2P e já tem controle de fluxo. |
| Dizer **para quem** o arquivo vai e que só quem está na sala agora recebe | P | 🟢 | Hoje isso não está explícito para quem usa. |
| Rolar o chat para a última mensagem, **sem pular** se a pessoa está lendo as antigas (botão "↓ novas mensagens") | P | 🟢 | |
| Mostrar a **hora** de cada mensagem ao passar o mouse | P | 🟢 | |
| Enter envia, Shift+Enter quebra linha — explicado no campo | P | 🟢 | |

### 11.6 Configurações

| Ideia | Esforço | Vercel | Observação |
|---|---|---|---|
| **Busca** dentro das Configurações, ou abas (Áudio · Vídeo · Transmissão · Sala · Sons) | M | 🟢 | O diálogo já rola; com a seção Sala ele ficou maior. |
| Botão **"Testar"** ao lado de cada dispositivo (tocar um som, mostrar o vídeo) | M | 🟢 | |
| Resumo em linguagem simples ao lado dos números de bitrate/fps ("Boa para reuniões; usa pouca internet") | P | 🟢 | Os limites de transmissão são técnicos demais para a maioria. |
| **Perfis prontos**: "Economizar internet", "Melhor qualidade", "Só áudio" | M | 🟢 | Um clique em vez de mexer em vários campos. |
| Desfazer: toast "Configuração alterada — Desfazer" | P | 🟢 | |

### 11.7 Celular e telas pequenas

| Ideia | Esforço | Vercel | Observação |
|---|---|---|---|
| Barra de controles **embaixo e maior**, alcançável com o polegar | M | 🟢 | |
| **Gestos**: deslizar para abrir o chat, pressão longa no tile para o menu | M | 🟢 | |
| Esconder os controles sozinhos depois de alguns segundos, e voltar ao tocar | P | 🟢 | |
| Avisar que **compartilhar tela quase não funciona** no celular, em vez de deixar o botão falhar | P | 🟢 | |
| Evitar que a tela **apague** durante a chamada (`Screen Wake Lock`) | P | 🟢 | |

### 11.8 Quando algo dá errado

| Ideia | Esforço | Vercel | Observação |
|---|---|---|---|
| **Tela de diagnóstico** ("Por que não vejo/ouço fulano?") com passos: microfone permitido? dispositivo certo? conexão P2P? | M | 🟢 | Reaproveita o estado de cada par que o app já mostra ("Conectado", "Reconectando"). |
| **Reconexão visível**: faixa "Reconectando… (tentativa 2)" em vez de só o tile ficar parado | P | 🟢 | |
| Botão **"Reiniciar minha conexão"** (hoje o reinício é global e afeta todos) | M | 🟢 | Uma opção só para mim, sem mexer na sala inteira. |
| Mensagens de permissão negada com **instruções por navegador** ("clique no cadeado ao lado do endereço…") | P | 🟢 | |
| Se a aba perder o foco ou o computador dormir, **recuperar sozinho** ao voltar | M | 🟢 | |

### 11.9 Acessibilidade e conforto

| Ideia | Esforço | Vercel | Observação |
|---|---|---|---|
| **Foco visível** em todos os controles e ordem de tabulação revisada | P | 🟢 | |
| Respeitar `prefers-reduced-motion` (menos animação) e `prefers-color-scheme` | P | 🟢 | |
| Contraste revisado nas cores de aviso e nos estados desligados | P | 🟢 | |
| **Tamanho de texto** ajustável no chat | P | 🟢 | |
| Anúncios para leitor de tela quando alguém entra, sai ou liga a senha | P | 🟢 | Já há `aria-live` em alguns pontos; falta uma passada completa. |
| Legendas ao vivo (já na seção 3), pensadas como recurso de acessibilidade | M | 🟢 | |

### 11.10 Pequenos detalhes que fazem diferença

- Título da aba com o nome da sala e, quando alguém escreve no chat, um marcador (por exemplo, `(2) Sala azul`).
- Confirmação antes de **sair** quando se está compartilhando a tela ou sendo o único anfitrião com senha ativa.
- Ao fechar a aba sem querer, aviso do navegador (`beforeunload`) só durante a chamada.
- Som de entrada/saída com volume próprio e opção "só quando a janela não está em foco".
- Primeira entrada de quem chega por link: mostrar **quem já está na sala** (prévia atual) com o campo do nome já em foco.
- Texto "Você é o anfitrião" discreto para quem tem o posto, com o que isso permite (senha), para não parecer um recurso escondido.
- Avisar quando o anfitrião muda ("Beto agora controla a senha da sala").

---

## Por onde eu começaria

1. **Mongo real no CI** e rodar o contrato agora: barato e fecha o maior buraco de verificação.
2. **Teste de mídia antes de entrar** (resolve a dívida da tela de senha e melhora a primeira impressão).
3. **Quem está falando** e **mão levantada**: dão sensação de produto acabado com pouco custo de servidor.
4. **Trancar a sala** e **sala de espera**: completam o controle de acesso que a senha começou.
5. Da seção 11, as de maior ganho por esforço: **copiar link da sala**, **menu do tile por pressão longa e botão "⋯"** (hoje só existe clique direito), **aviso "você está no mudo"**, **faixa "você está compartilhando"** e **reconexão visível**. São quase todas esforço P.
6. Só depois, decidir sobre **SFU** e sinalização fora da Vercel, conforme o tamanho real das salas e a conta.
