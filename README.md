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

## Endpoints

| Método | Rota                          | Descrição                        |
|--------|--------------------------------|-----------------------------------|
| POST   | /auth/login                    | Retorna um access token + refresh token |
| POST   | /auth/refresh                  | Troca um refresh token por um novo access token |
| GET    | /sites                         | Lista os sites do controller      |
| GET    | /clients?siteId=&blocked=&type=&page=&pageSize= | Lista clientes conectados (filtros + paginação) |
| POST   | /clients/:mac/block?siteId=...  | Bloqueia um cliente               |
| POST   | /clients/:mac/unblock?siteId=... | Desbloqueia um cliente            |
| GET    | /devices?siteId=&page=&pageSize= | Lista APs/switches de um site (paginado) |
| GET    | /devices/:id?siteId=...         | Detalhe de um dispositivo (inclui portas, se houver) |
| POST   | /devices/:id/restart?siteId=... | Reinicia um dispositivo           |
| POST   | /devices/:id/ports/:portIdx/power-cycle?siteId=... | Power-cycle de uma porta PoE (reboot do que estiver ligado nela) |
| WS     | /ws/events?token=...            | Stream de eventos em tempo real   |
| GET    | /events/history?limit=...      | Últimos eventos recebidos (buffer em memória) |

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
e passe `?siteId=<id>` em `/clients`, `/clients/:mac/block`,
`/clients/:mac/unblock`, `/devices` e `/devices/:id/restart` para apontar
para um site específico. Sem o parâmetro, as rotas caem no `SITE_ID`
configurado no `.env`.

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
login/refresh, e as rotas de `/clients`, `/devices`, `/sites` e
`/events/history` com `unifiService`/`unifiEventsHub` mockados. O handshake
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
