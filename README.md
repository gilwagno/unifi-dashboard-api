# UniFi Dashboard API

Backend em Fastify/TypeScript para controlar clientes e APs UniFi
(bloquear/desbloquear dispositivos, reiniciar APs, ver status) via a API
local de Integração do controller.

Tem também um dashboard web em [`frontend/`](frontend/README.md) (React +
Vite + Tailwind) que consome essa API.

## Setup

1. No controller: **Settings > Control Plane > Integrations** → gere uma
   API key. Ela vai no header `X-API-Key` (não `Authorization: Bearer`).
2. Copie `.env.example` para `.env` e preencha `CONTROLLER_HOST` e
   `UNIFI_API_KEY`.
3. Gere o hash da sua senha de admin:
   ```
   node -e "console.log(require('bcryptjs').hashSync('SUA_SENHA', 10))"
   ```
   e coloque o resultado em `ADMIN_PASSWORD_HASH`.
4. Instale e rode:
   ```
   npm install
   npm run dev
   ```
5. Descubra o `SITE_ID`: faça login (`POST /auth/login`) e chame
   `GET /sites` com o token — pegue o campo `id` (um UUID) do site que
   quer usar e coloque em `SITE_ID` no `.env`. **Não** use o valor de
   `internalReference` (ex: `"default"`) — a API rejeita isso como siteId.
   Reinicie o servidor depois de mudar o `.env` (não é hot-reload).
6. (Opcional, para bloquear/desbloquear clientes) preencha
   `UNIFI_CONTROLLER_USER`/`UNIFI_CONTROLLER_PASSWORD` com as credenciais
   do painel do controller — veja a seção **Bloquear/desbloquear
   clientes** abaixo.

## Endpoints

| Método | Rota                          | Descrição                        |
|--------|--------------------------------|-----------------------------------|
| POST   | /auth/login                    | Retorna um access token + refresh token |
| POST   | /auth/refresh                  | Troca um refresh token por um novo access token |
| GET    | /sites                         | Lista os sites do controller      |
| GET    | /clients?siteId=&blocked=&type=&page=&pageSize= | Lista clientes conectados (filtros + paginação) |
| POST   | /clients/:mac/block             | Bloqueia um cliente (API clássica — ver seção abaixo) |
| POST   | /clients/:mac/unblock           | Desbloqueia um cliente (API clássica — ver seção abaixo) |
| GET    | /devices?siteId=&page=&pageSize= | Lista APs/switches de um site (paginado) |
| GET    | /devices/:id?siteId=...         | Detalhe de um dispositivo (inclui portas, se houver) |
| POST   | /devices/:id/restart?siteId=... | Reinicia um dispositivo           |
| POST   | /devices/:id/ports/:portIdx/power-cycle?siteId=... | Power-cycle de uma porta PoE (reboot do que estiver ligado nela) |
| WS     | /ws/events?token=...            | Stream de eventos em tempo real   |
| GET    | /events/history?limit=...      | Últimos eventos recebidos (buffer em memória) |
| GET    | /security/summary               | Resumo de segurança: ameaças detectadas, status do IPS, firmware desatualizado (API clássica) |
| GET    | /security/events                | Eventos/alarmes críticos do controller (API clássica) |
| GET    | /security/admins                | Admins do controller e seus papéis/permissões por site (API clássica) |
| GET    | /security/audit-log?limit=...   | Log de auditoria das ações feitas NESTE dashboard (não do controller) |
| GET    | /wifi?siteId=...                 | Lista as redes Wi-Fi (SSIDs) do site (API oficial) |
| POST   | /wifi?siteId=...                 | Cria uma rede Wi-Fi nova (WPA2_PERSONAL ou Enterprise/RADIUS, API oficial) |
| GET    | /wifi/radius-profiles?siteId=...  | Lista os perfis RADIUS cadastrados no UniFi (somente leitura, API oficial) |
| PATCH  | /wifi/:id/password?siteId=...    | Troca a senha de uma rede Wi-Fi (API oficial) |
| PATCH  | /wifi/:id/enabled?siteId=...      | Habilita/desabilita uma rede Wi-Fi (API oficial) |
| DELETE | /wifi/:id?siteId=...              | Remove uma rede Wi-Fi (API oficial) |
| GET    | /networks?siteId=...              | Lista as networks/VLANs do site (API oficial) |
| POST   | /networks?siteId=...              | Cria uma VLAN nova gerenciada pelo gateway (API oficial) |
| DELETE | /networks/:id?siteId=...          | Remove uma VLAN (API oficial) |
| GET    | /networks/zones?siteId=...        | Lista as zonas de firewall do site (ex: Internal, External) (API oficial) |
| PATCH  | /clients/:mac/fixed-ip            | Liga/desliga o IP fixo (reserva de DHCP) de um cliente (API clássica) |
| GET    | /health/devices                   | Saúde dos APs/switches: CPU, memória, uptime, rádios (API clássica) |
| GET    | /health/clients-signal             | Força de sinal dos clientes Wi-Fi conectados (API clássica) |
| GET    | /health/wan-uptime                 | Histórico de disponibilidade do WAN nas últimas 24h (API clássica) |
| GET    | /bandwidth/history                 | Buffer bruto (cumulativo) de amostras de uso de banda — ver seção abaixo |
| GET    | /bandwidth/history/summary          | Mesmo buffer, já com a diferença de uso calculada por intervalo — ver seção abaixo |

### Renovando o token

`POST /auth/login` retorna um `token` (access token, expira em 12h) e um
`refreshToken` (expira em 30d). Quando o access token expirar, troque-o por
um novo sem pedir usuário/senha de novo:

```
POST /auth/refresh
{ "refreshToken": "<refreshToken recebido no login>" }
```

Retorna `{ "token": "<novo access token>" }`. O refresh token em si não é
rotacionado — continua válido até expirar ou até você trocar `JWT_SECRET`.
Não há como revogar um token individualmente (sem estado de sessão no
servidor); se precisar invalidar tokens emitidos, troque `JWT_SECRET`.

### Paginação em /clients e /devices

