# Gauntlet Loop (Harness Edition) — UniFi Dashboard API

Prompt padrão de reuso para rodar qualquer feature/módulo novo neste projeto seguindo a
metodologia Gauntlet Loop dentro da própria harness do Claude Code (sem orquestrador externo).
Adotado como convenção padrão a partir de 2026-09-09 — usar isto (preenchendo os dois campos no
final) sempre que uma feature nova ou uma etapa de trabalho substancial for iniciada, salvo pedido
explícito em contrário do usuário.

**Nota de manutenção**: a seção "0. Mapeamento obrigatório" abaixo descreve a estrutura do projeto
tal como estava em versões anteriores (só auth/block/restart/WebSocket). O projeto hoje é bem mais
amplo — módulo de impressoras completo (CRUD, SNMP, reboot HP/SWS, descoberta de rede), histórico
de banda, segurança/auditoria, credenciais SSH, etc. — e tem um `CLAUDE.md` na raiz que documenta o
estado real e o histórico de decisões (achados, correções, pendências). **Sempre que este prompt for
usado, o passo de leitura de `CLAUDE.md`/`README.md` deve refletir o estado ATUAL do projeto, não a
lista de arquivos descrita abaixo** — a lista serve de exemplo do tipo de mapeamento esperado, não
como inventário definitivo.

---

Você vai atuar dentro da harness desta ferramenta (ex: Claude Code) como um orquestrador, com no
máximo 2 subagentes auxiliares (total: 3 agentes rodando por vez — orquestrador, executor,
verificador). Não crie mais subagentes que isso; se a tarefa for grande, quebre-a em etapas
sequenciais, reutilizando o mesmo par executor/verificador para cada etapa.

## 0. ANTES DE QUALQUER CÓDIGO — MAPEAMENTO OBRIGATÓRIO

Este repo já tem convenções próprias, ainda que documentadas de forma mais enxuta que um projeto
grande. Antes do Executor tocar em qualquer arquivo, ele deve, nesta ordem:

1. Ler `CLAUDE.md` na raiz, se existir. Se não existir, tratar o `README.md` como a fonte de
   instruções para agentes até que um `CLAUDE.md` seja criado — e sinalizar ao usuário que criar um
   pode valer a pena, sem criar por conta própria sem pedir.
2. Ler `README.md` (raiz) — cobre setup, tabela de endpoints, convenção do handshake do WebSocket
   (token via primeira mensagem, não via query string), comandos de teste e a seção "⚠️ Antes de
   usar de verdade". Essa seção final é normativa, não decorativa: os avisos sobre schema da API do
   UniFi variar por versão, rodar atrás de VPN/tunnel, e trocar `JWT_SECRET` em produção são
   restrições a respeitar, não "problemas" a resolver silenciosamente dentro do escopo de uma
   feature.
3. Ter em mente a estrutura real do repo (projeto único, não monorepo) — **conferir a árvore atual
   de `src/` em vez de assumir a lista abaixo**, que é só ilustrativa de uma versão anterior:
   - `src/server.ts` — entrypoint, chama `buildApp()` e `app.listen()`.
   - `src/app.ts` — monta a instância Fastify: cors, rate-limit, plugins (auth, websocket), rotas,
     a rota `/health`, e o error handler central (propaga status de `UniFiApiError`, trata
     `ZodError` como 400 com `error.flatten()`, qualquer outro erro vira 500 genérico sem vazar
     stack trace).
   - `src/config/env.ts` — carga/validação de variáveis de ambiente.
   - `src/plugins/` — `auth.ts`, `websocket.ts`.
   - `src/routes/` — uma rota por área (`auth`, `clients`, `devices`, `printers`, `wifi`,
     `networks`, `security`, `bandwidth`, `ssh`, etc.).
   - `src/services/` — lógica de negócio/integração externa (`unifi.service.ts`,
     `unifi-classic.service.ts`, `printer-*.service.ts`, etc.). Ao criar uma rota nova, seguir o
     padrão já existente (registrar em `app.ts`, validar entrada com Zod, deixar o error handler
     central tratar os erros em vez de reimplementar try/catch redundante). Ao adicionar lógica de
     negócio contra o controller UniFi (ou qualquer outro serviço externo), ela pertence a
     `src/services/`, não dentro da rota.
   - `src/db/` — persistência em SQLite (`node:sqlite`), quando a feature exigir estado além de
     memória.
   - `src/types/` — tipos de domínio (ex: `unifi.ts`, schema da API do UniFi).
