# `fake-ldap-server` — o que foi modelado por RFC e o que foi confrontado com um DC real

> **Item 3 da sequência de fechamento da Onda 3. Este documento é um INVENTÁRIO, não um
> plano de correção.** O objetivo é que nenhum comportamento de erro do fake volte a ser
> tratado como "verificado" só por estar escrito conforme a RFC.

## Por que este documento existe

Em 2026-09-11, um teste de fumaça supervisionado contra o `EA-SRV-AD01` (Windows Server 2016)
achou um **bug de produção que 746 testes verdes não pegavam**: a idempotência da REVOGAÇÃO de
acesso à rede nunca funcionou contra um AD real. O fake respondia `16 noSuchAttribute` ao
`delete` de um valor ausente — o que a RFC 4511 §4.6 de fato permite — e o AD real responde
`53 unwillingToPerform`. O `catch` do código de produção cobria só o 16.

A lição, registrada no `CLAUDE.md` como precedente de processo:

> **A RFC descreve o que é PERMITIDO; a implementação escolhe dentro disso. Modelar pela RFC é
> o ponto de partida certo, não é evidência.**

E a distinção que dá o tamanho do risco:

| | fake mais **ESTRITO** que o real | fake **DIFERENTE** do real |
|---|---|---|
| Exemplo | `objectCategory` (subtarefa 6) | idempotência do delete |
| Efeito | expõe dependência implícita | **mascara bug de produção** |
| Custo se ninguém notar | zero — só ajuda | revogação que falha num incidente |

## Inventário dos resultCodes (`RESULT`, `server.mjs:63`)

Legenda: ✅ confrontado contra o `EA-SRV-AD01` · ⚠️ **suposição de RFC, nunca validada** ·
🔶 confrontado e o fake foi CORRIGIDO porque divergia.

| Código | Onde o fake usa | Estado |
|---|---|---|
| `0` success | toda operação bem-sucedida | ✅ Exercitado à exaustão no teste de fumaça (14 passos, cada um confirmado por releitura independente do diretório). |
| `1` operationsError | operação enviada antes de um bind bem-sucedido (`server.mjs:474`) | ✅ **Confrontado.** Uma busca sem bind contra o `EA-SRV-AD01` devolveu exatamente 1. Registrado na PR #33. |
| `16` noSuchAttribute | `delete` de valor ausente, em atributos **que não sejam `member`** (`:744`, `:756`) | 🔶 / ⚠️ Para `member`, **medido e corrigido** (o real é 53). Para **qualquer outro atributo, segue suposição de RFC** — nada garante que o AD use 16 em, digamos, `userWorkstations`. |
| `20` attributeOrValueExists | `add` de valor já existente, em atributos **que não sejam `member`** (`:728`) | 🔶 / ⚠️ Mesma situação do 16: para `member` foi medido (o real é 68); para os demais atributos é suposição. |
| `32` noSuchObject | `modify`/`del` de um DN que não existe (`:695`, `:795`) | ⚠️ **Nunca confrontado.** Plausível e provavelmente certo, mas não medido. |
| `49` invalidCredentials | bind com DN/senha que não batem (`:560`) | ⚠️ **Nunca confrontado.** O teste de fumaça nunca tentou um bind ERRADO de propósito contra o DC. |
| `53` unwillingToPerform | (a) `delete` de `member` ausente (`:744`, `:756`); (b) operação fora do subconjunto implementado (`:526`) | (a) ✅ **Medido contra o real.** (b) ⚠️ nunca confrontado — é convenção interna do fake, não afirmação sobre o AD. |
| `68` entryAlreadyExists | (a) `add` de `member` já existente (`:728`); (b) `add` de um DN que já existe (`:619`) | (a) ✅ **Medido.** (b) ⚠️ **nunca confrontado** — apesar de ser o mesmo código, são caminhos diferentes e só um foi medido. |

### Ressalva sobre os dois códigos "medidos" (68/53 no `member`)

O Verificador cego da 2ª rodada (2026-09-14) registrou, com razão: esses dois números vêm de
**uma sonda de uma sessão anterior**, e **não foram remedidos** depois. Todo o desenho da
idempotência e os testes que a travam descansam nessa única medição. Se ela estiver errada, o
fake está fiel a uma medição errada e a suíte segue verde. **Refazer essa sonda é o primeiro
item de qualquer teste de fumaça futuro.**

## Divergências estruturais — não são resultCode, e importam mais

| # | Comportamento | Estado |
|---|---|---|
| D1 | **Bind anônimo** (DN e/ou senha vazios) é RECUSADO pelo fake. Um AD real normalmente ACEITA, com leitura restrita. | ⚠️ Fake **mais estrito**. Categoria benigna. Deliberado e documentado no próprio `handleBind`. |
| D2 | **Leitura do root DSE sem bind**: o fake recusa; um AD real costuma permitir. | ⚠️ Fake **mais estrito**. Irrelevante hoje (`ad.service.ts` nunca lê root DSE); anotado para não virar surpresa. |
| D3 | **RANGE RETRIEVAL** — acima de ~1500 membros o AD devolve `member;range=0-1499` em vez de `member`. **O fake NUNCA emite isso.** | ⚠️ **Categoria PERIGOSA (fake diferente do real).** O código de produção tem um ramo para esse caso desde `cd81cf7`, e **nenhum teste contra o fake o exercita** — só o unitário com mock. Um grupo real grande (o `wifi-colaboradores` tem 20, mas grupos de domínio passam de 1500) toma um caminho que o fake não sabe produzir. |
| D4 | **ACL sobre o atributo `member`**: um AD pode devolver a entrada sem `member`, indistinguível de grupo vazio. O fake não simula. | ⚠️ Limite já registrado em `readMembership` — **falso positivo residual conhecido**, sem correção possível sem um sinal independente. |
| D5 | **`MaxPageSize` (1000 por padrão no AD)** e paged results: o fake devolve tudo sem limite. `searchGroups()` sem filtro trouxe 68 grupos do domínio real — abaixo do limite por acaso. | ⚠️ Nunca exercitado. Some com o achado já registrado de que `searchGroups` não tem paginação. |
| D6 | **Referrals** (`10 referral`): o fake nunca emite. Um AD multi-domínio emite. | ⚠️ Irrelevante num domínio único; vira relevante se o ambiente crescer. |
| D7 | **`objectCategory` derivado pelo schema**: o AD real preenche sozinho; o fake não. | ✅ **Confrontado — e foi assim que o achado da subtarefa 6 apareceu.** Categoria benigna (fake mais estrito), expôs uma dependência implícita real do `createUser`. |
| D8 | **Parser de filtro**: o fake implementa um subconjunto. | ⚠️ Parcial. Os testes de injeção usam o `escapeFilter` REAL do `ldapts`, então a proteção está travada; a fidelidade do parser em si, não. |

## Conclusão operacional

O fake é **sólido no caminho feliz e no que já foi medido**, e continua sendo a única camada que
roda o `ldapts` real por socket contra as funções de produção. O que ele **não** é: evidência
sobre semântica de erro do AD.

Antes de **computadores (subtarefa 4)**, os itens que mais importam são **D3** e a ressalva dos
68/53 — porque computadores traz `userAccountControl` e operações de `modify` sobre objetos que
podem estar em grupos grandes. Os demais ⚠️ ficam registrados como suposição, conforme o
briefing: **o objetivo aqui é o inventário, não fechar todos os itens agora.**
