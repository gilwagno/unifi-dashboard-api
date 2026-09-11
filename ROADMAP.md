# Roadmap — unifi-dashboard-api

> Visão consolidada pra conferência rápida. Detalhe de cada item nos documentos linkados;
> histórico completo (PRs, achados, decisões) fica no `CLAUDE.md`.

## Visão geral da arquitetura (estado alvo)

```
[Você, de qualquer lugar, no navegador]
        |
  Cloudflare Tunnel + Access (login antes de chegar no app) ── infra, não onda de código
        |
  Frontend React (dashboard HTML)
        |
  Backend Fastify
        |
  ┌───────────┬────────────┬────────────┬──────────────┐
  │   UniFi    │  Printers   │     AD      │ Acesso remoto │
  │  (núcleo)  │  (Onda 2)   │  (Onda 3)   │   (Onda 4)    │
  └───────────┴────────────┴────────────┴──────────────┘
```

## Status por peça

| Peça | Status | Documento de referência |
|---|---|---|
| Núcleo UniFi (clientes, devices, Wi-Fi/RADIUS, networks, segurança, SSH, banda) | ✅ Implementado | `CLAUDE.md` (histórico geral) |
| Onda 1 — Cobertura de testes | ✅ Concluída (2026-08-31) | `CLAUDE.md` §"Onda 1" |
| Onda 2 — Manutenção de impressoras (SNMP, WBM/SWS, consumíveis, histórico) | ✅ Concluída (2026-09-08) | `CLAUDE.md` §"Onda 2" |
| Onda 3 — Active Directory + ponte 802.1X | 🚧 **Em andamento** — usuários + ponte 802.1X mergeados (PR #25, 2026-09-11); grupos, computadores, `fake-ldap-server`, frontend e e2e não iniciados | `docs/ad-module-plan.md` |
| Onda 4 — Acesso remoto a qualquer PC (Guacamole) | 📋 Planejada, não iniciada | `docs/remote-access-plan.md` |
| Infraestrutura — Cloudflare Tunnel + Access | 📋 Planejada, não iniciada | `docs/cloudflare-tunnel-setup.md` |

## Pendências abertas

> **Correção de exatidão (2026-09-11)**: a versão anterior desta seção listava as 3
> subtarefas 0.x como pendentes. **As três já estavam resolvidas desde 2026-09-10** — 0.1 na
> PR #23, 0.2 na PR #20, 0.3 na PR #22 (e esta última foi além de "revisitar a prioridade":
> a troca de senha foi implementada e aplicada ao vivo nas duas HPs reais, encerrando a
> vulnerabilidade de senha de fábrica). Nenhuma delas bloqueia mais nada.

- **PR #30 aberta, revisada e APROVADA (47/50), aguardando merge**
  (`fix/printers-toner-level-vendor-mib`) — toner das HPs em 0% com cartucho cheio, coleta
  SNMP no boot, layout do card, 2 specs de e2e, mais as correções dos 6 achados da revisão.
  Ver o registro completo no `CLAUDE.md`.
- **Variáveis `AD_*` não configuradas no `.env` real** — documentadas no `.env.example`, mas
  ausentes. Sem elas o módulo de AD responde 503 por desenho (o resto do app funciona
  normal), e **nenhuma linha do módulo jamais falou com um Active Directory de verdade**.
- **Nenhum teste do backend é typechecked** — o `tsconfig.json` da raiz tem
  `include: ["src/**/*.ts"]`, então `tsc --noEmit` limpo não diz nada sobre `tests/`.
  Pré-existente, achado de 2026-09-11.

## Ordem de dependência entre as ondas planejadas

1. **Onda 3 (AD)** primeiro — além do valor próprio, ela é pré-requisito de duas coisas:
   a lista de computadores que alimenta a Onda 4, e o grupo `Rede-Permitida` que fecha o
   802.1X (cujo lado UniFi já está pronto no núcleo).
2. **Onda 4 (Acesso remoto)** depende da lista de PCs da Onda 3, mas a infraestrutura
   (Guacamole, GPO de RDP) pode ser preparada em paralelo.
3. **Cloudflare Tunnel + Access** é independente das outras duas — pode ser feito a
   qualquer momento, é só a camada de acesso remoto ao dashboard inteiro.

## Harness de desenvolvimento

Toda onda nova segue `docs/gauntlet-loop-prompt.md` (harness de 4 pontos, ver `CLAUDE.md`
§"Metodologia"). Onda 1 e 2 foram feitas sob a rubrica anterior (0–50) — não retroativamente
convertidas, ficam como registro histórico.
