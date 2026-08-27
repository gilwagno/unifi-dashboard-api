# UniFi Dashboard API

Backend em Fastify/TypeScript para controlar clientes e APs UniFi
(bloquear/desbloquear dispositivos, reiniciar APs, ver status) via a API
local de Integração do controller.

## Setup

1. No controller: **Settings > Control Plane > Integrations** → gere uma
   API key.
2. Copie `.env.example` para `.env` e preencha os valores.
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
| POST   | /devices/:id/restart?siteId=... | Reinicia um dispositivo           |
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

Cobertura atual é um esqueleto (validação de MAC, health check, guarda de
auth, login) — pense nisso como o padrão a seguir, não como suite completa.
As rotas de `/clients` e `/devices` que chamam a API do UniFi de verdade
ainda não têm teste, porque isso exige mockar `unifiService` — vale
adicionar conforme o projeto crescer.

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
