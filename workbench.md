# Workbench — Gauntlet Loop de cobertura de testes

## Onda 1 — CONCLUÍDA (2026-08-31)

### Auditoria inicial
Antes de iniciar qualquer par executor/crítico, auditei manualmente o repositório contra o plano
baseado no README. Achado: subtarefas 1–5 do plano (ssh-credentials, block/unblock+fixed-ip,
wifi+networks, hardware, bandwidth history) já tinham suítes de teste reais e não-superficiais,
cobrindo os casos de sucesso, 503/401, e os comportamentos documentados no README. O README estava
desatualizado. Decisão do usuário: fechar 3 gaps pequenos e genuínos antes de pular para o que
falta de verdade (timeout WS, frontend, e2e).

### Subtarefa 1: gaps pequenos (computeDhcpRange, RATE_LIMIT_DEVICE_RESTART_MAX, 404 hardware)
- **Status:** ✅ Aprovado — **47/50** — PR #1, mergeada
- **Executor:** Sonnet 5 · **Crítico:** Opus
- **Achado real (identificado E corrigido):** bug genuíno no `computeDhcpRange` — no colapso de
  sub-rede pequena (ex: `/30`), `start`/`stop` ficavam iguais, o que impedia a guarda "evita IP do
  próprio host" de disparar. Resultado: `computeDhcpRange('10.30.0.1', 30)` retornava
  `{start:'10.30.0.1', stop:'10.30.0.1'}` — pool de DHCP igual ao IP do gateway. Corrigido
  comparando com `broadcast` em vez de `stop`. Verificado matematicamente e por mutação.
- **Achado adicional do crítico:** rate limit de `power-cycle` (mesma env var de `restart`) tinha
  ficado sem teste — corrigido pelo crítico, validado por mutação.

### Subtarefa 2: timeout de WS de 5s sem mensagem
- **Status:** ✅ Aprovado — **47/50** — PR #2, mergeada
- **Executor:** Opus · **Crítico:** Sonnet
- **Caso "nada pendente" (exceção legítima da Seção 3):** não havia bug no plugin — a tarefa era
  só escrever o teste. Validado por mutação (neutralizando `socket.close(1008,...)` no plugin, o
  teste falha deterministicamente). Nota formal do crítico foi 45, tratado como 47 pela exceção.
- **Técnica:** `vi.useFakeTimers({shouldAdvanceTime:true, toFake:['setTimeout','clearTimeout']})`
  ativado ANTES de conectar (o setTimeout de auth nasce no momento da conexão) +
  `advanceTimersByTimeAsync(5000)`.

### Subtarefa 3: frontend — Vitest/Testing Library + Security.tsx + Events.tsx
- **Status:** ✅ Aprovado — **47/50** — PR #3, mergeada
- **Executor:** Sonnet 5 · **Crítico:** Opus
- **Achado real (identificado E corrigido pelo crítico):** bug de **crash em produção** em
  Events.tsx — `summarize()` não checava o tipo do valor de `meta.message`/`key`/`type`; payload
  trazendo objeto/array derrubava a página inteira de eventos. `Security.tsx` já fazia a checagem
  certa em `summarizeEvent` — corrigido alinhando ao mesmo padrão.
- **Achado adicional:** `vitest.config.ts` do frontend fora de qualquer tsconfig — incluído em
  `tsconfig.node.json`.

### Subtarefa 4: e2e (Playwright) — 3 fluxos reais
- **Status:** ✅ Aprovado — **47/50** — PR #4, mergeada
- **Executor:** Opus · **Crítico:** Sonnet
- **Escopo:** login→bloquear/desbloquear cliente, login→rotacionar SSH→segredo some ao navegar,
  criar→remover rede Wi-Fi. Cliques reais de UI contra backend+frontend reais.
- **Decisão de arquitetura (antes de disparar o par):** e2e NUNCA pode tocar um controller UniFi
  real — construído um controller fake local (HTTPS, certificado autoassinado em memória).
- **Verificação de segurança do crítico:** com o `.env` real do usuário apontando pra um IP de
  controller válido (172.16.0.1), confirmou que é IMPOSSÍVEL a suíte alcançar esse host.
- **Achado real (identificado E corrigido durante a revisão pré-merge, eu):** a suíte raiz do
  Vitest não excluía `frontend/**` — rodar `vitest` na raiz varria os testes React em ambiente
  `node` sem jsdom, quebrando 14 testes. Só não quebrava antes porque o frontend não tinha testes
  ainda (apareceu ao sincronizar PR #3 com master). Corrigido em `vitest.config.ts` na branch da
  PR #3; ao sincronizar a PR #4 (e2e) com master depois, o mesmo arquivo teve conflito de merge
  real (cada branch excluindo um diretório diferente) — resolvido unindo as duas exclusões
  (`frontend/**` e `e2e/**`).

## Onda 1 — fechamento

Todas as 4 PRs revisadas manualmente pelo usuário nesta conversa (resumo do diff de cada uma) e
mergeadas em `master` via squash, em ordem, com sincronização/merge de master a cada uma (as PRs
foram criadas em sequência a partir de branches desatualizadas entre si — CLAUDE.md/workbench.md
geraram conflitos "add/add" esperados em toda sincronização, resolvidos mantendo a versão mais
recente).

**Estado final verificado por mim, na `master`, depois das 4 PRs mergeadas:**
- Backend: `npx vitest run` → 21 arquivos / 153 testes. `npx tsc --noEmit` → limpo.
- Frontend: `npm run test` → 3 arquivos / 14 testes. `npx tsc -b --force` → limpo.
- e2e: `npm run test:e2e` → 3/3 fluxos passando (~12s).

**Achados reais corrigidos ao longo da onda (6 no total):**
1. Bug de cálculo de DHCP range (`computeDhcpRange`) — colidia com o IP do gateway em sub-redes pequenas.
2. Gap de rate limit não testado em `power-cycle` de porta.
3. Bug de crash em produção no frontend (`Events.tsx`) com payload de schema inesperado.
4. `vitest.config.ts` do frontend fora de qualquer tsconfig (typecheck não cobria).
5. Suíte raiz do Vitest sem excluir `frontend/**` (varria testes React em ambiente errado).
6. Conflito de merge real em `vitest.config.ts` entre as exclusões de `frontend/**` e `e2e/**`
   (resolvido unindo as duas, não uma decisão de design nova).

## Gate humano (decisão, não código) — respondido em 2026-08-31

Pergunta feita ao usuário: histórico de uso de banda por cliente além de 24h (adiado no README por
exigir persistência própria) continua como prioridade futura? **Resposta: sim, vira prioridade
para a próxima etapa.** Não implementado neste loop — registrado em memória do projeto para
retomar depois (`project_bandwidth_history_persistence.md`).

## Pendente

- [ ] Planejamento da persistência de histórico de banda (próxima etapa, fora deste loop)

## Nota lateral (fora de escopo, backlog)

Crítico da subtarefa 1 observou que para uma `/29`, `computeDhcpRange` colapsa para um pool de 1
endereço mesmo havendo 6 endereços utilizáveis. Comportamento pré-existente, não uma regressão —
candidato a melhoria futura.
