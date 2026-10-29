# Painel de administração — design e contrato

Pedido: tela de admin (login pelo GitHub, só o dono entra) para ver as salas, fechá-las, mandar mensagem à sala, expulsar pessoas, **banir por IP e MAC (se possível)**, **ver as câmeras e telas** ao abrir uma sala e **parar a transmissão** de uma pessoa. Depois: **todos os endpoints de admin e de controle devem ser protegidos; só o admin os usa.**

Tipos compartilhados: `src/lib/admin-types.ts` (já existe) e `PeerInfo.observer` / `RoomEventType 'admin'` em `src/lib/types.ts`.

## 0. Decisões e limites (leia antes)

| Tema | Decisão |
|---|---|
| **MAC address** | **Impossível**: navegadores não o expõem e o servidor só enxerga o MAC em rede local. O bloqueio usa **IP + identificador do dispositivo** (UUID em `localStorage`, `telax:device-id`). A tela de admin explica isso. Limites: IP compartilhado (NAT) bane inocentes; IP dinâmico/VPN e limpar o armazenamento contornam. |
| **Quem é o admin** | Só o usuário GitHub em `ADMIN_GITHUB_USER` (e, se definido, o id numérico `ADMIN_GITHUB_ID`). **Sem essas variáveis o admin fica desligado (falha fechada)**, nunca aberto. |
| **Ver câmeras e telas** | O admin entra como **observador**: um peer WebRTC que só recebe. Os participantes abrem uma conexão extra para ele (custo de envio de +1 fluxo). Para **transparência**, enquanto houver observador os participantes veem o aviso "Um administrador pode estar vendo as câmeras e telas desta sala". |
| **Parar a transmissão de alguém** | Comando `admin` ao cliente da pessoa (o app obedece). Um cliente adulterado pode ignorar: a garantia real é **expulsar/banir** (servidor). |
| **Fechar sala** | Remove todos e a sala fica **fechada** até o admin reabrir (persistente, sem o TTL de 1 h das salas). Entrar numa sala fechada dá `403 room_closed`. |

## 1. Regra de ouro: negar por padrão

- **Todo** handler de `src/app/api/admin/**` é criado por `adminRoute(...)` (único jeito de exportar `GET/POST/PUT/PATCH/DELETE` ali). Sem sessão válida → `401`; sessão de outro usuário → `403`; admin desligado (env faltando) → `503 {error:'admin_disabled'}`. Métodos mutantes exigem `Origin`/`Referer` do mesmo host (`403 bad_origin`).
- **Teste estrutural obrigatório:** um teste varre `src/app/api/admin/**/route.ts`, importa cada módulo e exige que TODO método exportado rejeite requisição sem sessão (401) e com sessão forjada/errada (401/403) — uma rota nova esquecida sem o filtro **quebra a suíte**. Outro teste lê o código-fonte e falha se algum `route.ts` ali exportar um handler que não venha de `adminRoute`.
- **Caminhos de controle fora de `/api/admin`:** (a) `POST /api/rooms/:sala/join` com `observer: true` exige sessão de admin (sem ela: `403 forbidden`, nenhuma entrada); (b) eventos `admin` e `from:'admin'` **só** são emitidos pelos métodos admin do store — `chat`, `state` e `signal` de clientes comuns nunca podem criar um evento `admin` (teste de contrato); (c) o corpo do `join` comum não aceita `ip`/`observer` vindos do cliente (o IP vem dos cabeçalhos).
- Token de GitHub **não é guardado** (só usado para ler o usuário). Sessão: cookie `telax_admin`, `HttpOnly`, `SameSite=Lax`, `Secure` em produção, `Path=/`, 12 h, valor `base64url(JSON{login,id,exp}).base64url(HMAC-SHA256(secret))`, comparação com `timingSafeEqual`.

## 2. Variáveis de ambiente

| Variável | Para quê |
|---|---|
| `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET` | OAuth App do GitHub (callback `https://SEU-DOMINIO/api/admin/auth/callback`; local `http://localhost:3000/api/admin/auth/callback`) |
| `ADMIN_GITHUB_USER` | login GitHub do admin (comparação sem diferenciar maiúsculas) |
| `ADMIN_GITHUB_ID` | opcional: id numérico do GitHub; se definido também precisa bater (o login pode mudar de dono) |
| `ADMIN_SESSION_SECRET` | segredo de ≥ 32 caracteres para assinar a sessão |
| `ADMIN_BASE_URL` | opcional: base pública para o `redirect_uri` (padrão: derivado de `x-forwarded-proto`/`host`) |

## 3. Rotas

