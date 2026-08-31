# Gauntlet Loop — Fechamento de cobertura de testes (unifi-dashboard-api)

## Estado: onda 1 CONCLUÍDA — 4 PRs revisadas e mergeadas em 2026-08-31

Todas as 4 subtarefas de código do Gauntlet Loop foram aprovadas (47/50 cada), revisadas
manualmente pelo usuário nesta conversa e mergeadas em `master` (squash). Suíte final verificada
pós-merge: backend 153/153 testes, frontend 14/14, e2e 3/3, `tsc` limpo em ambos os projetos. Ver
`workbench.md` para os detalhes de cada subtarefa e achados.

## PRs mergeadas (histórico)

- PR #1 `test/gaps-pequenos` — computeDhcpRange, rate limit hardware, erros 404
- PR #2 `test/ws-timeout` — timeout WS 5s
- PR #3 `test/frontend-security-events` — Vitest+Testing Library, Security.tsx, Events.tsx (+ fix de crash)
- PR #4 `e2e/network-flows` — Playwright + controller UniFi fake, 3 fluxos reais

Achado extra durante o merge das PRs (fora do Gauntlet Loop original): a suíte raiz do Vitest não
excluía `frontend/**`, então rodar `vitest` na raiz varria os testes React em ambiente `node` sem
jsdom — só não quebrava antes porque o frontend não tinha testes ainda. Corrigido em
`vitest.config.ts` (exclude `frontend/**` e `e2e/**`).

## Se retomar este loop numa sessão futura

A onda 1 está fechada. O que resta é o gate humano já respondido (ver abaixo) — planejar (não
implementar sem planejamento) a persistência de histórico de banda por cliente além de 24h. Não
há mais subtarefas de teste pendentes desta onda.

## Decisão do gate humano (respondida em 2026-08-31)

Histórico de uso de banda por cliente além de 24h: usuário confirmou que **vira prioridade para a
próxima etapa**. Não implementar sem planejamento explícito antes (escolha de banco, job
periódico, retenção). Registrado em memória do projeto
(`project_bandwidth_history_persistence.md`).

## Metodologia (rubrica fixa — Seção 3 do plano original, pra referência se o loop continuar)

- 0–44: reprovado. 45: cumpriu o pedido, sem lacuna. 46: achou algo real mas não corrigiu.
  **47: identificou E corrigiu — mínimo pra aprovação.** 48–50: superou de forma genuína.
- Exceção legítima: tarefa que era só escrever teste (não caçar bug), com investigação genuína
  documentada (ex: validação por mutação) confirmando que não há bug — conta como "nada pendente",
  aprovável em 47 mesmo sem correção.
- Par único executor/crítico por vez, sem paralelismo. Nunca o mesmo modelo nos dois papéis.
- Crítico sempre roda a suíte de verdade e verifica achados por mutação.
- Mock na camada de serviço, nunca a implementação interna da rota.
- Checkpoint (commit + PR + atualizar workbench.md) a cada subtarefa aprovada, antes de seguir.
- Nunca push direto de código funcional — só PR; documentação de fechamento de onda já mergeada
  pode ser commit direto, com aprovação explícita do usuário na conversa.

## Nota sobre audit-log

Havia um `audit-log.service.ts` (log interno de ações do dashboard) não commitado, encontrado numa
queda de PC no início da sessão de 2026-08-31. Isolado na branch `feat/audit-log` (commit próprio)
por decisão do usuário — não é parte deste loop, não confundir com "log de login de
administrador" (decisão fechada, não implementado por falta de endpoint confiável no controller).
