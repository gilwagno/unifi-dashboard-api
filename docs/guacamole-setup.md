# Guacamole — como subir (subtarefa 1 da Onda 4)

> Infraestrutura, não código de aplicação. O `docker-compose.yml` da raiz sobe os três
> componentes; este documento é o passo a passo e o porquê das decisões que o arquivo toma.

## Componentes

| serviço | imagem | porta publicada |
|---|---|---|
| `postgres` | `postgres:16-alpine` | **nenhuma** |
| `guacd` | `guacamole/guacd:1.5.5` | **nenhuma** |
| `guacamole` | `guacamole/guacamole:1.5.5` | `127.0.0.1:8080` |

`guacd` é quem realmente fala RDP/VNC/SSH; `guacamole` é a interface web + a **API REST** que
o `remote-access.service.ts` (subtarefa 3) vai consumir. O Postgres guarda conexões e usuários.

## Por que a porta é só loopback

`127.0.0.1:8080`, nunca `0.0.0.0`. A cadeia de acesso é
**Cloudflare Access → dashboard → Guacamole → RDP na LAN**. Publicar o Guacamole na LAN
contorna o login do dashboard **e a auditoria de sessão** — que é exatamente o rastro que este
módulo existe para produzir (quem acessou qual PC, quando). Se um dia o Guacamole precisar
rodar em outro host, o caminho certo é um túnel/proxy reverso autenticado, não abrir a porta.

## Por que um `.env` separado

O Compose usa `guacamole/.env`, **não** o `.env` da raiz:

1. O interpolador do Compose expande `$` nos **valores**. Uma senha do backend com `$` chega
   mutilada no container e ainda vaza um pedaço em warning no terminal — observado neste repo
   ao apontar o Compose para o `.env` da raiz.
2. Segredo de infraestrutura (banco do Guacamole) não é config da aplicação.

## Passo a passo

Pré-requisito: **o daemon do Docker precisa estar rodando**. Ter o `docker` no PATH não
basta — o Docker Desktop instalado e fechado dá
`failed to connect to the docker API at npipe:...` em todo comando.

```bash
# 1. Variáveis
cp guacamole/.env.example guacamole/.env
openssl rand -base64 32          # cole em GUACAMOLE_DB_PASSWORD

# 2. Schema do banco — gerado a partir da PRÓPRIA imagem, não copiado da internet.
#    São ~5k linhas de DDL; por isso guacamole/initdb.sql é gitignored.
docker run --rm guacamole/guacamole:1.5.5 \
  /opt/guacamole/bin/initdb.sh --postgresql > guacamole/initdb.sql

# 3. Subir
docker compose --env-file guacamole/.env up -d

# 4. Conferir
docker compose --env-file guacamole/.env ps
curl -sf http://127.0.0.1:8080/guacamole/ >/dev/null && echo "UI respondendo"
```

**O `initdb.sql` só é aplicado no primeiro boot**, com o volume `guacamole-db` vazio. Se o
schema mudar numa atualização de versão, o caminho é o upgrade oficial do Guacamole, não
apagar o volume — apagar o volume apaga todas as conexões e usuários.

## Primeiro login e o que fazer com ele IMEDIATAMENTE

O schema cria `guacadmin` / `guacadmin`. **Trocar essa senha é parte de subir o serviço, não
um passo opcional depois** — é a credencial que dá acesso à tela de qualquer máquina do
domínio. Mesmo regime do achado da senha em branco das HPs na Onda 2, com consequência maior.

Fluxo recomendado, a decidir junto com a subtarefa 3:
1. logar como `guacadmin`, trocar a senha;
2. criar o usuário de serviço que o backend usa na API REST (só as permissões que ele
   precisa — criar/listar/remover conexão, não administrar o Guacamole inteiro);
3. guardar essa credencial no `.env` da raiz (é config da aplicação), com o mesmo tratamento
   do segredo SNMP/SSH: nunca em resposta de rota, nunca em log.

## Versão fixada

`1.5.5` nos dois containers, propositalmente pinada. Subir de versão é mudança deliberada
(pode exigir migração de schema), não um `latest` que muda sozinho num `docker compose pull`.

## Teste de fumaça — EXECUTADO em 2026-09-15

O passo a passo acima foi rodado de verdade nesta bancada, não só validado por
`docker compose config`:

| verificação | resultado |
|---|---|
| `initdb.sql` gerado da imagem | **791 linhas, 23 tabelas** |
| `docker compose up -d` | 3 containers de pé; `postgres` **healthy** antes de o `guacamole` subir (o `depends_on: service_healthy` funciona) |
| portas publicadas | `guacamole` em `127.0.0.1:8080` · `guacd` e `postgres` **sem porta publicada**, como desenhado |
| UI | `GET /guacamole/` → **200** |
| **API REST** (o que a subtarefa 3 consome) | `POST /api/tokens` → **token de 64 chars**; `GET …/connections` → `{}` (limpo); `GET …/schema/protocols` → `kubernetes, telnet, ssh, vnc, rdp` |

A senha do Postgres foi gerada com `randomBytes(24).toString('base64url')` — **`base64url` de
propósito**: não produz `$`, `/` nem `+`, então não esbarra no interpolador do Compose nem em
escape de shell. `openssl rand -base64 32` produz esses caracteres e é a origem provável de um
"funciona na minha máquina" aqui.

### ⚠️ Pendente e vivo: `guacadmin` / `guacadmin`

O serviço está de pé **com a credencial padrão**. Hoje ela só é alcançável de `127.0.0.1`,
o que contém o risco — mas é a conta que administra o gateway que vai alcançar a tela de
qualquer máquina do domínio. Trocar é o próximo passo, junto com a criação do usuário de
serviço da subtarefa 3.
