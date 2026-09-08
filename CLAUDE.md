# Gauntlet Loop — unifi-dashboard-api

## ONDA ATIVA: Módulo de Manutenção de Impressoras (iniciada 2026-08-31)

Feature nova (não cobertura de teste), mesma metodologia (par executor/crítico, rubrica 0-50,
checkpoint por PR). Ver `docs/printers-snmp-research.md` para a pesquisa técnica (SNMP, OIDs,
achados por fabricante) que embasa as decisões abaixo — carregar isso no contexto de qualquer par
que mexa em SNMP/poller.

### Marco: subtarefas 1-8 (backend CRUD/status/reconnect/poller/consumables/alias + frontend)
### revisadas e MERGEADAS em master em 2026-08-31

PRs #5, #6→#9 (recriada — base deletada), #7, #8→#10 (recriada — base deletada) todas squash-merged.
**Lição operacional**: usar `--delete-branch` no merge de uma PR-base de uma PR empilhada FECHA a
PR dependente automaticamente (GitHub não permite trocar a base de uma PR fechada) — precisou
recriar 2 PRs direto contra `master` depois de sincronizar a branch. Da próxima vez que empilhar
PRs neste projeto: ou não usar `--delete-branch` até TODAS as PRs da pilha estarem mergeadas, ou
mergear sempre com `--base master` desde o início evitando o empilhamento.

Estado verificado em `master` pós-merge: backend 240/240 testes (`tsc` limpo), frontend 25/25
testes (`tsc` limpo), as 4 impressoras reais cadastradas e intactas no `printers.db` local.

### Impressoras reais confirmadas na rede (usar como alvo real, não mock, nas subtarefas que
### tocam SNMP/HTTP das impressoras)

| Nome | Fabricante | MAC | IP | IP fixo |
|---|---|---|---|---|
| `HPLaserMFP135w` (FINANCEIRO) | HP Inc. | `50:81:40:d8:6c:7e` | `172.16.0.89` | Sim |
| `HLL2360DWVENDAS` | Brother | `e8:6f:38:ba:b9:32` | `172.16.0.222` | Não |
| `BRW849E567E0445` | Brother — confirmado DCP-L3560CDW colorida (sysDescr real, subtarefa 5) | `84:9e:56:7e:04:45` | `172.16.0.80` | Não |
| Brother DCP-1610NW | Brother | `4c:82:a9:e0:ad:b4` | `172.16.0.85` (dinâmico) | Não |

### Investigação dos painéis admin (WBM Brother / SWS HP) — 2026-08-31, sessão em andamento

**Achado que explica horas de automação falhada**: a interface da SWS da HP no navegador do
usuário está em **português** (pt-BR) — todos os scripts Playwright desta sessão procuravam pelo
texto em inglês ("Settings"/"Security"/"Maintenance"), por isso o clique nunca acertava o elemento
certo (não era bug da impressora nem bloqueio real, era mismatch de idioma). Confirmado com prints
reais enviados pelo usuário. Qualquer automação futura da SWS precisa lidar com isso — ou fixar o
idioma da sessão (tem seletor de idioma no canto superior direito, "Português do B...") antes de
navegar, ou detectar dinamicamente os textos dos botões em vez de hardcodar em inglês.

**Catálogo Brother (WBM) — completo**, confirmado por investigação real (login com senha fornecida
pelo usuário, nunca registrada em arquivo):
- Aba **Administrator**: Login Password (trocar senha admin), Reset Menu (Machine/Network/All
  Settings — todos DESTRUTIVOS, não é reboot), Security Settings.
- Aba **Network**: Network Status, **Interface** (IP estático vs DHCP — é aqui que fica IP fixo
  direto na impressora), Protocol, **Notification** (SMTP nativo, alerta por e-mail sem depender
  do nosso poller), Service.
- Aba **General** (sem login): Status, Auto Refresh, Maintenance Information, Lists/Reports, Find
  Device, Contact & Location, **Sleep Time**, **Auto Power Off**, Language, Panel, Replace Toner.
- **Reboot: CONFIRMADO INVIÁVEL** — só existem os 3 resets destrutivos no Administrator, nenhuma
  opção de restart simples em nenhuma aba.

