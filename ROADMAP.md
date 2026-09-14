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
| Onda 3 — Active Directory + ponte 802.1X | 🚧 **Em andamento** — usuários + ponte 802.1X (#25), `fake-ldap-server` (#32), bind por conexão (#33) e **grupos (#34, mergeada em 2026-09-14)**; faltam computadores (4), frontend (7) e e2e (8) | `docs/ad-module-plan.md` |
| Onda 4 — Acesso remoto a qualquer PC (Guacamole) | 📋 Planejada, não iniciada | `docs/remote-access-plan.md` |
| Infraestrutura — Cloudflare Tunnel + Access | 📋 Planejada, não iniciada | `docs/cloudflare-tunnel-setup.md` |

## Pendências abertas

> **Correção de exatidão (2026-09-11)**: a versão anterior desta seção listava as 3
> subtarefas 0.x como pendentes. **As três já estavam resolvidas desde 2026-09-10** — 0.1 na
> PR #23, 0.2 na PR #20, 0.3 na PR #22 (e esta última foi além de "revisitar a prioridade":
> a troca de senha foi implementada e aplicada ao vivo nas duas HPs reais, encerrando a
> vulnerabilidade de senha de fábrica). Nenhuma delas bloqueia mais nada.

> A PR #30 (toner das HPs em 0%) foi **mergeada em 2026-09-11** (squash `5f9f9f2`) — saiu
> desta lista.
> **Correção de exatidão (2026-09-14)**: a versão anterior desta seção dizia que
> `fake-ldap-server` e grupos estavam "não iniciados" e que **nenhuma linha do módulo jamais
> falou com um AD de verdade**. As duas coisas deixaram de ser verdade em 2026-09-11 — ver o
> ponto de parada no topo do `CLAUDE.md`. Este arquivo ficou para trás; corrigido agora.

### Onda 3 — o que está aberto agora

- ~~PR #34 (grupos do AD)~~ **MERGEADA em 2026-09-14** (squash `c1c6704`). A correção de
  idempotência passou por DUAS rodadas de revisão cega: reprovada 3/4 na primeira (a releitura
  passava com a suíte inteira verde mesmo respondendo cego), aprovada 4/4 na segunda.
  Subtarefa 3 fechada.
- **Subtarefas 4 (computadores) e 7 (frontend) não iniciadas.** O módulo de AD **não tem
  nenhuma tela** — existe só por HTTP. O gate do inventário do `fake-ldap-server` está
  cumprido (`docs/fake-ldap-rfc-vs-real.md`), então computadores está liberada.
- **Decisão 2 (aninhamento) pendente com o usuário** — opção (b), grupo próprio do
  dashboard, proposta e não confirmada.
- **⛔ Aninhamento de grupos bloqueia fechar a subtarefa 5 (ponte 802.1X) para produção.**
  `wifi-colaboradores` tem grupos departamentais inteiros como membros; `removeGroupMember`
  opera sobre membership DIRETA e retornaria sucesso sem revogar o acesso herdado. Duas
  opções registradas no `CLAUDE.md`, nenhuma escolhida.
- **`nps.msc` pendente COM O USUÁRIO** — confirmar que `wifi-colaboradores` é mesmo a
  condição "Grupos de Windows" da Network Policy de 802.1X. Hoje é inferência forte, não
  confirmação; nenhuma variável de produção deve apontar para esse DN antes disso.
- **Levantamento dos pontos do `fake-ldap-server` modelados por RFC e nunca confrontados com
  um DC real** — obrigatório ANTES de computadores (subtarefa 4). Foi exatamente esse padrão
  que deixou 746 testes verdes provando um comportamento de revogação que nunca existiu no
  AD real.

### Outras

- **Variáveis `AD_*`**: já validadas contra o AD real (`evokaudio.local`) no teste de fumaça
  de 2026-09-11 — `AD_URL` precisa ser o NOME do DC, nunca IP (o certificado quebra com
  `ERR_TLS_CERT_ALTNAME_INVALID`). Hoje `AD_USERS_OU`/`AD_GROUPS_OU` apontam para uma OU de
  teste; apontar para produção só depois do `nps.msc`.
- **Senha do administrador do domínio em texto plano no `.env` real** (fora do Git, mas em
  disco) — trocar quando houver calma.
- **Percentuais dos painéis das Brothers** (Onda 2, independente da Onda 3) — pendente COM O
  USUÁRIO. `tools/brother-mib-probe.mjs --cruzar` pronto; não imprimir nada entre ler o
  painel e rodar o cruzamento.
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
