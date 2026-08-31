# Gauntlet Loop — Fechamento de cobertura de testes (unifi-dashboard-api)

## Estado: onda 1 concluída, aguardando aprovação humana das PRs

Todas as 4 subtarefas de código do Gauntlet Loop foram aprovadas (47/50 cada). Nenhuma foi
mergeada — branch protection exige aprovação humana, e a política deste loop é nunca fazer push
direto. Ver `workbench.md` para os detalhes de cada subtarefa e achados.

## PRs abertas (aguardando revisão/aprovação humana)

- PR #1 `test/gaps-pequenos` — computeDhcpRange, rate limit hardware, erros 404
- PR #2 `test/ws-timeout` — timeout WS 5s
- PR #3 `test/frontend-security-events` — Vitest+Testing Library, Security.tsx, Events.tsx (+ fix de crash)
- PR #4 `e2e/network-flows` — Playwright + controller UniFi fake, 3 fluxos reais

## Se retomar este loop numa sessão futura

1. Confira se as 4 PRs acima já foram mergeadas (`gh pr list` / `gh pr view <n>`). Se sim, `git pull`
   master e releia o estado real antes de assumir que ainda há trabalho pendente — o README pode
   já refletir tudo isso.
2. O que resta depois do merge: nada de código deste loop específico. A única pendência é o gate
   humano já respondido (ver abaixo) — planejar (não implementar sem planejamento) a persistência
   de histórico de banda por cliente além de 24h.
3. Não redescubra o que já foi auditado: a auditoria inicial encontrou que ssh-credentials,
   block/unblock+fixed-ip, wifi+networks, hardware restart/power-cycle e bandwidth history já
   tinham cobertura substancial ANTES mesmo desta onda — não é preciso reabrir essas áreas sem um
   motivo novo e real.

## Decisão do gate humano (respondida em 2026-08-31)

Histórico de uso de banda por cliente além de 24h: usuário confirmou que **vira prioridade para a
próxima etapa**, após esta onda ser mergeada. Não implementar sem planejamento explícito antes
(escolha de banco, job periódico, retenção). Registrado em memória do projeto
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
- Nunca push direto — só PR; branch protection exige aprovação humana.

## Nota sobre audit-log

Havia um `audit-log.service.ts` (log interno de ações do dashboard) não commitado, encontrado numa
queda de PC no início desta sessão. Isolado na branch `feat/audit-log` (commit próprio) por decisão
do usuário — não é parte deste loop, não confundir com "log de login de administrador" (decisão
fechada, não implementado por falta de endpoint confiável no controller).

## Ambiente deixado rodando (para o usuário testar manualmente)

Backend (porta 3000) e frontend (porta 5173) foram deixados rodando em background durante esta
sessão — conveniência, não parte do loop. Podem já não estar mais no ar numa sessão futura.