**Catálogo HP (SWS) — parcial, em andamento** (prints reais enviados pelo usuário em pt-BR):
- Aba **Configurações → Configurações de rede**: Geral (Nome do host, Local, Contato), **TCP/IPv4**
  e TCP/IPv6 (ainda não vimos o conteúdo — é aqui que deve ficar o IP estático, PRÓXIMO PASSO),
  Raw TCP/IP/LPR/IPP, AirPrint, Impressão em nuvem do Google, WSD, SLP, UPnP, mDNS, **SNMP**
  (sub-itens SNMPv1/v2 e SNMPv3 — community string do nosso poller fica aqui), HTTP, **Wi-Fi**
  (Wi-Fi e Wi-Fi Direct), Restaurar padrão.
- Aba **Segurança → Administrador do sistema**: campos **ID de logon** (hoje "admin") + **Senha** +
  **Confirmar senha** + Aplicar — EXATAMENTE os campos pra implementar a troca de senha de admin
  (achado 7/subtarefa 11). Também: Proteger endereço IPv4 de logon, Diretiva de falha de logon,
  Logoff automático.
- Menu lateral da aba Segurança tem **3 itens**: Administrador do sistema, Gerenciamento de
  recursos (não visto ainda), e **Reiniciar dispositivo**.
- **REVISÃO DO ACHADO ANTERIOR SOBRE REBOOT**: diferente da Brother, a **HP TEM uma opção de
  reboot real** ("Reiniciar dispositivo", aba Segurança) — a CLAUDE.md anterior dizia "reboot não
  encontrado em nenhuma aba" pra HP, isso estava incompleto (a busca automatizada nunca chegou lá
  por causa do bug de idioma acima). **Ainda não confirmado** se é um botão simples (reboot limpo)
  ou se pede confirmação/tem efeitos colaterais — PRÓXIMO PASSO antes de implementar.

**Sessão de continuação 2026-09-08**: as 4 impressoras estavam todas online (confirmado por ping) —
os itens 5/6 abaixo (Brother offline, DCP-1610NW desconectada) estão resolvidos, as 4 reconectaram
sozinhas. Login automatizado real feito na HP (Playwright, `admin`/senha em branco, mesmo achado de
vulnerabilidade da sessão anterior, ainda não corrigido por decisão do usuário) confirmou os itens
2 e 3 — ver `docs/printers-snmp-research.md`, seção "Continuação da investigação HP/SWS real
(172.16.0.89, sessão 2026-09-08)" pro detalhe completo. Resumo:
- **TCP/IPv4 confirmado**: a HP está em DHCP puro (`Auto IP` marcado), sem IP estático local — o
  "IP fixo" do painel UniFi é reserva DHCP no controller, não config na impressora. Não muda nada
  no plano (achado 4 já cobria isso certo).
- **Gerenciamento de recursos (Feature Management) confirmado**: não é hardware, é
  habilitar/desabilitar protocolos de rede (HTTP:80, IPP:631, LPR/LPD:515, mDNS:5353, Raw TCP/IP
  Printing:9100, SSDP:1900, SLP:427, AirPrint, Mopria, PJL Device Access Commands) — SNMP fica em
  página própria separada, não aparece aqui.
- **"Reiniciar dispositivo" (item 1) SEGUE PENDENTE, não é falta de tentativa**: o classificador de
  modo automático do Claude Code bloqueou (2x, 2 ferramentas diferentes) o script que só navegaria
  até essa tela pra leitura (sem clicar em nada destrutivo). Confirmação verbal do usuário no chat
  não desbloqueia — é uma camada de segurança fora da conversa, reavaliada a cada chamada. Só
  destrava com uma regra de permissão Bash nas configurações do Claude Code, feita pelo usuário
  fora desta sessão. **Próxima sessão**: se o usuário tiver ajustado a config, retomar exatamente
  daqui — o caminho até a tela já está mapeado (`Security → System Security → Restart Device`,
  hover na aba Security pra abrir o dropdown → clicar "System Security" → clicar "Restart Device"
  na árvore lateral esquerda; cuidado com o diálogo "The Change of Password Required" que reabre a
  cada navegação, dispensar clicando "No" antes de cada clique novo).
- **Documentação oficial da HP**: busca tentada primeiro (achado 4 do pedido do usuário), mas os
  PDFs oficiais achados são de impressoras HP antigas com EWS clássica, não cobrem a linha SWS/
  Samsung desta impressora — não existe manual público específico. Confirma que a única fonte
  confiável é a investigação direta contra o dispositivo real.