Ambas aceitam `?page=` (padrão 1) e `?pageSize=` (padrão 50, máximo 200).
A resposta muda de `{ data }` para `{ data, pagination: { page, pageSize,
total, totalPages } }`. Assim como o filtro, a paginação é aplicada depois
de buscar a lista completa no controller — não reduz o tráfego com ele,
só o tamanho da resposta.

### Filtro em /clients

`GET /clients` aceita `?blocked=true|false` e `?type=WIRED|WIRELESS`,
combináveis. O filtro é aplicado depois de buscar a lista completa no
controller (a API de Integração não garante filtro server-side confiável
entre versões), então não reduz o tráfego com o controller — só a resposta.

### Rate limiting

Os limites de requisição são configuráveis via `.env` (veja
`.env.example`), todos opcionais com os defaults atuais:

| Variável                        | Default    | Aplica em                                   |
|----------------------------------|------------|----------------------------------------------|
| `RATE_LIMIT_WINDOW`              | `1 minute` | janela compartilhada por todos os limites     |
| `RATE_LIMIT_MAX`                 | `100`      | limite global por IP                          |
| `RATE_LIMIT_CLIENT_ACTION_MAX`   | `10`       | `POST /clients/:mac/block` e `/unblock`       |
| `RATE_LIMIT_DEVICE_RESTART_MAX`  | `5`        | `POST /devices/:id/restart` e `POST /devices/:id/ports/:portIdx/power-cycle` |

### Bloquear/desbloquear clientes

`POST /clients/:mac/block` e `POST /clients/:mac/unblock` bloqueiam/liberam
o acesso de um cliente à rede (o cliente fica sem conectividade até ser
desbloqueado). Isso **não** é feito pela Integration API oficial — testado
contra um controller real e contra a doc OpenAPI da Integration API,
confirmamos que ela só suporta autorizar/desautorizar acesso de **guest**
(`AUTHORIZE_GUEST_ACCESS`/`UNAUTHORIZE_GUEST_ACCESS`), não bloquear um
cliente comum, e também não expõe de forma confiável se um cliente está
bloqueado.

Por isso essas duas rotas (e o campo `blocked` de `GET /clients`) usam a
API **clássica/privada** do controller — a mesma que o app UniFi Network
usa internamente (login por cookie de sessão em `/api/auth/login` +
comando `block-sta`/`unblock-sta` em `/proxy/network/api/s/{site}/cmd/stamgr`,
e leitura de `blocked` em `/proxy/network/api/s/{site}/rest/user`). Isso
**foi testado contra um controller real** (bloqueio/desbloqueio
confirmados funcionando).

Configuração (veja `.env.example`):

| Variável                    | Obrigatória? | Descrição |
|------------------------------|--------------|-----------|
| `UNIFI_CONTROLLER_USER`      | Não          | Usuário do painel do controller (login da UI do UniFi Network) |
| `UNIFI_CONTROLLER_PASSWORD`  | Não          | Senha do painel do controller |
| `UNIFI_CONTROLLER_SITE`      | Não (default `default`) | `internalReference` do site — **diferente** do `SITE_ID` (UUID) usado pela Integration API |

**Não confunda** `UNIFI_CONTROLLER_USER`/`PASSWORD` com
`ADMIN_USER`/`ADMIN_PASSWORD_HASH` — estes últimos são o login deste
dashboard, não têm relação com o controller.

### Histórico de uso de banda

Diferente das rotas de `/health/*` (que buscam dado ao vivo na hora do
request), `/bandwidth/history` e `/bandwidth/history/summary` são
alimentadas por um **poller em segundo plano** (`src/services/bandwidth-
history.service.ts`) que roda dentro do próprio processo do backend desde
que ele sobe:

- A cada **5 minutos**, coleta os contadores de tráfego (`tx_bytes`/
  `rx_bytes`) de todos os devices (`stat/device`) e clientes (`stat/sta`)
  via a API clássica, e guarda essa amostra num buffer em memória.
- O buffer guarda até **288 amostras** (24h ÷ 5min), descartando a mais
  antiga quando cheio.
- É **em memória** (o buffer em si, ver `/bandwidth/history/long-range`
  abaixo para o histórico persistido) — o buffer some a cada restart do
  backend. Isso também quer dizer que **a primeira amostra só aparece
  depois de 5 minutos** do backend ter subido (o buffer começa vazio).
- Uma falha pontual de coleta (controller fora do ar, etc.) é logada e
  ignorada — o poller não para, só tenta de novo no próximo ciclo.

`GET /bandwidth/history` devolve o buffer bruto: cada amostra tem os
valores **cumulativos** de `rxBytes`/`txBytes` por device/cliente (o mesmo
tipo de contador que só cresce enquanto o device está ligado/o cliente
conectado). `GET /bandwidth/history/summary` devolve, em vez disso, a
**diferença** de uso entre cada par de amostras consecutivas (quanto foi
trafegado naquele intervalo de ~5min) — mais prático pra montar um
gráfico/lista sem o frontend precisar fazer essa conta. Se o contador
"zerou" entre duas amostras (o device reiniciou ou o cliente reconectou),
a diferença dessa entrada vem como `null` em vez de um número negativo sem
sentido.

#### Histórico de longo prazo (`GET /bandwidth/history/long-range`)

O buffer em memória acima só guarda 24h — para consultar uso de banda além
disso, cada amostra coletada pelo mesmo poller de 5 minutos TAMBÉM é
gravada num banco SQLite próprio (`src/db/bandwidth-history.db.ts`, arquivo
configurado por `BANDWIDTH_HISTORY_DB_FILE`, separado do banco de
impressoras). Política de retenção (decisão de produto, não um limite
técnico do SQLite):

- **Pelo menos 48h de grão fino** (`bandwidth_samples`): uma linha por
  device/cliente a cada ciclo de 5 min, igual ao buffer em memória, só que
  persistida. "Pelo menos" porque o job só resume/apaga **horas completas**:
  uma hora que o corte de 48h parte no meio espera fechar, então na prática
  o grão fino vive entre 48h e 48h59min. Isso é intencional — resumir meia
  hora e apagar as amostras perderia a outra metade para sempre.