### 3.1 Autenticação (única parte fora do `adminRoute`, por ser a que cria a sessão)
- `GET /api/admin/auth/login`: admin desligado → 503; gera `state` aleatório (cookie `telax_oauth_state`, HttpOnly, 10 min, `Path=/api/admin/auth`), `302` para `https://github.com/login/oauth/authorize?client_id&redirect_uri&state&scope=read:user&allow_signup=false`.
- `GET /api/admin/auth/callback?code&state`: confere `state` com o cookie (`timingSafeEqual`), troca o `code` por token (`POST https://github.com/login/oauth/access_token`, `Accept: application/json`), lê `GET https://api.github.com/user`, compara login (e id). OK → grava a sessão e `302 /admin`; qualquer falha → `302 /admin?error=forbidden|state|github` **sem sessão**. As chamadas ao GitHub usam um `fetch` injetável (testes sem rede).
- `POST /api/admin/auth/logout`: apaga o cookie (checa origem).
- `GET /api/admin/me` (via `adminRoute`): `{ login, id }`.

### 3.2 Admin (todas via `adminRoute`)
| Rota | Corpo | Resposta |
|---|---|---|
| `GET /api/admin/rooms` | — | `{ rooms: AdminRoomSummary[] }` (inclui salas fechadas) |
| `GET /api/admin/rooms/:room` | — | `AdminRoomDetail` (404 se não existe nem está fechada) |
| `POST /api/admin/rooms/:room/message` | `{ text }` (1..500) | `{ delivered: number }` |
| `POST /api/admin/rooms/:room/close` | `{ reason? }` | `{ removed: number }` |
| `POST /api/admin/rooms/:room/reopen` | — | `{ ok: true }` |
| `POST /api/admin/rooms/:room/kick` | `{ peerId, reason? }` | `{ ok: boolean }` |
| `POST /api/admin/rooms/:room/command` | `{ peerId, what, slot? }` (`AdminCommand`) | `{ ok: boolean }` |
| `POST /api/admin/broadcast` | `{ text }` | `{ delivered: number }` (todas as salas) |
| `GET /api/admin/bans` | — | `{ bans: Ban[] }` |
| `POST /api/admin/bans` | `{ room, peerId, reason? }` (bane o peer conectado: cria bans de `ip` e de `device`, expulsa-o e a quem casar) **ou** `{ ip?, deviceId?, reason? }` | `{ bans: Ban[], removed: number }` |
| `DELETE /api/admin/bans/:id` | — | `{ ok: boolean }` |

`:room` passa por `normalizeRoom`; `peerId` é UUID; `reason` até 200; textos validados (400 `invalid`).

### 3.3 Rotas públicas alteradas
- `POST /api/rooms/:sala/join`: o IP sai de `x-forwarded-for` (primeiro) → `x-real-ip` → `'unknown'`; corpo aceita `name`, `deviceId?` (UUID) e `observer?: true` (só com sessão de admin, senão `403 {error:'forbidden'}`). Erros: `403 {error:'banned'}`, `403 {error:'room_closed', reason?}`, `409 room_full` (só com `MAX_PEERS`).
- `410 gone` (`events`, `signal`, `chat`, `state`, `restart`, `leave`) passa a incluir `reason: 'kicked'|'banned'|'closed'` quando o peer foi removido pelo admin (**tombstone** por ~2 min); sem tombstone continua `{error:'gone'}`.

## 4. Armazenamento (`RoomStore`)

`join(room, name, ctx?: JoinContext)`. Ordem de verificação (não observador): **banido** (IP ou deviceId) → `BannedError`; **sala fechada** → `RoomClosedError(reason?)`; lotada → `RoomFullError`. Observadores pulam ban/fechada e **não contam** para `maxPeers`.

Peers guardam `ip`, `deviceId`, `observer` (nunca vão em `participants`/eventos para clientes comuns, exceto `observer: true` em `PeerInfo`, para os clientes abrirem a conexão).

Métodos de admin (Memory e Mongo; contrato de testes nos dois):
```ts
listRooms(): Awaitable<AdminRoomSummary[]>;
getRoom(room: string): Awaitable<AdminRoomDetail | null>;
kick(room: string, peerId: string, reason?: string): Awaitable<boolean>;      // remove + tombstone 'kicked'
closeRoom(room: string, reason?: string): Awaitable<number>;                   // remove todos (tombstone 'closed') + marca fechada
reopenRoom(room: string): Awaitable<boolean>;
broadcast(room: string | null, text: string): Awaitable<number>;               // evento admin 'message' (room null = todas)
command(room: string, peerId: string, cmd: AdminCommand): Awaitable<boolean>;  // evento admin 'command' com `to`
ban(entry: { ip?: string; deviceId?: string; reason?: string; bannedName?: string; room?: string }): Awaitable<{ bans: Ban[]; removed: number }>; // remove peers que casam (tombstone 'banned')
banPeer(room: string, peerId: string, reason?: string): Awaitable<{ bans: Ban[]; removed: number } | null>; // resolve ip/deviceId do peer, bane os dois
listBans(): Awaitable<Ban[]>;
unban(id: string): Awaitable<boolean>;
```
- Eventos admin: `type: 'admin'`, `from: 'admin'`, payload `AdminEventPayload`; `message` sem `to` (todos os não observadores), `command` com `to`. O log segue a política "sinais saem primeiro"; eventos `admin` são de controle (não saem antes de sinais).
- `UnknownPeerError` ganha `reason?: RemovalReason`: `authenticate`/`events`/`peekEvents` consultam o tombstone do peer removido e o devolvem.
- Mongo: coleções novas `admin_closed` (`_id` = sala), `admin_bans`, `admin_removed` (tombstones, TTL 300 s em `at`); `rooms` como hoje. Tudo atômico por operação, dados do usuário em `$literal`, ids validados. `store.ts` monta o conjunto de coleções.
- Memory: `Map`s equivalentes (tombstones expiram pelo relógio injetado).

