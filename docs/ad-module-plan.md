# Plano da Onda 3 — Módulo de Active Directory + Ponte 802.1X

Documento de referência técnica para a Onda 3. Carregar isto no contexto de qualquer par
executor/crítico que mexa em `src/services/ad.service.ts`, `src/routes/ad.routes.ts`, ou no
`fake-ldap-server` de e2e. Escrito a partir de uma revisão externa do repositório (2026-09-09) —
nada aqui foi testado contra um AD real ainda; tratar como especificação, não como verdade
absoluta, do mesmo jeito que a pesquisa de impressoras começou como hipótese e foi corrigida contra
o equipamento real várias vezes.

## Contexto — por que este módulo existe

O projeto hoje cobre 100% do lado UniFi (clientes, devices, Wi-Fi/RADIUS, networks, segurança, SSH,
banda, impressoras) e 0% do lado Active Directory. O objetivo do usuário é que só quem tem conta
válida no AD consiga acessar a rede — o mecanismo correto é 802.1X com RADIUS (NPS no Windows
Server) validando contra o AD. O lado Wi-Fi disso já existe (`createWifi` em
`frontend/src/lib/api.ts` já aceita `securityType: 'WPA2_ENTERPRISE'|'WPA3_ENTERPRISE'` +
`radiusProfileId`, e `listRadiusProfiles()` já lê os perfis RADIUS cadastrados no controller). O que
falta é inteiramente do lado AD: gestão de usuários/grupos/computadores, e a ponte que liga
"membro do grupo X no AD" a "tem acesso à rede".

## Pré-requisitos (Onda 3, subtarefas 0.x — fazer ANTES do resto)

Achados de uma revisão externa do repositório, mesmo espírito da "Subtarefa 1" da Onda 1 (fechar
gaps pequenos e genuínos antes de partir para o que falta de verdade):

- **0.1 — Log de auditoria inexistente em `master`.** Existe uma tentativa isolada na branch
  `feat/audit-log` (não commitada no histórico principal, encontrada numa queda de PC). Decisão a
  tomar: recuperar aquela branch ou recriar do zero. De qualquer forma, isto é bloqueante para a
  Onda 3: toda ação de escrita do módulo de AD (criar/excluir usuário, resetar senha, mudar grupo)
  precisa gravar quem fez o quê, quando — muito mais crítico aqui do que em qualquer módulo
  anterior, dado o histórico do usuário com acesso indevido à rede.
- **0.2 — Rate limit inconsistente em 3 rotas DELETE.** `DELETE /wifi/:id`, `DELETE /networks/:id`
  (`src/routes/networks.routes.ts`) e `DELETE /printers/:id` (`src/routes/printers.routes.ts`) não
  usam `{ config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, ... } } }` como as demais
  rotas de escrita do mesmo arquivo — caem no limite global (100/min) em vez do mais restrito
  (10/min). Corrigir por consistência antes de replicar o padrão de rotas no módulo novo.
- **0.3 — Senha em branco no admin da HP (SWS).** Já registrado no CLAUDE.md como decisão fechada
  de não mexer "por enquanto" — só reafirmando aqui que, com o módulo de AD trazendo ainda mais
  poder de administração pro dashboard, vale reconsiderar a prioridade disso.

## Escopo funcional

### Usuários
- Buscar/listar usuários (nome, `sAMAccountName`, e-mail, habilitado/desabilitado, bloqueado)
- Criar usuário (com senha inicial + opção de forçar troca no próximo logon)
- Editar atributos (nome, e-mail, departamento, cargo)
- Excluir usuário
- Habilitar / desabilitar conta
- Desbloquear conta travada
- Resetar senha
- Restringir em quais PCs o usuário pode logar (`userWorkstations`)

### Grupos / privilégios
- Buscar/listar grupos
- Criar grupo
- Adicionar / remover membro (é assim que privilégio funciona no AD — pertencer a um grupo)

### Computadores
- Listar computadores do domínio (nome, SO, último logon, habilitado)
- Habilitar / desabilitar objeto de computador

### Ponte 802.1X (o motivo de tudo isso existir)
- Grupo dedicado no AD, ex. `Rede-Permitida`, referenciado por env var
  (`AD_NETWORK_ACCESS_GROUP_DN`)
- Endpoint de conveniência `POST /ad/users/:username/network-access` (habilita) e
  `DELETE /ad/users/:username/network-access` (revoga) — por baixo, só chama
  add/removeGroupMember no grupo configurado. Revogar acesso de alguém vira uma chamada
  específica, não "lembrar de tirar da lista genérica de grupos".
