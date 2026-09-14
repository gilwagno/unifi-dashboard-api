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
| Onda 3 — Active Directory + ponte 802.1X | ✅ **Concluída (2026-09-14)** — usuários, grupos, computadores, ponte 802.1X, `fake-ldap-server`, frontend e e2e | `docs/ad-module-plan.md` |
| Onda 4 — Acesso remoto a qualquer PC (Guacamole) | 📋 Planejada, não iniciada | `docs/remote-access-plan.md` |
| Infraestrutura — Cloudflare Tunnel + Access | 📋 Planejada, não iniciada | `docs/cloudflare-tunnel-setup.md` |

## Pendências abertas

> **Onda 3 fechada em 2026-09-14.** Tudo o que esta seção listava como
> bloqueante da Onda 3 foi resolvido: a revisão cega da idempotência (2
> rodadas), o gate do `nps.msc`, a Decisão 2 do aninhamento, computadores,
> frontend e e2e. O histórico detalhado fica no `CLAUDE.md`.

- **Percentuais dos painéis das Brothers** (Onda 2, independente) — pendente
  COM O USUÁRIO. `tools/brother-mib-probe.mjs --cruzar` está pronto,
  prioridade DCP-L3560CDW (`.80`). **Não imprimir nada entre ler o painel e
  rodar o cruzamento**, senão o contador anda e a correlação perde o valor.
- **Senha do administrador do domínio em texto plano no `.env`** (fora do
  Git, mas em disco). A conta usada é `gilwagno.silva`, ADMIN do domínio, não
  uma conta de serviço escopada — decisão explícita do usuário depois de o
  risco ser levantado. Trocar quando houver calma.
- **Nenhum teste do backend é typechecked** — o `tsconfig.json` da raiz tem
  `include: ["src/**/*.ts"]`, então `tsc --noEmit` limpo não diz nada sobre
  `tests/`. Pré-existente, achado de 2026-09-11.
- **`resolveGroupMembers` monta um filtro com um OR de todos os membros.** Um
  grupo com centenas de membros pode estourar o limite de tamanho de filtro
  do DC. Não medido: o maior grupo real deste domínio tem 20 membros.
  Registrado como não verificado, não como "funciona".

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
