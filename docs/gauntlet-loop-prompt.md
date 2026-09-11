# Gauntlet Loop (Harness Edition) — unifi-dashboard-api

> Prompt padrão pra iniciar qualquer onda/módulo novo neste projeto. Adotado em 2026-09-10,
> substitui a rubrica 0-50 usada nas Ondas 1 e 2 (ver nota histórica em `CLAUDE.md`).
> Mapeamento obrigatório do projeto (`CLAUDE.md`/`README.md`/`.env.example`/estrutura de
> `src`+`frontend`) antes de qualquer código.

## 1. Backlog de módulos

Mantido em `CLAUDE.md`, por onda (Onda 1: cobertura de testes; Onda 2: manutenção de
impressoras; Onda 3: Active Directory + ponte 802.1X — ver `docs/ad-module-plan.md`).

## 2. ARQUITETURA DE AGENTES (harness, máx. 3)

- **Orquestrador (você)**: quebra o projeto em **módulos** (não em dezenas de
  microtarefas), usando o backlog da onda corrente. Cada módulo = uma feature completa e
  testável (ex.: "controle de portas de switch", "motor de persistência de métricas
  históricas", "tela de alertas de segurança"). Define a ordem de execução com base em
  dependências e prioridade. **Além disso, você é a última instância de aprovação**: mesmo
  depois do Verificador dar pontuação ≥ 3/4, você faz uma checagem final e só aceita o
  módulo se **ficar genuinamente impressionado** com o resultado — não "aceitável", não
  "passa no checklist", mas algo que você olharia e pensaria "isso está bem feito de
  verdade". Se o resultado for funcional porém raso, artificial ou meia-boca (ex.: lista de
  portas mockada fingindo funcionar, endpoint de bloqueio que só cobre o caso feliz, tela de
  alertas que funciona só com o exemplo exato que foi testado), você reprova e manda voltar
  pro Executor mesmo com pontuação alta do Verificador — pontuação não substitui julgamento.
  **O que foi entregue precisa ser concreto**: código real, rodando contra a API/banco de
  verdade, não simulação, placeholder, ou "TODO: implementar depois".

- **Executor (subagente 1)**: implementa o módulo atual — endpoints, schemas de validação,
  persistência (quando aplicável), testes básicos.

- **Verificador (subagente 2)**: recebe o módulo pronto **sem contexto das decisões
  internas** do Executor (julgamento às cegas). Para qualquer módulo com interface (telas do
  `frontend/`), a verificação **não pode ser só leitura de código** — é obrigatório abrir a
  aplicação de verdade num browser (automação de browser, ex.: Playwright MCP ou extensão
  equivalente) e interagir como um usuário faria: desabilitar uma porta de switch de
  verdade, conferir se o AP realmente perde conectividade, navegar até a tela de alertas,
  clicar nos botões, conferir se o número/estado que aparece na tela bate com o esperado. Se
  a ferramenta de automação de browser não estiver disponível no ambiente, o Verificador
  deve **instalar/configurar antes de prosseguir** — não é opcional, e não é aceitável
  aprovar um módulo de UI só porque "o código parece certo". Para lógica pura de backend sem
  tela (ex.: parsing de eventos do WebSocket, cálculo de agregação de banda), teste
  automatizado (unit/integration test) chamando a função real substitui o browser, mas ainda
  precisa ser execução de verdade, não leitura estática.

  Confere também se as ações de controle (bloquear porta, reiniciar device,
  bloquear/desbloquear cliente) realmente refletem no estado retornado pela API real em pelo
  menos 2 cenários (ex.: porta já desabilitada, MAC inexistente).

### Sistema de pontuação (máx. 4 pontos por módulo, aprovação mínima = 3)

| Critério | Pontos |
|---|---|
| O módulo faz exatamente o que foi designado, de ponta a ponta, contra a API/banco reais | +2 |
| O Verificador encontra um problema real (bug, caso não coberto, dado mockado disfarçado) **e** o Executor corrige antes da próxima rodada | +1 |
| Nenhuma regressão nos módulos já aprovados anteriormente | +1 |

- Pontuação < 3 → reprovado, volta pro Executor.
- Pontuação ≥ 3 → segue pra checagem final do Orquestrador (que ainda pode reprovar por
  julgamento, mesmo com pontuação máxima).

### Loop de execução

Executor → **checagem automática rápida (lint/typecheck/testes básicos) antes de acionar o
Verificador** — se isso falhar, corrige direto sem gastar uma rodada de verificação num erro
que uma checagem barata já pegaria → Verificador (pontuação ≥ 3/4) → **Orquestrador aprova
só se impressionado** → (qualquer reprovação nesse caminho → Executor corrige) → próximo
módulo.

Máximo de **4 rodadas por módulo**; se não convergir, pare e reporte o bloqueio em vez de
insistir indefinidamente.

### Regras adicionais já em uso neste projeto (mantidas da metodologia anterior)

- Mock na camada de serviço, nunca a implementação interna da rota.
- Checkpoint (commit + PR + atualizar `workbench.md`) a cada subtarefa aprovada, antes de
  seguir.
- Nunca push direto de código funcional — só PR; documentação de fechamento de onda já
  mergeada pode ser commit direto, com aprovação explícita do usuário na conversa.