- **30 dias de grão por hora** (`bandwidth_hourly_rollup`): um job diário
  em segundo plano resume cada hora completa com mais de 48h num único
  delta de `rxBytes`/`txBytes` (a diferença entre a última e a primeira
  amostra daquela hora) e depois apaga as amostras finas de origem. Rollups
  com mais de 30 dias também são apagados. O delta vem como `null` (nunca
  como `0`) quando não há uso mensurável confiável: contador reiniciado no
  meio da hora, ou hora com uma única amostra (o poller esteve de pé só uma
  fração dela) — `0` ali afirmaria "não trafegou nada", que é diferente de
  "não foi medido".
- Uma falha de escrita no banco (poller ou job de rollup) é logada e
  ignorada — nunca derruba o buffer em memória nem o processo.

`GET /bandwidth/history/long-range` combina os dois trechos (fino + rollup)
numa única lista ordenada por tempo, no MESMO formato de
`/bandwidth/history/summary` (`{ intervalStart, intervalEnd, perDevice,
perClient }`, com `rxBytes`/`txBytes` já como diferença/uso, não valor
cumulativo) — o frontend consegue tratar os dois endpoints com o mesmo
parsing. Query params, todos opcionais:

| Param | Formato | Descrição |
|-------|---------|-----------|
| `mac` | MAC (`aa:bb:cc:dd:ee:ff`) | Filtra por um device/cliente específico. Sem ele, devolve todos. |
| `from` | ISO 8601 com offset | Início da janela. Sem ele, assume 30 dias atrás (a retenção inteira). |
| `to` | ISO 8601 com offset | Fim da janela. Sem ele, assume agora. |

`from`/`to` aceitam qualquer ISO 8601 válido, inclusive com offset de fuso
(`2026-05-01T08:00:00-03:00`) — são convertidos para UTC antes da consulta,
já que os timestamps são gravados e comparados em UTC.

> **Sem paginação (limitação conhecida).** Sem `mac`/`from`/`to`, a resposta
> é a janela inteira de 30 dias para TODOS os devices e clientes: na ordem
> de 720 intervalos horários + ~576 intervalos finos, cada um carregando uma
> entrada por device/cliente. Numa rede de algumas dezenas de dispositivos
> isso já é uma resposta de vários MB. É aceitável no escopo atual (rede
> pequena, uso interno, endpoint autenticado), mas quem consome deve
> **sempre mandar `from`/`to` e, de preferência, `mac`**. Se a rede crescer
> ou o frontend começar a chamar isso sem filtro, o próximo passo é
> paginação/agregação server-side — não foi implementado aqui de propósito,
> para não inventar um contrato de paginação que ninguém pediu ainda.

O comando clássico `block-sta`/`unblock-sta` não valida o MAC — se você
mandar bloquear um MAC que o controller nunca viu na rede, ele cria um
registro "fantasma" de cliente novo (já bloqueado) em vez de recusar (isso
foi observado contra um controller real). Por isso, antes de bloquear ou
desbloquear, o backend confere se o MAC já é um cliente conhecido (via
`/rest/user`) e retorna `404` se não for, sem chegar a mandar o comando.

Sem `UNIFI_CONTROLLER_USER`/`UNIFI_CONTROLLER_PASSWORD` configurados:
- `POST /clients/:mac/block` e `/unblock` retornam `503` com uma mensagem
  explicando o que falta configurar.
- `GET /clients` continua funcionando normalmente, mas o campo `blocked`
  de cada cliente fica sempre `false` (limitação: sem a API clássica não
  há como saber o status real de bloqueio).

**Atenção**: ao contrário da Integration API oficial, esta é uma API
**não-documentada/privada** do UniFi — pode mudar de formato ou
comportamento sem aviso em atualizações de firmware do controller.

### Power-cycle de porta (switches PoE)

A UniFi Network Integration API **não suporta** habilitar/desabilitar porta
de switch remotamente — isso foi testado contra um controller real: o
controller responde 400 com `Invalid $.action value '...' (valid values:
'POWER_CYCLE')`. A única ação de porta suportada é `POWER_CYCLE` (ciclo de
energia PoE), que efetivamente reinicia qualquer equipamento PoE ligado
naquela porta (ex.: um AP mexido fisicamente).

Fluxo: `GET /devices/:id?siteId=...` retorna o detalhe do dispositivo,
incluindo `interfaces.ports` (lista de portas com `idx`, `state` UP/DOWN,
`speedMbps`) quando o device é um switch. Note que isso é diferente do
campo `interfaces` da listagem (`GET /devices`), que ali é só um array de
strings de capacidade (ex.: `["ports"]"`) — os dois endpoints usam o mesmo
nome de campo com formatos diferentes.

Para power-cycle-ar uma porta específica:

```
POST /devices/:id/ports/:portIdx/power-cycle?siteId=...
```

### Histórico de eventos

`GET /events/history?limit=N` devolve os últimos eventos recebidos do
controller (`data: [{ receivedAt, data }]`, `data` é o payload cru do
evento). **Isso não é um histórico persistente**: é um buffer em memória de
até 200 eventos, que zera a cada restart do processo e só é alimentado
enquanto a conexão WebSocket com o controller está ativa — que por sua vez
só existe enquanto pelo menos um cliente está (ou esteve nos últimos 10s)
conectado em `/ws/events`. Se ninguém abriu o dashboard, não há histórico
pra consultar depois. `limit` é opcional e é limitado a 200.

### Múltiplos sites

Se o seu controller gerencia mais de um site (ex: várias filiais, cada uma
com seus próprios APs), use `GET /sites` para descobrir os IDs disponíveis
e passe `?siteId=<id>` em `/clients`, `/devices` e `/devices/:id/restart`
para apontar para um site específico. Sem o parâmetro, as rotas caem no
`SITE_ID` configurado no `.env`. `POST /clients/:mac/block` e `/unblock`
não aceitam `?siteId=` — eles usam a API clássica, que aponta sempre para
`UNIFI_CONTROLLER_SITE` (ver seção **Bloquear/desbloquear clientes**).

### Segurança e auditoria

Três rotas, todas via a mesma API clássica/privada usada em
**Bloquear/desbloquear clientes** (reaproveita a sessão por cookie+CSRF já
existente — nenhuma sessão nova é criada). Testadas manualmente contra um
controller real (UDM, UniFi OS 10.5.67, Network app):

