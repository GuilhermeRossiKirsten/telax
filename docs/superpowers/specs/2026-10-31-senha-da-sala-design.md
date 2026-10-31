# Senha da sala — design e contrato

Pedido: sistema de senha na sala, que pode ser **habilitado ou desabilitado dentro da sala**. Integra com o **preview da tela inicial** (a tela inicial passa a saber que a sala é protegida e pede a senha).

## 0. Decisões

| Tema | Decisão |
|---|---|
| **Quem liga/desliga** | O **anfitrião**: a pessoa mais antiga ainda na sala (menor `joinedAt` entre os participantes vivos, sem observadores; desempate pelo menor `peerId`). Quando ela sai, o título passa à seguinte. Evita que qualquer participante tranque os outros para fora. O servidor decide (o cliente só mostra o controle). |
| **O que a senha protege** | Só **novas entradas**. Quem já está na sala não é expulso ao ligar, trocar ou remover a senha. |
| **Armazenamento** | Nunca em texto: **scrypt** (assíncrono, salt aleatório de 16 bytes, chave de 64 bytes) + `timingSafeEqual`. A senha nunca é registrada em log, devolvida nem guardada em evento. |
| **Duração** | O registro de senha **sobrevive à sala ficar vazia** (senão recarregar a página do único participante abriria a sala): expira **24 h** depois do último uso (definir ou entrar com sucesso). Mongo: coleção `room_passwords` com TTL; memória: `Map` com o relógio injetado. |
| **Força bruta** | Limite por **(sala, IP)**: 5 senhas erradas em 10 min trancam a tentativa por 5 min (`429` com `Retry-After`). Limite por sala: 50 erros em 10 min trancam todos por 1 min. Os contadores ficam no armazenamento compartilhado (várias instâncias). Acertar zera o contador do IP. |
| **Admin** | O observador do admin **ignora** a senha. A lista de salas do admin ganha `passwordProtected: boolean` (só o estado; o admin nunca vê a senha). |
| **Reentrada** | O cliente guarda a senha digitada em `sessionStorage` (`telax:room-pw:<sala>`, some ao fechar a aba) para recarregar a página e reentrar após um `410` sem pedir de novo. |
| **Limites de senha** | 4 a 64 caracteres, sem normalização (espaços valem). |

## 1. HTTP

- `POST /api/rooms/:room/join` aceita `password?: string`. Sala protegida e sem senha → `403 {error:'password_required'}`; senha errada → `403 {error:'wrong_password'}`; trancado → `429 {error:'too_many_attempts', retryAfter: <segundos>}` + cabeçalho `Retry-After`. Sucesso devolve também `protected: boolean`. Observador (sessão de admin) ignora a senha.
- `POST /api/rooms/:room/password` (via `postRoute` com `idField: 'peerId'`, autenticado por token): corpo `{ peerId, token, action: 'set' | 'clear', password?: string }`. Quem não é anfitrião → `403 {error:'not_host'}`. `set` sem senha válida (4..64) → `400 {error:'invalid'}`. Sucesso `200 { protected: boolean }`. Emite o evento `room` (abaixo).
- `GET /api/rooms/:room/preview` passa a devolver `{ count, closed, protected }`: `protected` = existe registro de senha **vivo** para a sala.
- Evento `type: 'room'`, `from: <peerId do anfitrião>`, payload `{ protected: boolean }`, para **todos** os não observadores. É evento de controle (não sai antes de sinais).
- `PeerInfo` e a resposta de `join` não trazem hash nem salt; só `protected`.

## 2. Armazenamento (`RoomStore`)

Novos métodos (Memory e Mongo, com contrato nos dois):
```ts
getRoomPassword(room): Awaitable<PasswordRecord | null>;          // registro vivo (TTL aplicado na leitura)
setRoomPassword(room, peerId, record: PasswordRecord | null): Awaitable<'ok' | 'not_host' | 'unknown_peer'>; // checa anfitrião; null = remover; emite o evento room
isRoomHost(room, peerId): Awaitable<boolean>;
passwordThrottle(room, key): Awaitable<{ locked: boolean; retryAfterMs: number }>;       // consulta sem contar
passwordFailed(room, key): Awaitable<{ locked: boolean; retryAfterMs: number }>;          // conta um erro (por chave e por sala)
passwordSucceeded(room, key): Awaitable<void>;                                           // zera o contador da chave e renova o TTL do registro
```
`PasswordRecord = { salt: string; hash: string; params: { N: number; r: number; p: number; keylen: number } }` (base64). Hash e verificação num módulo novo `src/server/room-password.ts` (`hashPassword`, `verifyPassword`, validação de comprimento), testável sem rede.

## 3. Cliente

- `signaling-client`: `join` envia `password` quando houver (do estado em memória ou `sessionStorage`); trata `password_required`, `wrong_password` e `too_many_attempts` (+ `retryAfter`) como status terminais `'locked'` com motivo, sem reentrar em laço; `joinResult.protected`.
- `useRoom`: expõe `roomProtected: boolean` (inicia do join, atualiza com o evento `room`), `isHost: boolean` (menor `joinedAt` entre `participants`, sem observadores) e `setRoomPassword(action, password?) → Promise<{ok:true}|{ok:false; error}>`.
- **Tela inicial (`JoinForm`)**: o preview diz que a sala existe e se é protegida; quando protegida (ou quando o servidor responde `password_required`) aparece o campo **"Senha da sala"** (`type="password"`); erros: "Senha incorreta.", "Muitas tentativas. Tente novamente em N s.". O nome da sala e do usuário continuam como hoje.
- **Dentro da sala**: Configurações → seção **Sala**. Anfitrião: caixa "Proteger esta sala com senha"; ligando aparece "Senha da sala" (mín. 4) e "Ativar senha"; ativo mostra "A sala está protegida por senha" com "Alterar senha" e "Remover senha". Não anfitrião: texto "Esta sala está protegida por senha. Só a pessoa mais antiga na sala pode alterar." (ou "Sem senha." quando não há). Aviso curto na sala (banner) quando a senha muda: "A sala agora tem senha" / "A senha da sala foi removida".

## 4. Testes obrigatórios

Unitários: `room-password` (hash diferente a cada vez, verificação certa/errada, tempo constante via `timingSafeEqual`, limites 4..64); contrato dos stores (anfitrião = mais antigo e passa ao seguinte; só o anfitrião define/remove; senha sobrevive à sala vazia e expira em 24 h; throttle por IP e por sala, desbloqueio com o tempo, zera ao acertar; evento `room` só a não observadores; observador ignora; nada de hash/salt em participantes nem eventos); rotas (`join` 403/429/200, `password` 403/400/200, `preview.protected`); cliente (join com senha, erros, `sessionStorage`). E2E: sala protegida pede senha na tela inicial; senha errada não entra; certa entra; quem já estava dentro continua ao ligar a senha; só o anfitrião vê os controles; remover libera; recarregar a página do anfitrião reentra sem pedir; 6 erros seguidos trancam (429); preview mostra "protegida por senha"; admin observador entra sem senha.
