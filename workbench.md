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
- **Executor:** Sonnet 5 · **Crítico:** Opus
- **Achado real (identificado E corrigido):** bug genuíno no `computeDhcpRange` — no colapso de
  sub-rede pequena (ex: `/30`), `start`/`stop` ficavam iguais, o pool de DHCP calculado podia ser
  o próprio IP do gateway. Corrigido comparando com `broadcast` em vez de `stop`.
- **Achado adicional do crítico:** rate limit de `power-cycle` sem teste — corrigido pelo crítico.
- **Verificação independente (eu):** 152/152 testes, `tsc` limpo.

### Subtarefa 2: timeout de WS de 5s sem mensagem
- **Status:** ✅ Aprovado — **47/50** — PR #2 (aberta, aguardando aprovação humana)
- **Executor:** Opus · **Crítico:** Sonnet
- **Caso "nada pendente" (exceção legítima da Seção 3):** não havia bug no plugin, só faltava o
  teste. Validado por mutação (neutralizando `socket.close(1008,...)`, o teste falha
  deterministicamente). Nota formal do crítico foi 45, tratado como 47 pela exceção documentada.
- **Técnica:** `vi.useFakeTimers({shouldAdvanceTime:true, toFake:['setTimeout','clearTimeout']})`
  ativado ANTES de conectar + `advanceTimersByTimeAsync(5000)`.
- **Verificação independente (eu):** arquivo isolado ~200ms (não sleep disfarçado), 145/145, `tsc` limpo.

### Subtarefa 3: frontend — Vitest/Testing Library + Security.tsx + Events.tsx
- **Status:** ✅ Aprovado — **47/50** — PR #3 (aberta, aguardando aprovação humana)
- **Executor:** Sonnet 5 · **Crítico:** Opus
- **Achado real (identificado E corrigido pelo crítico):** bug de **crash em produção** em
  Events.tsx — `summarize()` não checava o tipo de `meta.message`/`key`/`type`; payload trazendo
  objeto/array derrubava a página inteira de eventos. `Security.tsx` já fazia a checagem certa em
  `summarizeEvent` — inconsistência corrigida alinhando ao mesmo padrão.
- **Achado adicional:** `vitest.config.ts` fora de qualquer tsconfig — incluído em `tsconfig.node.json`.
- **Verificação independente (eu):** 14/14 testes, `tsc -b --force` limpo.

### Subtarefa 4: e2e (Playwright) — 3 fluxos reais
- **Status:** ✅ Aprovado — **47/50** — PR #4 (aberta, aguardando aprovação humana)
- **Executor:** Opus · **Crítico:** Sonnet
- **Escopo:** login→bloquear/desbloquear cliente, login→rotacionar SSH→segredo some ao navegar,
  criar→remover rede Wi-Fi. Cliques reais de UI contra backend+frontend reais.
- **Decisão de arquitetura (minha, antes de disparar o par):** e2e NUNCA pode tocar um controller
  UniFi real — construído um controller fake local (HTTPS, certificado autoassinado em memória,
  estado em memória) que o backend real conversa com.
- **Verificação de segurança do crítico (rigorosa, dado o risco):** com o `.env` real do usuário
  apontando pra um IP de controller válido (172.16.0.1), rastreou a cadeia de spawn do Playwright
  + comportamento do dotenv e confirmou que é IMPOSSÍVEL a suíte alcançar esse host — as env vars
  do `webServer` do Playwright sempre vencem.
- **Achado documentado, não corrigido pelo crítico (fora do escopo estrito da crítica):** README
  não documentava a suíte e2e — corrigido por mim antes do checkpoint (nova seção "Testes
  end-to-end (Playwright)" no README).
- **Verificação independente (eu):** 3/3 fluxos e2e do zero (~9s), 144/144 testes de
  backend, `tsc` limpo (raiz e frontend), dev servers do usuário (3000/5173) confirmados intactos
  antes e depois.

## Onda 1 — resumo

Todas as 4 subtarefas de código planejadas aprovadas em 47/50. 4 PRs abertas, aguardando revisão e
aprovação humana (nunca mergeadas automaticamente — branch protection exige aprovação humana):
- PR #1 `test/gaps-pequenos`
- PR #2 `test/ws-timeout`
- PR #3 `test/frontend-security-events`
- PR #4 `e2e/network-flows`

Achados reais corrigidos ao longo da onda: 1 bug de cálculo de DHCP (computeDhcpRange), 1 gap de
rate limit não testado (power-cycle), 1 bug de crash em produção no frontend (Events.tsx).

## Gate humano (decisão, não código) — respondido em 2026-08-31

Pergunta feita ao usuário: histórico de uso de banda por cliente além de 24h (adiado no README por
exigir persistência própria) continua como prioridade futura? **Resposta: sim, vira prioridade
para a próxima etapa**, após esta onda ser mergeada. Não implementado neste loop — registrado em
memória do projeto para retomar depois.

## Pendente

- [ ] Aprovação humana + merge das 4 PRs (#1, #2, #3, #4)
- [ ] Planejamento da persistência de histórico de banda (próxima etapa, fora deste loop)

## Nota lateral (fora de escopo, backlog)

Crítico da subtarefa 1 observou que para uma `/29`, `computeDhcpRange` colapsa para um pool de 1
endereço mesmo havendo 6 endereços utilizáveis. Comportamento pré-existente, não uma regressão —
candidato a melhoria futura.