```
GET /security/summary
```
Resumo do Threat Management/IPS e de firmware desatualizado, lido de
`GET /proxy/network/v2/api/site/{site}/aggregated-dashboard?historySeconds=86400`
(janela fixa de 24h, não configurável por enquanto):
```json
{
  "threatsDetected": 0,
  "ipsEnabled": true,
  "signaturesActive": 32876,
  "upgradableDeviceCount": 0
}
```

```
GET /security/events
```
Feed de eventos/alarmes críticos, lido de
`POST /proxy/network/v2/api/site/{site}/system-log/critical` (corpo `{}`).
Retorna `{ "data": [...] }` com o array **cru** do controller — o formato
de cada item **não é conhecido**: no ambiente de teste o array veio sempre
vazio (sem eventos críticos no momento), então não foi possível observar o
schema completo de um item real. Por isso o backend tipa isso como
`Record<string, unknown>[]` (sem assumir nenhum campo específico) e o
frontend renderiza de forma defensiva (tenta `msg`/`message`/`key`/`type`
e cai para um JSON resumido), no mesmo espírito de `Events.tsx` para o
histórico de eventos do WebSocket.

```
GET /security/admins
```
Lista de admins do controller com seus papéis/permissões, lida de
`GET /proxy/network/api/stat/admin`. Existe uma alternativa,
`GET /proxy/users/api/v2/users/admin/uos` (prefixo `/proxy/users/`, API de
usuários a nível de sistema do UniFi OS), mas escolhemos `stat/admin`
porque ele reaproveita exatamente o mesmo padrão de sessão/base URL já
usado no resto de `unifi-classic.service.ts` — menos código novo, mesmo
prefixo `/proxy/network/`.

Assim como block/unblock, as três rotas retornam `503` se
`UNIFI_CONTROLLER_USER`/`UNIFI_CONTROLLER_PASSWORD` não estiverem
configurados no `.env`.

**Não implementado — log de login de administrador**: não foi encontrado
nenhum endpoint confiável para consultar o histórico de login de
administradores no controller (pesquisa extensiva, incluindo testes
diretos contra um controller real). Não está disponível nesta versão do
controller.

### Log de auditoria do dashboard

```
GET /security/audit-log?limit=...
```

Diferente de `/security/*` acima (que audita o **controller UniFi**), esta
rota audita o **próprio dashboard**: quem fez o quê por aqui — bloqueio/
desbloqueio de cliente, restart de device, power-cycle de porta, rotação de
senha SSH, criação/remoção de rede Wi-Fi ou VLAN, IP fixo. Não depende da
API clássica — funciona mesmo sem `UNIFI_CONTROLLER_USER`/`PASSWORD`
configurados.

Implementado como um hook global (`onResponse` em `src/app.ts`) em vez de
instrumentar rota por rota: toda requisição autenticada com método
diferente de `GET`/`HEAD`/`OPTIONS` (exceto `/auth/*`, que ainda não tem um
ator autenticado) é registrada automaticamente, sucesso ou falha. `HEAD`
está fora junto de `GET` porque é semanticamente a mesma leitura (o Fastify
registra `HEAD` automaticamente pra toda rota `GET`) — um health check
externo batendo `HEAD` a cada 10s encheria o buffer de 500 entradas em
pouco mais de uma hora e empurraria as ações reais pra fora da janela
visível na rota. Cada entrada
tem `{ timestamp, actor, method, route, params, statusCode }` — `actor` é
o `sub` do JWT (hoje sempre o mesmo, já que só existe um usuário do
dashboard; fica pronto para quando houver múltiplos), `route` é o padrão
da rota (ex: `/clients/:mac/block`, não a URL com o MAC já preenchido
embutido nela) e `params` traz só os parâmetros de **path** (ids/macs) —
o corpo da requisição nunca é gravado, porque poderia conter senha/
passphrase (ex: `POST /wifi`, `POST /ssh-credentials/rotate`).

Ao contrário dos buffers de eventos (`/events/history`) e banda
(`/bandwidth/history`), que são só em memória, este log também é
persistido em disco (`AUDIT_LOG_FILE`, padrão `./audit.log`, uma linha
JSON por entrada, append-only) — um log de auditoria que some a cada
restart não serve pra investigar um incidente depois. Em memória, o
buffer guarda até 500 entradas (o mesmo teto é aplicado ao reconstruir o
buffer a partir do arquivo na subida do processo); no arquivo, o
histórico cresce indefinidamente — não há rotação automática, se isso
importar no seu ambiente, rotacione `AUDIT_LOG_FILE` externamente (ex:
`logrotate`).

**O arquivo é a fonte de verdade completa; a memória é só um cache.**
Consequências práticas, todas conhecidas e aceitas:

- `GET /security/audit-log` **nunca devolve mais que 500 entradas**, mesmo
  com `?limit=10000` e mesmo que o arquivo em disco tenha o histórico
  inteiro — `limit` acima do teto é silenciosamente reduzido a 500. Pra
  investigar mais fundo, leia o `AUDIT_LOG_FILE` direto (uma linha JSON por
  ação, `jq` resolve). Uma leitura paginada por disco na rota seria a
  correção completa, mas exigiria ler um arquivo sem limite de tamanho a
  cada request — fica pra quando houver necessidade real.
- **Single-process.** O buffer é por processo: duas instâncias apontando pro
  mesmo `AUDIT_LOG_FILE` dão duas visões parciais e divergentes via API (e
  as escritas concorrentes no mesmo arquivo não têm garantia de
  atomicidade em todo sistema de arquivos). O arquivo segue recebendo tudo.
- Uma linha ilegível no arquivo (última linha truncada por um crash no meio
  do append, edição manual, `logrotate` cortando no meio) é **descartada
  individualmente** na subida do processo, com aviso no log de quantas
  foram — as demais entradas continuam carregando normalmente, e o arquivo
  não é alterado.
- Se o append em disco falhar, a ação continua visível no buffer em memória
  (ela aconteceu de verdade) e o erro vai pro log — mas essa entrada não
  sobrevive ao próximo restart.

### Credencial de administração/SSH dos equipamentos (APs/switches)