4. Ler `.env.example` para entender quais variáveis são obrigatórias antes de propor qualquer
   mudança que dependa de configuração nova — se a feature exigir uma env var nova, adicioná-la ao
   `.env.example` também (documentado, sem valor real).
5. Se durante o trabalho surgir necessidade de registrar um erro/incidente de integração com o
   controller ou com um equipamento (ex: um endpoint que se comporta diferente do esperado numa
   versão de firmware), documentar isso inline como comentário próximo ao tipo/rota/serviço afetado
   **e também no `CLAUDE.md`** (este projeto já usa `CLAUDE.md` como registro corrente de achados,
   decisões e pendências — não `docs/incidentes/`; não criar uma estrutura de documentação nova sem
   alinhar antes).
6. Este projeto é backend-only no núcleo, mas já tem um frontend próprio (`frontend/`, React/Vite)
   que consome a API — se a feature envolver o frontend, seguir os componentes/padrões já
   existentes ali (`Layout`, `Badge`, hooks como `usePolling`), não introduzir uma stack/estilo
   paralelo.
7. Atenção: tipos que espelham a API de Integração do UniFi (`src/types/unifi.ts`) refletem o
   schema "na medida do possível" — o README já avisa que nomes de campo e caminhos de endpoint
   podem variar por versão do controller, e o mesmo vale por extensão pra qualquer API de
   equipamento de terceiros (SWS da HP, WBM da Brother, etc.) que a feature toque. Antes de confiar
   cegamente nesses tipos/documentação prévia para uma feature nova, confirmar contra uma resposta
   real capturada do dispositivo/controller em uso sempre que a ação for de escrita ou de risco não
   trivial — se houver divergência, isso é uma inconsistência a reportar e corrigir dentro do
   escopo da própria feature.
8. Rodar `git status` antes de começar. Se já houver mudanças não commitadas no repo (fora do
   controle deste loop), reportar isso ao usuário antes de prosseguir — não misturar essas
   alterações pré-existentes com os commits do Gauntlet Loop.

Só depois desse mapeamento o Orquestrador deve quebrar o trabalho em etapas.

## Contexto do projeto

Este não é um backend do zero: já existe uma base funcional extensa (auth JWT, CRUD de
bloqueio/desbloqueio de clientes, restart de dispositivos, WebSocket de eventos, error handler
central, módulo completo de manutenção de impressoras — CRUD, poller SNMP, reboot remoto HP/SWS,
descoberta de candidatos na rede —, histórico de banda persistente, segurança/auditoria, rotação de
credencial SSH, e um frontend React consumindo tudo isso). A meta é **[implementar/completar a
feature X]** respeitando os padrões já estabelecidos (Zod para validação, classes de erro por
domínio para erros vindos de serviços externos, plugin pattern do Fastify, teste via vitest
mockando o serviço na camada certa — nunca a implementação interna da rota) — não recriar a
arquitetura nem contornar as decisões de segurança já tomadas (handshake do WebSocket, deploy atrás
de VPN/tunnel, segredos nunca devolvidos em leitura).

**Feature/módulo alvo desta rodada**: `[preencher aqui]`

**Critério de pronto (Definition of Done)**: `[preencher aqui — ex: rota nova com validação Zod,
tratada pelo error handler existente, coberta por teste com o serviço mockado, README/CLAUDE.md
atualizado, sem regressão nos testes existentes]`

## Notas de adaptação

- O projeto original de referência (ERP com 17 departamentos, RBAC, múltiplas áreas de
  documentação) tinha um mapeamento bem mais amplo — este projeto é um serviço único e menor, então
  o mapeamento obrigatório fica reduzido a `CLAUDE.md`/`README.md` + `.env.example` + estrutura de
  `src/`/`frontend/`, sem simular uma hierarquia documental que não existe.
- Se o projeto crescer ainda mais (múltiplos serviços, um `docs/` muito mais estruturado), vale
  reintroduzir passos do mapeamento original (checagem de design system, índice de documentação) na
  mesma lógica: ler antes de agir, e reportar inconsistências em vez de resolvê-las por conta
  própria fora do escopo.
- **Antes de colar este prompt disparando uma rodada de verdade, preencher os dois campos acima**
  — sem eles, o orquestrador não tem escopo definido para quebrar em etapas.
