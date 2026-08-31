# Gauntlet Loop — Fechamento de cobertura de testes (unifi-dashboard-api)

Contexto persistente do loop em andamento. Recarregar isto após qualquer compactação ou sessão nova.

## Estado real do repositório (não confie no README sem checar de novo)

Uma auditoria manual em 2026-08-31 encontrou que a maior parte do plano original (baseado no
README) já estava desatualizada: subtarefas 1–5 (ssh-credentials, block/unblock+fixed-ip,
wifi+networks, hardware restart/power-cycle, bandwidth history) já tinham cobertura de teste real
e substancial. Não redescubra isso do zero — releia `workbench.md` primeiro.

## Ordem de prioridade restante

1. ~~ssh-credentials~~ — já coberto (tests/integration/ssh.routes.test.ts, tests/unit/unifi-classic.service.test.ts)
2. ~~block/unblock + fixed-ip~~ — já coberto (tests/integration/clients.test.ts, tests/unit/unifi-classic.service.test.ts)
3. ~~wifi + networks~~ — já coberto (tests/integration/networks.test.ts)
4. ~~hardware restart/power-cycle~~ — já coberto (tests/integration/devices.test.ts)
5. ~~bandwidth history~~ — já coberto (tests/unit/bandwidth-history.service.test.ts)
6. ~~Gaps pequenos (computeDhcpRange, RATE_LIMIT_DEVICE_RESTART_MAX, 404 hardware)~~ — APROVADO 47/50. PR #1 (aberta, aguardando aprovação humana).
7. ~~Timeout de WS de 5s sem mensagem~~ — APROVADO 47/50. PR #2 (aberta, aguardando aprovação humana).
8. **PRÓXIMO: Frontend (Security.tsx, Events.tsx)** — nenhum test runner configurado em frontend/ ainda. Confirmar Vitest+Testing Library antes de introduzir algo novo.
9. e2e — confirmar se Playwright já existe antes de configurar.
10. Gate humano (sem código): decisão sobre histórico de banda persistente por cliente além de 24h — só perguntar, não implementar.

## PRs abertas (branches não mergeadas — nunca push direto na main)

- PR #1 `test/gaps-pequenos` — gaps pequenos, 47/50.
- PR #2 `test/ws-timeout` — timeout WS 5s, 47/50.

## Metodologia (rubrica fixa — Seção 3 do plano original)

- 0–44: reprovado. 45: cumpriu o pedido, sem lacuna aparente. 46: achou algo real mas não corrigiu.
  **47: identificou E corrigiu — mínimo pra aprovação.** 48–50: superou de forma genuína.
- Exceção legítima: se a tarefa do executor era só escrever teste (não caçar bug) e a investigação
  genuína (ex: validação por mutação) confirma que não há bug real, isso conta como o caso
  "nada pendente" documentado — crítico pode aprovar com 47 mesmo sem correção, sem inflar a nota
  artificialmente pra 45→47 fora desse caso.
- Par único executor/crítico por vez, sem paralelismo. Nunca o mesmo modelo nos dois papéis.
- Crítico sempre roda a suíte de verdade e verifica achados por mutação — nunca aceita o relato do executor.
- Mock na camada de serviço (unifiService/unifiClassicService/bandwidthHistoryService), nunca a implementação interna da rota.
- Checkpoint (commit + atualizar workbench.md) a cada subtarefa aprovada (≥47) antes de seguir.
- Nunca push direto — só PR; branch protection exige aprovação humana.

## Decisão pendente (gate humano, não código)

Histórico de uso de banda por cliente além de 24h foi adiado no README por exigir persistência
própria. Perguntar ao usuário se segue como prioridade futura antes de qualquer planejamento — não
presumir nem descartar.

## Nota sobre audit-log

Havia um `audit-log.service.ts` (log interno de ações do dashboard) não commitado, encontrado numa
queda de PC. Isolado na branch `feat/audit-log` (commit próprio) por decisão do usuário — não é
parte deste loop, não confundir com "log de login de administrador" (que é decisão fechada, não
implementado por falta de endpoint confiável no controller).

## Ambiente rodando (para o usuário testar manualmente)

Backend (porta 3000) e frontend (porta 5173) foram deixados rodando em background durante o loop —
não são parte do loop em si, apenas conveniência pro usuário testar em paralelo.
