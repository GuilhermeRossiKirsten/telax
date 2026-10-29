# Telas e dispositivos — plano

> Execução inline (as tarefas editam os mesmos arquivos: `RoomView`, `ControlBar`, `VideoTile`, `globals.css`), com um revisor independente no fim. Spec: `docs/superpowers/specs/2026-10-28-telas-e-dispositivos-design.md`.

**Stack:** Next 16 / React 19 / TS, Vitest, Playwright. Tests-first em tudo.

## Review Focus
- Ocultar/silenciar/maximizar não pode parar o áudio dos outros tiles nem remontar a conexão.
- Participante que sai com tile oculto/maximizado/silenciado não deixa estado órfão (tela maximizada vazia).
- Trocar de microfone com o microfone mutado não pode "desmutar" sem querer.
- `setSinkId` ausente ou que falha (dispositivo removido) não pode quebrar a sala.
- Lista de dispositivos vazia/sem rótulos.

## Tarefa 1 — `src/lib/view-state.ts` (lógica pura) + testes
Produz: `Tile`, `ViewState`, `buildTiles(participants)`, `initialView`, `viewReducer(state, action)`, `orderTiles`, `primaryTile`.
Testes: ordem/novos tiles, remoção de órfãos, tela remota entra oculta e a própria não, mover, ocultar, silenciar, maximizar (e some ao sair), layout/colunas, `auto` com tela visível.

## Tarefa 2 — grade com controles e maximizar
`use-view-state.ts` (reducer + persistência), `VideoGrid.tsx` (layouts, faixa "Ocultas", maximizado), `VideoTile.tsx` (botões, `muted`, clique), CSS. E2E: ocultar/mostrar, silenciar, maximizar+Esc, tela remota oculta por padrão.

## Tarefa 3 — aba "Telas" no painel
`SidePanel.tsx` (aba, layout, colunas, subir/descer, mostrar/ocultar, silenciar). E2E: reordenar muda a ordem no DOM; colunas.

## Tarefa 4 — configurações de dispositivos
`lib/devices.ts`, `use-devices.ts`, `SettingsDialog.tsx`, `ControlBar` (botão), `use-local-media.ts` (`selectMic`), `VideoTile` (`setSinkId`). Testes unitários da parte pura; E2E: trocar microfone mantém mutado e a chamada segue.

## Tarefa 5 — verificação final
tsc, vitest, e2e, mesh, prints, README, ledger, revisor independente.