Duas rotas, via a mesma API clássica/privada usada nas seções acima
(reaproveita a sessão por cookie+CSRF já existente). Confirmado contra um
controller real, incluindo um PUT no-op que devolveu os mesmos valores sem
mudar nada de verdade.

**Importante — é uma credencial ÚNICA POR SITE, não por device.** No UniFi,
o usuário e a senha de SSH usados para acessar via linha de comando um
AP/switch adotado ficam guardados numa única configuração do site
(`"key": "mgmt"` em `GET /proxy/network/api/s/{site}/get/setting`), aplicada
a **todos** os APs/switches adotados daquele site de uma vez. Não existe
senha de SSH separada por dispositivo nesse contexto — trocar a senha aqui
troca o acesso SSH de toda a infraestrutura adotada do site simultaneamente.

```
GET /ssh-credentials
```
Retorna só os campos não-sensíveis:
```json
{ "sshEnabled": true, "sshUsername": "9KYZHt6", "passwordAuthEnabled": true }
```
Esta rota **nunca** retorna a senha atual (nem em hash) nem qualquer outro
segredo do objeto `mgmt` (`x_api_token`, `x_mgmt_key`) — não há forma de
recuperar a senha em uso pelo dashboard.

```
POST /ssh-credentials/rotate
Body: { "username"?: string, "password"?: string }  // ambos opcionais
```
Troca a senha de SSH de todos os APs/switches adotados do site. Se
`password` não for informado, uma senha forte aleatória é gerada com
`node:crypto` (`randomBytes`, 24 bytes em base64url, 32 caracteres). Se
`username` não for informado, mantém o usuário atual. Sob o capô, busca o
objeto `mgmt` completo, troca só os campos de usuário/senha preservando
**todos** os outros campos exatamente como vieram do GET, e manda de volta
via `PUT /proxy/network/api/s/{site}/set/setting/mgmt/{_id}` (PUT de objeto
inteiro — omitir um campo o apagaria/zeraria no controller).

**A resposta desta rota é a ÚNICA vez que a senha nova aparece em texto
puro em qualquer lugar da API:**
```json
{ "sshUsername": "9KYZHt6", "sshPassword": "<senha nova, texto puro>" }
```
Quem chamar precisa copiar/guardar a senha na hora — não existe outra rota
(nem no backend, nem no dashboard) que devolva essa senha depois. Se ela for
perdida, a única forma de recuperar o acesso é gerar outra senha nova (que
por sua vez também só aparece uma única vez).

No frontend (`Security.tsx`), a senha nova só fica no estado do próprio
componente React — nunca é salva em `localStorage`/`sessionStorage` nem em
nenhum lugar persistente, e some ao recarregar a página ou navegar para
outra tela.

Assim como as demais rotas da API clássica, retorna `503` se
`UNIFI_CONTROLLER_USER`/`UNIFI_CONTROLLER_PASSWORD` não estiverem
configurados no `.env`.

### Saúde operacional (APs/switches, sinal Wi-Fi e uptime do WAN)

Três rotas, todas via a mesma API clássica/privada usada nas seções acima
(reaproveita a sessão por cookie+CSRF já existente). Testadas manualmente
contra um controller real:

```
GET /health/devices
```
Saúde de cada AP/switch, lida de `POST /proxy/network/api/s/{site}/stat/device`
(corpo `{}`, retorna todos os devices do site). `cpu`/`mem` são convertidos
de string para number (o controller retorna algo como `"2.6"`, já em
porcentagem); `uptimeSeconds` vem em segundos; `radios` só existe em APs
(switches puros retornam array vazio) e traz canal, utilização do canal
(`channelUtilizationPct`, em %) e um score de satisfação de 0–100
(`satisfactionScore`, ou `-1` quando o controller não tem dados
suficientes):
```json
{
  "data": [
    {
      "mac": "aa:bb:cc:dd:ee:ff",
      "name": "AP Sala",
      "cpu": 2.6,
      "mem": 32.9,
      "uptimeSeconds": 208615,
      "clientCount": 3,
      "radios": [
        { "name": "rai0", "channel": 157, "channelUtilizationPct": 4, "satisfactionScore": 95, "clientCount": 3 }
      ]
    }
  ]
}
```

```
GET /health/clients-signal
```
Força de sinal de cada cliente Wi-Fi conectado agora, lida de
`GET /proxy/network/api/s/{site}/stat/sta` (mesmo endpoint clássico de
clientes, mas com muito mais detalhe que a Integration API). Filtra fora
os clientes com fio (`is_wired: true`) — eles não têm campos de sinal.
`signalDbm` é a métrica principal pra UI (dBm, negativo — mais perto de 0 é
melhor); `rssi` é um valor relativo sem unidade padronizada, incluído só
como dado bruto adicional:
```json
{ "data": [{ "mac": "11:22:33:44:55:66", "hostname": "iPhone", "signalDbm": -64, "rssi": 32, "satisfactionScore": 100, "channel": 60 }] }
```

```
GET /health/wan-uptime
```
Histórico de saúde do WAN/gateway nas últimas 24h, lido do mesmo endpoint
`GET /proxy/network/v2/api/site/{site}/aggregated-dashboard?historySeconds=86400`
já usado em `GET /security/summary` (mas aqui extraindo `wan_history` em vez
de `cybersecure`/`upgradable_device_count`). Retorna `wan_history_details`
cru — um array (tipicamente um item por WAN, ex: WAN1/WAN2 em setups com
failover) com `health_history` (~1 ponto a cada 5 minutos, já mantido pelo
próprio controller) e `downtime_history` (períodos de queda real, se
houver):
```json
{
  "data": [
    {
      "downtime_history": [],
      "health_history": [
        { "timestamp": 1787770800000, "wan_downtime": false, "high_latency": false, "packet_loss": false }
      ]
    }
  ]
}
```

**Importante — sem persistência própria**: os três endpoints acima leem
dados que o próprio controller já mantém internamente (o histórico de 24h
do WAN, por exemplo, vem pronto do `aggregated-dashboard`). Nenhum dado é
armazenado por este backend. Uma futura funcionalidade de **histórico de
uso/banda por cliente ao longo do tempo** (além das últimas 24h que o
controller guarda) exigiria persistência própria (ex: um job periódico
salvando snapshots em um banco) — isso **não foi implementado** nesta
etapa, fica para uma fase posterior.

