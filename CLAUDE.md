# Gauntlet Loop — unifi-dashboard-api

## ONDA ATIVA: Módulo de Manutenção de Impressoras (iniciada 2026-08-31)

Feature nova (não cobertura de teste), mesma metodologia (par executor/crítico, rubrica 0-50,
checkpoint por PR). Ver `docs/printers-snmp-research.md` para a pesquisa técnica (SNMP, OIDs,
achados por fabricante) que embasa as decisões abaixo — carregar isso no contexto de qualquer par
que mexa em SNMP/poller.

### Impressoras reais confirmadas na rede (usar como alvo real, não mock, nas subtarefas que
### tocam SNMP/HTTP das impressoras)

| Nome | Fabricante | MAC | IP | IP fixo |
|---|---|---|---|---|
| `HPLaserMFP135w` (FINANCEIRO) | HP Inc. | `50:81:40:d8:6c:7e` | `172.16.0.89` | Sim |
| `HLL2360DWVENDAS` | Brother | `e8:6f:38:ba:b9:32` | `172.16.0.222` | Não |
| `BRW849E567E0445` | Brother (modelo exato não confirmado) | `84:9e:56:7e:04:45` | `172.16.0.80` | Não |

### Achados que já corrigem o spec original do usuário (não redescobrir)

1. **Fallback de API obrigatório**: só a `BRW849E567E0445` aparece na Integration API oficial
   (`GET /clients`) — as outras 2 só aparecem via API clássica (`rest/user`). A subtarefa de merge
   de status precisa tentar a Integration API e cair pra API clássica, nunca confiar só na
   primeira.
2. **Sentinela do Printer-MIB tem 3 valores, não 2**: RFC 3805 (confirmado no texto oficial da
   IETF) define `other(-1)`, `unknown(-2)` **e `partial(-3)`** — o spec original só citava -1/-2.
   O poller precisa tratar os três.
3. **Reboot remoto não é trivial em nenhum fabricante**: HP usa uma SPA ExtJS (SyncThru/SWS) sem
   link estático de reboot — precisa mapear as chamadas JS internas. Brother WBM não expõe reboot
   na aba sem-login (`General`); pode estar em `Administrator` (exige login) ou pode não existir
   via WBM. SNMP padrão (RFC 3805) não define OID de reboot. **Virou subtarefa própria de
   investigação (spike), não uma implementação garantida.**
4. **IP fixo/dinâmico já está pronto**: `PATCH /clients/:mac/fixed-ip` (API clássica) já existe no
   projeto — o módulo de impressoras só precisa expor isso na UI/API nova, não reimplementar.
5. **Otimização real já confirmada (Brother, sem login)**: "Sleep Time" e "Auto Power Off" existem
   de verdade na WBM da Brother (`/general/sleep.html`, `/general/powerdown.html`) — candidatos
   reais a automação, ao contrário de "reboot" que ainda é incerto.

### Ordem de subtarefas da Onda 2 (fila sequencial, mesma regra de ≥47 pra avançar)

1. Schema + persistência + CRUD de registro de impressora (`node:sqlite`, built-in do Node 24 —
   bump `engines.node` pra `>=22.5.0` no `package.json`). `POST/GET/PATCH/DELETE /printers`,
   segredo SNMP nunca devolvido em GET (mesmo padrão do ssh-credentials).
2. Merge com status UniFi — Integration API com fallback pra API clássica (achado 1 acima).
3. `POST /printers/:id/reconnect` — reaproveita block+unblock já existente.
4. Expor IP fixo/dinâmico da impressora via a rota já existente (achado 4).
5. Poller SNMP (consumíveis + contador de páginas) — tratando os 3 sentinelas (achado 2), modelado
   em `bandwidth-history.service.ts`.
6. `GET /printers/:id/consumables`.
7. `GET /printers/:id/diagnostics` — somente leitura (firmware, erros ativos via SNMP).
8. Agenda de manutenção (`POST/GET /printers/:id/maintenance*`).
9. **Spike: reboot remoto + otimização (Sleep Time/Auto Power Off da Brother)** — investigação
   dedicada contra as impressoras reais antes de comprometer implementação. Reporta o que é
   possível de forma segura antes de codar.
10. Histórico (opcional, só depois do essencial sólido).
11. Frontend `Printers.tsx` — nova aba "Manutenção" no menu lateral (confirmado com o usuário,
    ver print do Layout.tsx atual), padrão de Security.tsx/Events.tsx.
12. e2e.

Regra de alocação de modelo: CRUD/merge simples = Sonnet nos dois papéis (diversidade). Qualquer
coisa que toque segredo SNMP, poller, ou o spike de reboot = pelo menos um papel do par em Opus.

## Onda 1 (fechamento de cobertura de testes) — CONCLUÍDA — 4 PRs revisadas e mergeadas em 2026-08-31

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
