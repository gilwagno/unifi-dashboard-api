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
| POST   | /auth/login                    | Retorna um JWT                    |
| GET    | /sites                         | Lista os sites do controller      |
| GET    | /clients?siteId=...            | Lista clientes conectados         |
| POST   | /clients/:mac/block?siteId=...  | Bloqueia um cliente               |
| POST   | /clients/:mac/unblock?siteId=... | Desbloqueia um cliente            |
| GET    | /devices?siteId=...            | Lista APs/switches de um site     |
| POST   | /devices/:id/restart?siteId=... | Reinicia um dispositivo           |
| WS     | /ws/events?token=...            | Stream de eventos em tempo real   |

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