## 5. Cliente

- `src/lib/device-id.ts`: `getDeviceId()` (UUID em `telax:device-id`, em try/catch; se falhar, UUID de sessão). Enviado em todo `join`.
- `signaling-client`: trata `403 banned|room_closed` no join (status `'blocked'` com motivo) e `410` com `reason` kicked/banned/closed (status `'removed'` com motivo e **nunca reentra**); join aceita `observer?: true`.
- `useRoom`: opção `observer?: boolean` (entra como observador, sem faixas locais, sem enviar mídia); `participants` e `peers` **excluem observadores** (sem tile/lista/som de entrada), e o hook expõe `observerPresent: boolean`; `remoteStreams` segue por peer (câmera + `screens[]`). Eventos `admin`: `message` → `adminMessage` (estado com `text`/`at`, dispensável); `command` → callback `onAdminCommand(cmd)`.
- `RoomView`: banner do aviso do admin ("Mensagem do administrador: …", fechável, com o som `join` baixo); aviso fixo de monitoramento quando `observerPresent`; telas finais "Você foi removido da sala pelo administrador" / "Seu acesso foi bloqueado" / "Esta sala foi encerrada pelo administrador" (com o motivo), soltando câmera/mic; `onAdminCommand` → `screens`/`screen(slot)` = parar tela(s), `camera` = desligar câmera, `mic` = mutar, `all` = tudo.

## 6. Tela de admin (`/admin`)

- Sem sessão: botão "Entrar com GitHub" (→ `/api/admin/auth/login`) e a mensagem do erro (`?error=`). Admin desligado: instruções das variáveis (sem revelar valores).
- Com sessão: cabeçalho com o login e "Sair"; abas **Salas**, **Bloqueios**.
  - **Salas**: lista (nome, pessoas, observadores, criada, última atividade, "fechada"), atualiza a cada 5 s (pausa com a aba oculta); "Mensagem global" para todas as salas; por sala: **Ver sala**, **Mensagem**, **Fechar** (com motivo), **Reabrir**.
  - **Ver sala**: tabela de participantes (nome, IP, dispositivo, entrada, mic/câmera/telas) e **visão ao vivo** (o admin entra como observador só enquanto a sala está aberta na tela; sair da tela sai da sala): um tile por pessoa com a câmera e as telas que ela transmite (áudio mudo, botão "Ouvir"), e por pessoa as ações **Expulsar**, **Banir (IP + dispositivo)**, **Parar telas**, **Parar câmera**, **Parar microfone**, todas com confirmação.
  - **Bloqueios**: lista (tipo, valor, motivo, data, nome) com "Remover bloqueio"; aviso sobre MAC/IP compartilhado.
- Visual do app (olive/lime), tudo em português, acessível (`role`, rótulos).

## 7. Testes obrigatórios

Unitários: assinatura/validação de sessão (adulterada, expirada, outro usuário, segredo errado); `adminRoute` (401/403/503/CSRF); callback do GitHub com `fetch` falso (usuário certo, errado, id errado, state errado, GitHub com erro); **varredura de todas as rotas admin** (seção 1); `join` com `observer` sem sessão (403); contrato dos stores (ban por ip/device, sala fechada persistente, tombstone, kick, broadcast só a não observadores, command dirigido, observador fora da contagem, `chat`/`state`/`signal` nunca geram evento `admin`).

E2E: sessões de teste são **assinadas pelo próprio teste** com o `ADMIN_SESSION_SECRET` do servidor de teste (nada de "modo de teste" no código de produção). Cobrem: `/admin` sem sessão pede login; API sem cookie dá 401; com cookie de outro usuário 403; lista de salas; ver sala com câmera ao vivo; mensagem chega aos participantes; expulsar tira a pessoa e ela vê o aviso e não reentra; banir bloqueia o `join` seguinte (mesmo IP/dispositivo); fechar sala; parar tela de uma pessoa; aviso de monitoramento aparece para os participantes.

## Ajuste pós-integração

- O `410 gone` com `reason` também leva `detail` (o texto livre que o admin digitou ao expulsar/banir, até 200 caracteres) **só quando há `reason`**: o texto é mostrado à pessoa removida ("Motivo: …"). O `403 banned` do `join` NÃO leva texto (não revela nada a quem tenta entrar). Isto não estava no contrato inicial; foi achado pelo e2e, porque a tela de admin prometia que o motivo "aparece para a pessoa".