Assim como as rotas de segurança, as três retornam `503` se
`UNIFI_CONTROLLER_USER`/`UNIFI_CONTROLLER_PASSWORD` não estiverem
configurados no `.env`.

### Redes Wi-Fi (SSIDs), VLANs e IP fixo por cliente

Módulo de gestão de rede: criar/editar/remover redes Wi-Fi (SSIDs) e VLANs
(networks), e reservar um IP fixo por cliente. Contratos confirmados
diretamente no OpenAPI oficial da Integration API
(`https://developer.ui.com/network/v10.4.57/openapi.json`).

#### Wi-Fi (SSIDs) — API oficial

```
GET    /sites/{siteId}/wifi/broadcasts
GET    /sites/{siteId}/wifi/broadcasts/{id}
POST   /sites/{siteId}/wifi/broadcasts
PUT    /sites/{siteId}/wifi/broadcasts/{id}
DELETE /sites/{siteId}/wifi/broadcasts/{id}
```

`PUT` substitui o objeto inteiro (não é PATCH parcial). Por isso, trocar
senha (`PATCH /wifi/:id/password`) e habilitar/desabilitar
(`PATCH /wifi/:id/enabled`) fazem, internamente, `GET` do broadcast atual +
troca do campo pedido + `PUT` do objeto inteiro de volta, preservando todo
o resto exatamente como estava (`unifiService.updateWifiBroadcastPassword`
e `setWifiBroadcastEnabled` em `src/services/unifi.service.ts`).

`POST /wifi` cria uma rede padrão (`type: STANDARD`,
`securityConfiguration.type: WPA2_PERSONAL`) com este payload mínimo
enviado ao controller (todos os campos são obrigatórios pelo schema
oficial, mais dois campos **confirmados como obrigatórios contra um
controller real** apesar de o schema OpenAPI não os marcar como tal —
ver observação abaixo):

```json
{
  "type": "STANDARD",
  "name": "Escritório",
  "enabled": true,
  "hideName": false,
  "channel2gLockedTo6": false,
  "clientIsolationEnabled": false,
  "dtimPeriod2gLockedTo3": false,
  "multicastToUnicastConversionEnabled": false,
  "uapsdEnabled": false,
  "advertiseDeviceName": false,
  "arpProxyEnabled": false,
  "bssTransitionEnabled": true,
  "broadcastingFrequenciesGHz": [2.4, 5],
  "network": { "type": "NATIVE" },
  "securityConfiguration": { "type": "WPA2_PERSONAL", "passphrase": "senha1234", "fastRoamingEnabled": false }
}
```

O corpo aceito por `POST /wifi` do dashboard é só `{ name, passphrase,
hideName?, clientIsolationEnabled? }` — o resto dos defaults acima é
preenchido pelo backend. `passphrase` é validado com 8 a 63 caracteres
(mesmo limite do schema oficial), tanto na criação quanto em
`PATCH /wifi/:id/password`.

**Testado contra um controller real** (criação e remoção de um SSID de
teste): sem `network: { type: "NATIVE" }` e sem
`securityConfiguration.fastRoamingEnabled: false`, o controller rejeita a
criação com `400`:
```
WPA2 personal security requires exactly one of [preshared keys setting,
all of [network setting, passphrase setting]], WPA security combined with
standard WiFi requires fast roaming setting
```
`network` é a referência à network associada ao SSID — `{ type: "NATIVE"
}` é o valor mínimo válido (observado na maioria das redes Wi-Fi reais via
`GET /wifi/broadcasts`). `fastRoamingEnabled` é obrigatório porque
`bssTransitionEnabled: true` está fixo no payload.

**Limite de hardware — "too many WiFi broadcasts"**: mesmo com o payload
acima 100% correto (confirmado — o erro deixou de ser sobre o schema e
passou a ser sobre capacidade), `POST /wifi` pode falhar com `400` e uma
mensagem do tipo `"too many WiFi broadcasts assigned to the device with
id=..."`. Isso **não é um bug do dashboard**: é o controller recusando
porque os APs do site já estão no limite de SSIDs simultâneos que o rádio
suporta (geralmente 4-8, dependendo do modelo). Pra criar uma rede nova
nesse cenário, é preciso primeiro remover/desabilitar um SSID existente
num dos APs afetados — não há como contornar isso via API.

#### Wi-Fi Enterprise / RADIUS (802.1X) — API oficial

```
GET /sites/{siteId}/radius/profiles
```

Perfis RADIUS (ex: um apontando pra um servidor NPS no Active Directory)
são **somente leitura via API** — o OpenAPI oficial só expõe `GET
/sites/{siteId}/radius/profiles`, não existe `POST`/`PUT`/`DELETE` para
essa rota. Um perfil precisa ser cadastrado manualmente no painel do UniFi
(Settings > Profiles > RADIUS) antes de poder ser referenciado por uma
rede Wi-Fi criada por este dashboard. `GET /wifi/radius-profiles` expõe a
listagem simplificada (`{ data: [{ id, name }] }`, sem o campo `metadata`
que o controller também retorna) usada pelo select do frontend.

Para criar uma rede Wi-Fi Enterprise, `POST /wifi` aceita, além do formato
existente (`{ name, passphrase, hideName?, clientIsolationEnabled? }`),
este segundo formato:

```json
{
  "name": "Corporativa",
  "securityType": "WPA2_ENTERPRISE",
  "radiusProfileId": "570795ab-cd0c-4c7c-903d-3df45fc5d877",
  "hideName": false,
  "clientIsolationEnabled": false
}
```

`securityType` aceita `WPA2_ENTERPRISE`, `WPA3_ENTERPRISE` ou
`WPA2_WPA3_ENTERPRISE`; `radiusProfileId` é o `id` de um perfil retornado
por `GET /wifi/radius-profiles`. A validação (Zod, `superRefine` em vez de
`z.discriminatedUnion` — necessário porque o formato histórico não envia
`securityType`, e o discriminador do Zod exigiria o campo sempre presente
no corpo bruto) rejeita tanto `radiusProfileId` ausente quando
`securityType` é Enterprise quanto a mistura de `passphrase` com
`securityType`/`radiusProfileId` no mesmo corpo.