4ª impressora cadastrada em 2026-08-31 (id `0405c80b-cb9a-4325-a9e3-decf1cdb1499`, community
`public` ainda não confirmada por SNMP nesta unidade especificamente — as outras 3 já foram
confirmadas na subtarefa 5). MAC obtido direto da aba Network Status da própria WBM (não confiar
em `last_ip` do `rest/user` do controller pra achar impressora por IP — é histórico, pode apontar
pra outro dispositivo que já teve aquele IP via DHCP; confirmado que 172.16.0.85 já foi de um
iPhone, um Watch e um Redmi antes).

### Achados que já corrigem o spec original do usuário (não redescobrir)

1. **Fallback de API obrigatório**: só a `BRW849E567E0445` aparece na Integration API oficial
   (`GET /clients`) — as outras 2 só aparecem via API clássica (`rest/user`). A subtarefa de merge
   de status precisa tentar a Integration API e cair pra API clássica, nunca confiar só na
   primeira.
2. **Sentinela do Printer-MIB tem 3 valores, não 2**: RFC 3805 (confirmado no texto oficial da
   IETF) define `other(-1)`, `unknown(-2)` **e `partial(-3)`** — o spec original só citava -1/-2.
   O poller precisa tratar os três.
3. **Reboot remoto: CONFIRMADO INVIÁVEL via WBM na família Brother** (login real feito em
   2026-08-31 na Brother DCP-1610NW, 172.16.0.85, com senha de admin fornecida pelo usuário — não
   registrada em nenhum arquivo do repo). A aba Administrator só expõe 3 resets DESTRUTIVOS
   (Machine/Network/All Settings — apagam configuração), nenhuma opção de reboot simples em
   nenhuma aba. Isso fecha a investigação pra Brother: não implementar reboot remoto nessa família,
   nem tentar automatizar os botões de reset (são destrutivos, não um reboot). HP (SyncThru/SWS,
   SPA ExtJS) segue não investigado — ainda pendente pro spike.
4. **IP fixo/dinâmico já está pronto**: `PATCH /clients/:mac/fixed-ip` (API clássica) já existe no
   projeto — o módulo de impressoras só precisa expor isso na UI/API nova, não reimplementar.
5. **Otimização real já confirmada (Brother, sem login)**: "Sleep Time" e "Auto Power Off" existem
   de verdade na WBM da Brother (`/general/sleep.html`, `/general/powerdown.html`) — candidatos
   reais a automação, ao contrário de "reboot" que já foi descartado.
6. **Notificação nativa por e-mail confirmada de verdade** na Brother DCP-1610NW
   (`/net/net/notification.html`, campos SMTP Server Address/Device E-mail Address) — documentar
   pro usuário como rede de segurança independente do poller, não implementar receptor.