- Pré-requisito de infraestrutura (fora do código, documentado só pra contexto): NPS configurado no
  Windows Server com uma Network Policy que exige membership nesse grupo, UniFi com perfil RADIUS
  apontando pro NPS, SSID em WPA2/3-Enterprise usando esse perfil.

## Arquitetura — seguindo as convenções já estabelecidas no projeto

- `src/services/ad.service.ts` — client LDAPS (pacote `ldapts`), no mesmo espírito de
  `unifi-classic.service.ts`: uma função `withClient` central que faz bind/unbind, erros tipados
  (`AdNotConfiguredError` quando `AD_*` não está nas env vars — mesmo papel de
  `ClassicApiNotConfiguredError`; `AdRequestError` pra falha de LDAP).
- `src/routes/ad.routes.ts` — mesmo padrão dos demais: `app.addHook('preHandler', app.authenticate)`,
  rate limit por `env.RATE_LIMIT_CLIENT_ACTION_MAX` nas mutações, Zod pra validação de body/params.
- `src/config/env.ts` — novas variáveis, todas opcionais (mesmo tratamento de
  `UNIFI_CONTROLLER_USER`/`PASSWORD`, que também são opcionais e desativam um pedaço do app sem
  quebrar o resto):
  ```
  AD_URL                    (ldaps://dc.dominio.local:636)
  AD_BASE_DN
  AD_BIND_DN
  AD_BIND_PASSWORD
  AD_USERS_OU
  AD_NETWORK_ACCESS_GROUP_DN
  ```
- Log de auditoria (uma vez resolvida a subtarefa 0.1) — toda rota de escrita deste módulo passa
  por ele, sem exceção.

## Estratégia de teste — o ponto mais importante deste plano

O e2e do resto do projeto nunca toca um controller UniFi real (`e2e/fake-controller/`, HTTPS com
certificado autoassinado em memória, reproduzindo peculiaridades reais da API). O módulo de AD
precisa do mesmo princípio: um `fake-ldap-server` que nunca é o AD de produção, especialmente
porque as ações aqui são ainda mais destrutivas (excluir usuário de verdade, resetar senha de
verdade) do que qualquer coisa já implementada.

- Servidor LDAP fake em memória (ex.: usando um pacote tipo `ldap-server`/implementação mínima
  própria, análogo ao `https.createServer` manual do fake-controller), com um punhado de
  usuários/grupos/computadores de exemplo, respondendo bind/search/modify/add/del o suficiente pros
  fluxos testados.
- Testes unitários mockando o client `ldapts` (mesmo nível dos testes unitários de
  `unifi.service.test.ts`).
- Testes de integração Fastify (`.inject()`) cobrindo guarda de auth, validação Zod, e mapeamento
  de erro (`AdNotConfiguredError` → 503, no mesmo padrão de `ClassicApiNotConfiguredError`).
- e2e (Playwright) cobrindo pelo menos: criar usuário → aparece na lista; desabilitar usuário →
  status muda na tela; adicionar a `Rede-Permitida` → remover → confirma nos dois estados.

## Subtarefas sugeridas (ordem de dependência, mesmo formato das Ondas anteriores)

1. Pré-requisitos (0.1 log de auditoria, 0.2 rate limit, 0.3 revisitar decisão da senha HP)
2. `ad.service.ts` — usuários (busca, criar, editar, excluir, habilitar/desabilitar, desbloquear,
   resetar senha, logon-workstations) + erros tipados
3. `ad.routes.ts` — rotas de usuário, com auditoria e rate limit
4. `ad.service.ts`/`ad.routes.ts` — grupos (criar, listar, add/remove membro)
5. `ad.service.ts`/`ad.routes.ts` — computadores (listar, habilitar/desabilitar)
6. Ponte 802.1X — endpoint de conveniência `network-access` sobre o grupo configurado
7. `fake-ldap-server` + testes unitários/integração de tudo acima
8. Frontend — telas de Usuários/Grupos/Computadores AD (mesmo padrão visual das telas existentes:
   `Layout`, `StatCard`, `Badge`, `usePolling`)
9. e2e cobrindo os 3 fluxos do escopo funcional acima

## Fora de escopo desta onda (registrar, não implementar sem pedido explícito)

- Gestão de pastas/compartilhamentos (NTFS/SMB) — não é LDAP, precisa de WinRM contra um file
  server. Mecanismo completamente diferente; módulo próprio se/quando for pedido.
- EAP-TLS / certificados de máquina para 802.1X — PEAP-MSCHAPv2 com credencial de domínio é o ponto
  de partida; certificado é evolução futura, não bloqueia nada deste plano.
