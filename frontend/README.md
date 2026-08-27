# UniFi Ops Dashboard (frontend)

SPA em React + Vite + Tailwind que consome a [unifi-dashboard-api](../README.md).

## Rodando

Com o backend já rodando em `http://localhost:3000` (veja o README na raiz):

```
npm install
npm run dev
```

Abre em `http://localhost:5173`. Em dev, `/api/*` é redirecionado (proxy do
Vite, ver `vite.config.ts`) para `http://localhost:3000`, então não precisa
lidar com CORS nem apontar URL de API manualmente.

Login: usuário/senha configurados em `ADMIN_USER`/`ADMIN_PASSWORD_HASH` no
`.env` do backend.

## Build de produção

```
npm run build
```

Gera `dist/`. Como é uma SPA estática, sirva com qualquer servidor de
arquivos (ou o próprio Fastify, com um plugin de static files) — mas nesse
caso configure o proxy/reverse proxy pra rotear `/api` pro backend, já que
o `vite.config.ts` só faz proxy em dev (`npm run dev`).