O `securityConfiguration` enviado ao controller pra cada `securityType`
segue os schemas oficiais
`IntegrationWifiWpa2EnterpriseSecurityConfigurationDetailDto` /
`...Wpa3Enterprise...` / `...Wpa2Wpa3Enterprise...`, todos com
`radiusConfiguration: { profileId, nasId }`
(`IntegrationWifiEnterpriseRadiusConfigurationDto`, com `profileId` e
`nasId` **ambos obrigatórios**). O schema mínimo usado pelo backend
(`buildEnterpriseSecurityConfiguration` em `src/routes/networks.routes.ts`):

```json
{
  "type": "WPA2_ENTERPRISE",
  "coaEnabled": false,
  "fastRoamingEnabled": false,
  "radiusConfiguration": {
    "profileId": "<uuid do perfil RADIUS>",
    "nasId": { "type": "DERIVED", "source": "BSSID" }
  }
}
```

`nasId` é a única parte não documentada com clareza pelo OpenAPI (o schema
"Wifi Radius NAS ID configuration" é uma união discriminada por `type`:
`DERIVED`, que exige `source` — um entre `DEVICE_MAC_ADDRESS`,
`DEVICE_NAME`, `SITE_NAME`, `BSSID` — e tira o NAS-Identifier
automaticamente; ou `USER_DEFINED`, que exige um `value` livre). O valor
usado aqui, `{ type: "DERIVED", source: "BSSID" }`, foi confirmado contra
uma rede Enterprise real já em produção neste ambiente
("Evok-Corporativa", `WPA2_WPA3_ENTERPRISE`, configurada manualmente pelo
usuário antes deste módulo existir) — o controller aceita e usa esse valor
sem exigir nenhuma configuração manual adicional, por isso é o único valor
usado pelo backend (o frontend não pede isso no formulário).

`WPA3_ENTERPRISE` adiciona `securityMode: "DEFAULT"` (obrigatório pelo
schema oficial; a outra opção é `HIGH_SECURITY_192_BIT`).
`WPA2_WPA3_ENTERPRISE` adiciona `pmfMode: "OPTIONAL"` e
`wpa3FastRoamingEnabled: false` (ambos obrigatórios pelo schema oficial
desse tipo). `macAuthenticationConfiguration` (também aceito pelo schema
de `radiusConfiguration`) não é usado por este módulo.

Como perfis RADIUS não podem ser criados via API, este módulo **nunca cria
nem edita nada no NPS/Active Directory** — ele só referencia, por
`profileId`, um perfil que o usuário já configurou manualmente no painel
do UniFi apontando pro RADIUS existente.

#### Networks (VLANs) — API oficial

```
GET    /sites/{siteId}/networks
GET    /sites/{siteId}/networks/{id}
POST   /sites/{siteId}/networks
DELETE /sites/{siteId}/networks/{id}
```

`POST /networks` cria uma VLAN gerenciada pelo gateway
(`management: GATEWAY`) com este payload mínimo:

```json
{
  "management": "GATEWAY",
  "name": "IoT",
  "enabled": true,
  "vlanId": 10,
  "cellularBackupEnabled": false,
  "internetAccessEnabled": true,
  "isolationEnabled": false,
  "zoneId": "749f84e7-7347-42c4-8f69-ec2632823809",
  "ipv4Configuration": {
    "autoScaleEnabled": false,
    "hostIpAddress": "10.30.0.1",
    "prefixLength": 24,
    "dhcpConfiguration": {
      "mode": "SERVER",
      "ipAddressRange": { "start": "10.30.0.10", "stop": "10.30.0.254" },
      "leaseTimeSeconds": 86400,
      "pingConflictDetectionEnabled": false
    }
  }
}
```

O corpo aceito por `POST /networks` do dashboard é `{ name, vlanId,
hostIpAddress, prefixLength, internetAccessEnabled?, isolationEnabled?,
zoneId? }`. `vlanId` é validado entre 2 e 4009 (1 é reservado pra rede
default) e `hostIpAddress` precisa ser um IPv4 válido. Não há `PUT`
documentado neste endpoint no OpenAPI oficial consultado — por isso este
módulo só cobre criar/listar/remover VLAN, sem edição.

**Testado contra um controller real** (criação e remoção de uma VLAN de
teste): o OpenAPI oficial declara `ipAddressRange`, `leaseTimeSeconds`,
`pingConflictDetectionEnabled` (dentro de `dhcpConfiguration`) e `zoneId`
(no nível do corpo da network) como opcionais, mas o controller rejeita a
criação com `400` sem eles:
```
ipv4Configuration.dhcpConfiguration.ipAddressRange must not be null,
ipv4Configuration.dhcpConfiguration.leaseTimeSeconds must not be null,
ipv4Configuration.dhcpConfiguration.pingConflictDetectionEnabled must not
be null
```
e, separadamente, `zoneId must not be null`.

`leaseTimeSeconds: 86400` (24h) e `pingConflictDetectionEnabled: false`
são valores fixos razoáveis. `ipAddressRange` (`{ start, stop }`) é
**calculado a partir do `hostIpAddress`/`prefixLength`** informados
(função `computeDhcpRange` em `src/routes/networks.routes.ts`): começa 10
endereços depois do início da sub-rede (deixando espaço pro gateway e IPs
fixos manuais) e termina um endereço antes do broadcast — ex: para
`10.30.0.1/24` o range calculado é `10.30.0.10`–`10.30.0.254`. Em
sub-redes muito pequenas o cálculo colapsa para o menor intervalo válido
em vez de gerar um range invertido.

`zoneId` é o id de uma **zona de firewall** existente (`GET
/sites/{siteId}/firewall/zones`, agora exposto neste dashboard como `GET
/networks/zones` — resposta `{ data: [{ id, name, networkIds, metadata
}] }`). Se o corpo de `POST /networks` não informar `zoneId`
explicitamente, o backend busca as zonas do site e usa a que se chama
**"Internal"** como default (é a zona usada pelas networks LAN comuns
observadas em ambientes reais — equivalente a "Trusted"). Se não existir
nenhuma zona chamada "Internal" nesse site, a criação falha com `502` e
uma mensagem pedindo pra informar `zoneId` explicitamente — em vez de
mandar `zoneId: null` de novo pro controller. O frontend busca as zonas
disponíveis e deixa escolher no formulário de criação de VLAN (com
"Internal" pré-selecionado quando existir), pra quem precisar de outra
zona (ex: DMZ) não ficar preso ao default.

