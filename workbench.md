# Workbench — Gauntlet Loop de cobertura de testes

## Onda 1

### Auditoria inicial (2026-08-31)
Antes de iniciar qualquer par executor/crítico, auditei manualmente o repositório contra o plano
baseado no README. Achado: subtarefas 1–5 do plano (ssh-credentials, block/unblock+fixed-ip,
wifi+networks, hardware, bandwidth history) já tinham suítes de teste reais e não-superficiais,
cobrindo os casos de sucesso, 503/401, e os comportamentos documentados no README. O README estava
desatualizado. Decisão do usuário: fechar 3 gaps pequenos e genuínos antes de pular para o que
falta de verdade (timeout WS, frontend, e2e).

### Subtarefa: gaps pequenos (computeDhcpRange, RATE_LIMIT_DEVICE_RESTART_MAX, 404 hardware)
- **Status:** ✅ Aprovado — **47/50**
- **Executor:** Sonnet 5
- **Crítico:** Opus (diversidade de modelo respeitada)
- **Escopo:**
  1. `computeDhcpRange` (src/routes/networks.routes.ts) sem teste unitário isolado do caso de
     colapso em sub-rede pequena.
  2. `RATE_LIMIT_DEVICE_RESTART_MAX` sem teste específico (só o padrão genérico via
     RATE_LIMIT_CLIENT_ACTION_MAX estava coberto).
  3. Erro 404 (device/porta inexistente) não coberto em tests/integration/devices.test.ts.
- **Achado real (nível 47 — identificado E corrigido):** bug genuíno no `computeDhcpRange` — no
  ramo de colapso de sub-rede pequena (ex: `/30`), `start` e `stop` ficavam iguais, o que fazia a
  guarda "evita que o range comece no IP do próprio host" nunca disparar (`start < stop` nunca
  verdadeiro quando são iguais). Resultado: `computeDhcpRange('10.30.0.1', 30)` retornava
  `{start: '10.30.0.1', stop: '10.30.0.1'}` — o pool de DHCP sendo exatamente o IP do gateway,
  colidindo com ele. Corrigido comparando com `broadcast` em vez de `stop`, avançando `stop`
  junto quando `start` é incrementado. Verificado matematicamente pelo crítico (cálculo manual
  pré/pós-fix) e por mutação (revertendo o fix, o teste novo falha).
- **Achado adicional do crítico (dentro do escopo, corrigido por ele):** o executor cobriu o rate
  limit de device restart só em `POST /devices/:id/restart`, deixando `POST
  /devices/:id/ports/:portIdx/power-cycle` (endpoint igualmente disruptivo, mesma env var) sem
  teste — uma troca acidental para `RATE_LIMIT_CLIENT_ACTION_MAX` (10x mais permissivo) nesse
  endpoint passaria despercebida. Crítico adicionou o segundo caso e validou por mutação.
- **Verificação independente (eu, antes do checkpoint):** `npx vitest run` → 152/152 testes, 21
  arquivos, verde. `npx tsc --noEmit` → limpo.
- **Cobertura antes/depois:** sem ferramenta de coverage instalada (`@vitest/coverage-v8` ausente
  — não instalado ainda, decisão de não introduzir dependência nova fora de escopo desta rodada).
  Medido por contagem de testes: 151 → 152 (+ os 4 novos testes unitários de computeDhcpRange, +2
  testes de rate limit de device/power-cycle, +2 testes de erro 404 — alguns substituindo
  cobertura indireta já existente).
- **Arquivos tocados:**
  - `src/routes/networks.routes.ts` (export + fix de `computeDhcpRange`)
  - `tests/unit/networks.routes.test.ts` (novo)
  - `tests/integration/rate-limit-device-restart.test.ts` (novo)
  - `tests/integration/devices.test.ts` (modificado)
- **PR:** pendente de criação (branch `test/gaps-pequenos`).

## Pendente (próximas subtarefas, em ordem)

- [ ] Timeout de WS de 5s sem mensagem (fake timers)
- [ ] Frontend: configurar test runner + Security.tsx + Events.tsx
- [ ] e2e (Playwright — confirmar se já existe)
- [ ] Gate humano: decisão sobre histórico de banda persistente por cliente (só pergunta, sem código)

## Nota lateral (fora de escopo, backlog)

Crítico observou que para uma `/29`, `computeDhcpRange` colapsa para um pool de 1 endereço mesmo
havendo 6 endereços utilizáveis (`network+10 > broadcast-1` já dispara aí). Comportamento
pré-existente, não uma regressão desta rodada — candidato a melhoria futura, não uma correção
deste loop.
