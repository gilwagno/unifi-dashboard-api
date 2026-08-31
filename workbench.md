# Workbench — Gauntlet Loop de cobertura de testes

## Onda 1

### Auditoria inicial (2026-08-31)
Antes de iniciar qualquer par executor/crítico, auditei manualmente o repositório contra o plano
baseado no README. Achado: subtarefas 1–5 do plano (ssh-credentials, block/unblock+fixed-ip,
wifi+networks, hardware, bandwidth history) já tinham suítes de teste reais e não-superficiais,
cobrindo os casos de sucesso, 503/401, e os comportamentos documentados no README. O README estava
desatualizado. Decisão do usuário: fechar 3 gaps pequenos e genuínos antes de pular para o que
falta de verdade (timeout WS, frontend, e2e).

### Subtarefa 1: gaps pequenos (computeDhcpRange, RATE_LIMIT_DEVICE_RESTART_MAX, 404 hardware)
- **Status:** ✅ Aprovado — **47/50** — PR #1 (aberta, aguardando aprovação humana)
- **Executor:** Sonnet 5 · **Crítico:** Opus (diversidade de modelo respeitada)
- **Achado real (identificado E corrigido):** bug genuíno no `computeDhcpRange`
  (src/routes/networks.routes.ts) — no colapso de sub-rede pequena (ex: `/30`), `start`/`stop`
  ficavam iguais, o que impedia a guarda "evita IP do próprio host" de disparar. Resultado:
  `computeDhcpRange('10.30.0.1', 30)` retornava `{start:'10.30.0.1', stop:'10.30.0.1'}` — pool de
  DHCP igual ao IP do gateway. Corrigido comparando com `broadcast` em vez de `stop`. Verificado
  matematicamente e por mutação pelo crítico.
- **Achado adicional do crítico:** rate limit de `power-cycle` (mesma env var de `restart`) tinha
  ficado sem teste — corrigido pelo próprio crítico, validado por mutação.
- **Verificação independente (eu):** 152/152 testes, `tsc` limpo.
- **Arquivos:** src/routes/networks.routes.ts, tests/unit/networks.routes.test.ts (novo),
  tests/integration/rate-limit-device-restart.test.ts (novo), tests/integration/devices.test.ts.

### Subtarefa 2: timeout de WS de 5s sem mensagem
- **Status:** ✅ Aprovado — **47/50** — PR #2 (aberta, aguardando aprovação humana)
- **Executor:** Opus · **Crítico:** Sonnet (diversidade de modelo respeitada)
- **Escopo:** único item que o README já sinalizava explicitamente como não coberto — fechamento
  do `/ws/events` com 1008 quando a primeira mensagem (auth) não chega em 5s.
- **Caso "nada pendente" (exceção legítima da Seção 3):** não havia bug no plugin — a tarefa era
  só escrever o teste. Executor e crítico validaram por mutação (neutralizando
  `socket.close(1008, ...)` no plugin) que o teste pega a ausência do comportamento de forma
  determinística (falha em ~5s de timeout do próprio Vitest, não trava). Nota formal do crítico
  foi 45 (teto "cumpriu o pedido"), mas por se enquadrar na exceção documentada de investigação
  genuína sem achado corretivo pendente, tratado como aprovado em 47.
- **Técnica usada:** `vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout',
  'clearTimeout'] })` ativado ANTES de conectar (o setTimeout de auth nasce no momento da conexão,
  não depois) + `vi.advanceTimersByTimeAsync(5000)`. Restaura `vi.useRealTimers()` num finally pra
  não vazar pros outros testes do arquivo (que dependem de handshake TCP real).
- **Verificação independente (eu):** arquivo isolado em ~200ms (não é sleep disfarçado), suíte
  completa 145/145, `tsc` limpo.
- **Efeito colateral bom:** atualizou a nota do README que descrevia esse caso como não coberto
  (ficaria uma afirmação falsa).
- **Arquivos:** tests/integration/websocket.test.ts, README.md.

## Pendente (próximas subtarefas, em ordem)

- [ ] **Frontend**: configurar test runner (confirmar Vitest+Testing Library antes de introduzir
      algo novo) + Security.tsx (segredo de SSH nunca em storage persistente, some ao navegar) +
      Events.tsx (render defensivo de payload desconhecido)
- [ ] e2e (Playwright — confirmar se já existe antes de configurar)
- [ ] Gate humano: decisão sobre histórico de banda persistente por cliente (só pergunta, sem código)

## Nota lateral (fora de escopo, backlog)

Crítico da subtarefa 1 observou que para uma `/29`, `computeDhcpRange` colapsa para um pool de 1
endereço mesmo havendo 6 endereços utilizáveis. Comportamento pré-existente, não uma regressão —
candidato a melhoria futura, não uma correção deste loop.