**`DELETE` com corpo vazio**: confirmado contra um controller real,
`DELETE /wifi/broadcasts/{id}` e `DELETE /networks/{id}` respondem `200`
(não `204`) com corpo **completamente vazio** (sem `Content-Type`, sem
nenhum byte). `unifiFetch` (em `src/services/unifi.service.ts`) lê o corpo
como texto antes de decidir se há algo pra parsear como JSON — em vez de
assumir que só `204` vem sem corpo — justamente por causa desse caso.

**Consistência eventual após deletar uma VLAN**: por alguns segundos
depois de um `DELETE /networks/:id` bem-sucedido, `GET /networks` pode
responder com um erro transitório do próprio controller (`422
api.firewall.zone.network-does-not-exist`) antes de se estabilizar
sozinho. Isso é comportamento do controller (não deste backend) — se a
listagem de VLANs falhar logo depois de deletar uma, tente de novo em
alguns segundos.

#### IP fixo por cliente — API clássica

A Integration API oficial **não tem** o conceito de IP fixo/reserva de
DHCP — ele só existe no registro do cliente na API clássica (a mesma
usada para bloquear/desbloquear, ver seção acima), nos campos
`use_fixedip`/`fixed_ip`:

```
PUT /proxy/network/api/s/{site}/rest/user/{clientObjectId}
Body: { "use_fixedip": true, "fixed_ip": "172.16.0.50", "network_id": "<opcional>" }
```

`{clientObjectId}` é o campo `_id` do registro do cliente em
`GET /rest/user` — o mesmo lookup por MAC já usado pelo bloqueio
(`unifiClassicService`) é reaproveitado para achar esse `_id` antes do
`PUT`. `PATCH /clients/:mac/fixed-ip` aceita `{ enabled: boolean, ip?:
string, networkId?: string }` — `ip` é obrigatório (e validado como IPv4)
quando `enabled: true`; para desligar o IP fixo, basta `{ enabled: false }`.
Mesmas regras de MAC desconhecido (`404`) e API clássica não configurada
(`503`) do bloqueio de clientes se aplicam aqui.

## Conectando no WebSocket de eventos

O token JWT **não** vai mais na query string (evita expor em access logs de
proxy/CDN). Conecte sem token e mande-o como primeira mensagem:

```js
const ws = new WebSocket('wss://seu-host/ws/events');
ws.onopen = () => ws.send(JSON.stringify({ token: meuJwt }));
ws.onmessage = (event) => console.log(JSON.parse(event.data));
```

Se a primeira mensagem não chegar em 5s, ou o token for inválido, a conexão
é fechada com o código `1008`.

## Testes

```
npm test          # roda uma vez
npm run test:watch
```

Cobertura inclui validação de MAC/paginação, health check, guarda de auth,
login/refresh, e as rotas de `/clients`, `/devices`, `/sites`,
`/events/history` e `/security/*` com
`unifiService`/`unifiEventsHub`/`unifiClassicService` mockados. O handshake
de `/ws/events` também tem teste (token válido, token inválido, mensagem
sem token, canal somente-leitura após autenticar, e o fechamento com `1008`
por timeout de 5s sem nenhuma mensagem), usando um socket TCP real
(`app.listen()` + cliente `ws`) em vez do helper `app.injectWS()` do
`@fastify/websocket` — esse helper trava com a combinação de plugins deste
app (ver comentário em `tests/integration/websocket.test.ts`). O teste de
timeout não espera 5s de verdade: usa fake timers do Vitest com
`toFake: ['setTimeout', 'clearTimeout']` e `shouldAdvanceTime: true`
(ativados antes de conectar, já que o timer nasce no servidor no momento da
conexão) e avança o relógio com `vi.advanceTimersByTimeAsync(5000)`,
deixando o I/O do socket real intacto.

### Testes end-to-end (Playwright)

```
npx playwright install chromium   # só na primeira vez
npm run test:e2e
```

Sobe três processos isolados dos de desenvolvimento normal (backend real na
porta 3100, frontend real na porta 5273) apontando para um **controller
UniFi fake local** (`e2e/fake-controller/server.mjs`, HTTPS autoassinado na
porta 8443, estado em memória) — nunca para um controller de verdade. As
env vars de `CONTROLLER_HOST` etc. são passadas explicitamente pelo
`playwright.config.ts` e sempre vencem qualquer valor do `.env` real
(dotenv não sobrescreve variáveis já presentes no ambiente do processo).

Cobre um fluxo real por área sensível, clicando na UI de verdade (não
chamando a API diretamente): login → bloquear/desbloquear um cliente
(`e2e/tests/clients.spec.ts`), login → rotacionar credencial SSH e
confirmar que o segredo some da tela e do storage ao navegar
(`e2e/tests/ssh-rotation.spec.ts`), e criar → remover uma rede Wi-Fi
(`e2e/tests/wifi.spec.ts`). O fake controller reproduz peculiaridades já
confirmadas contra um controller real (ex: `DELETE /wifi/broadcasts/{id}`
respondendo 200 com corpo vazio).

## Deploy com Docker

```
docker build -t unifi-dashboard-api .
docker run -d --env-file .env -p 3000:3000 unifi-dashboard-api
```

## ⚠️ Antes de usar de verdade

- Os nomes de campo e caminhos de endpoint da API de Integração podem
  variar por versão do controller — confira o schema real na própria UI
  do controller antes de confiar cegamente nos tipos em
  `src/types/unifi.ts` e no caminho usado em `src/plugins/websocket.ts`.
- Rode isso atrás de Tailscale, WireGuard, ou Cloudflare Tunnel + Access —
  nunca exponha esse serviço direto na internet sem uma camada de rede
  própria na frente.
- Troque `JWT_SECRET` por um valor aleatório e longo antes de ir pra
  produção.
