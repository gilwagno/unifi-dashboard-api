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
sem token, canal somente-leitura após autenticar), usando um socket TCP
real (`app.listen()` + cliente `ws`) em vez do helper `app.injectWS()` do
`@fastify/websocket` — esse helper trava com a combinação de plugins deste
app (ver comentário em `tests/integration/websocket.test.ts`). O
fechamento por timeout de 5s sem mensagem não é coberto (exigiria esperar
os 5s de verdade no teste).

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