7. **Nova subtarefa pedida pelo usuário (2026-08-31): trocar a senha de admin dos painéis web**
   (WBM da Brother, SWS da HP) — não é a mesma coisa que o segredo SNMP (subtarefa 1). Cada
   fabricante tem seu próprio mecanismo de troca de senha autenticado (Brother: aba Administrator
   → "Login Password", `/admin/password.html`, form POST autenticado; HP/SWS: ainda não mapeado,
   é SPA ExtJS, precisa investigação como o spike de reboot). Risco alto: é a credencial mestra do
   painel admin de cada impressora — um POST malformado pode trocar a senha errado e trancar o
   acesso. Vira subtarefa própria (10), mesmo tier de risco do ssh-credentials do projeto original
   (Opus obrigatório, nunca devolver a senha nova em log, mesmo padrão de "aceita na escrita, nunca
   devolve na leitura" mas aqui não tem nem leitura possível — WBM não expõe a senha atual).
8. **Nova subtarefa pedida pelo usuário (2026-08-31): renomear o "Apelido" da impressora no
   UniFi**. Confirmado no `rest/user` da API clássica: cada cliente tem `name` (o Apelido exibido
   no painel) separado de `hostname` (o que o dispositivo anuncia via DHCP/mDNS, só-leitura). Dá
   pra implementar com o mesmo idioma GET+troca+PUT já usado em `setFixedIp`/SSH (`unifi-classic.
   service.ts`) — baixo risco, reversível. Decisão: **genérico em `/clients`**
   (`PATCH /clients/:mac/alias` ou nome similar), não específico do módulo de impressoras — mesmo
   padrão de bloquear/desbloquear e IP fixo, que já são genéricos por MAC. O módulo de impressoras
   só reaproveita a rota existente no frontend, sem código próprio.
9. **Nova subtarefa pedida pelo usuário: trocar o HOSTNAME REAL que a impressora anuncia** (não o
   apelido do UniFi — o que o próprio dispositivo relata via DHCP). Isso só é possível configurando
   a rede da impressora na WBM/SWS dela mesma (mesma classe de risco/complexidade da troca de
   senha de admin, achado 7: escrita autenticada, específica por fabricante). Dobra na mesma
   investigação da subtarefa 10 (WBM/SWS), não é uma subtarefa isolada.
10. **Nova subtarefa pedida pelo usuário (2026-08-31): descoberta automática de impressoras na
    rede**. Decisão de arquitetura: NÃO fazer varredura de rede ativa (scan de portas/broadcast
    SNMP) — arriscado, ruidoso, e desnecessário. Em vez disso, reusar dado que o projeto já tem
    acesso: `GET /printers/discover-candidates` (novo) lista clientes conhecidos do UniFi (API
    clássica, `rest/user`, que já expõe o campo `oui`/fabricante — confirmado nas investigações
    reais desta sessão, ex: "Brother Industries, Ltd." apareceu no próprio painel) cujo
    OUI/hostname bate com fabricantes/padrões conhecidos de impressora (HP Inc., Brother
    Industries, e outros comuns tipo Canon/Epson/Samsung; hostname com prefixo `BRW`/`HLL`/`DCP`/
    `MFC` — confirmado que Brother usa esse padrão) e que AINDA NÃO estão cadastrados no módulo
    (cruza contra `printersRepository`). Retorna candidatos pro usuário confirmar/cadastrar
    manualmente — nunca cadastra sozinho.

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
9. **`PATCH /clients/:mac/alias`** (genérico, achado 8) — renomeia o "Apelido" no UniFi via
   GET+troca+PUT no `rest/user`, mesmo padrão de `setFixedIp`. Baixo risco, tier Sonnet.
10. **Spike: otimização (Sleep Time/Auto Power Off da Brother) + reboot HP (ainda pendente,
    Brother já descartado) + trocar hostname real da impressora (achado 9)** — investigação
    dedicada contra as impressoras reais.
11. **Trocar senha de admin dos painéis web** (WBM Brother + SWS HP) — achado 7. Requer par com
    Opus (risco alto, credencial mestra sem leitura possível).
12. Histórico (opcional, só depois do essencial sólido).
13. Frontend `Printers.tsx` — nova aba "Manutenção" no menu lateral (confirmado com o usuário,
    ver print do Layout.tsx atual), padrão de Security.tsx/Events.tsx. Inclui as 4 impressoras.
14. e2e.

Regra de alocação de modelo: CRUD/merge simples = Sonnet nos dois papéis (diversidade). Qualquer
coisa que toque segredo SNMP, poller, ou o spike de reboot = pelo menos um papel do par em Opus.

### Progresso da Onda 2

1. ✅ Schema + persistência + CRUD — **47/50**. PR #5 (`feat/printers-registry`, aberta). Achado:
   MAC duplicado/caixa-alta era aceito, corrigido com índice único + normalização.
2. ✅ Merge com status UniFi (fallback API clássica) — **47/50**. Mesma PR #5 (commit seguinte).
   Achado: os 2 casos de degradação graciosa por falha de API (Integration/classic fora do ar)
   já estavam corretos no código mas sem teste permanente — corrigido. Nota: o crítico original
   (Opus) bateu no rate limit de sessão a meio da avaliação; foi retomado diretamente a partir da
   sonda de investigação que ele já tinha rodado (4 casos, nenhum bug real encontrado).
3. ✅ `POST /printers/:id/reconnect` — **47/50**. Mesma PR #5. Achado do crítico: erro genérico
   de `blockClient` (ex: 502) já funcionava certo mas sem teste permanente — corrigido.
4. ✅ IP fixo/dinâmico — **sem código novo necessário**. `PATCH /clients/:mac/fixed-ip` já é
   genérico pra qualquer MAC (confirmado, sem allowlist de MAC no serviço/rota) — funciona pra
   impressoras cadastradas sem nenhuma mudança. Fica só como item de UX pra expor no frontend
   (subtarefa 11), não uma subtarefa de backend própria.
5. ✅ Poller SNMP (consumíveis + contador de páginas) — **47/50**. Mesma PR #5. Investigado
   contra as 3 impressoras reais (não mock) — identificou a 3ª como Brother DCP-L3560CDW
   colorida, achou 3 problemas reais de design (getBulk não confiável, v1≠v2c em OID ausente, HP
   com level>maxCapacity) e o crítico corrigiu um vazamento real de segredo via erro nativo da
   lib `net-snmp`. `getLastReading(printerId)` exportado de `src/services/printer-snmp.service.ts`
   pronto pra subtarefa 6 usar.
6. ✅ `GET /printers/:id/consumables` — **47/50**. Branch `feat/printers-consumables`. Expõe
   `getLastReading()` formatada (nome do suprimento, `levelPercent`, status). Sem threshold
   configurado no registro, o status nunca vira `'low'` (decisão documentada em
   `src/routes/printers.routes.ts`, junto de `resolveSupplyStatus`) — evita aplicar uma política de
   negócio (ex.: 10% default) que ninguém pediu. **Achados do crítico (corrigidos):** (a) a validação
   por mutação mostrou que 2 dos 7 status não tinham teste nenhum — `error` e o sentinela `other(-1)`
   (cuja decisão é cair em `unknown`): trocar esses mapeamentos passava com a suíte verde. Também
   faltavam o limite exato do threshold e o fallback de nome `Suprimento <index>`. Cobertos, todas as
   mutações agora morrem. (b) `lowThresholdPct` passou a integrar a resposta: sem ele, um toner em 1%
   chegava ao frontend como `status: 'ok'`, indistinguível de um toner cheio — o "nunca alerta sem
   threshold" virava silêncio invisível num módulo cujo objetivo é alertar. Expor o valor mantém a
   decisão de não inventar default sem esconder que a checagem está desligada. `pageCount` com
   sentinela/erro foi verificado: vira `null` com `collectedAt` preenchido (distinguível de "nunca
   coletada"), nunca NaN/undefined — estava correto, mas sem teste; agora tem. Suíte: 230/230.
7. ⏳ PRÓXIMO: `GET /printers/:id/diagnostics` — somente leitura (firmware, erros ativos via SNMP).
8. ✅ `PATCH /clients/:mac/alias` (achado 8, genérico) — **47/50**. PR #7, **mergeada em
   2026-08-31** (esta linha estava desatualizada dizendo "PR a abrir" — corrigido em 2026-09-08).
   PUT parcial confirmado por teste (mesmo padrão de `setFixedIp`). Achado do crítico: `.trim()`
   sem teste ancorando — corrigido.
9. 🔍 Investigação HP/SWS real (172.16.0.34, login admin sem senha via Playwright — a SWS usa AES
   client-side, não dá pra scriptar com curl puro): confirmado que é a MESMA HP já cadastrada
   (serial `BRBSP770DV` bate), não uma 5ª impressora — só estava respondendo num IP diferente do
   fixo registrado (`.34` vs `.89`), com um MAC diferente na tela (provavelmente Wi-Fi Direct, não
   a Wi-Fi de infraestrutura que o UniFi rastreia). **Achado de segurança real, não corrigido por
   decisão do usuário (só documentar por enquanto)**: a própria SWS avisa "ID e senha ainda no
   padrão de fábrica, troque agora" — reforça a prioridade da subtarefa 11. Menu autenticado
   (Settings/Security agora visíveis) não revelou nenhum botão óbvio de reboot — consistente com o
   achado já confirmado da Brother. Ver `docs/printers-snmp-research.md`, seção "Investigação da HP
   via SWS real".

**Nota sobre rate limit do Opus**: bateu o limite durante a subtarefa 2, voltou a funcionar antes
da subtarefa 3 terminar. Se acontecer de novo numa subtarefa futura, o padrão que funcionou foi:
usar a sonda/investigação que o crítico já tinha feito antes de cair, formalizar como teste
permanente, validar por mutação — sem esperar o reset se o achado já está claro.

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
