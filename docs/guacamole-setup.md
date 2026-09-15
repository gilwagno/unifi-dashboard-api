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

## ⛔ Antes de produção: leia o bloqueante do firewall

As conexões RDP criadas por este módulo usam `ignore-cert=true`, e isso **pressupõe** a regra de
firewall que restringe o 3389 ao host do `guacd` — ver
[`remote-access-network-prereqs.md`, item 2](remote-access-network-prereqs.md). Os dois são um
par indivisível; sem a regra, o módulo não vai a produção.

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

### Credenciais — RESOLVIDO em 2026-09-15

A senha padrão do `guacadmin` **foi rotacionada** e o usuário de serviço do backend foi criado,
com permissão mínima. Onde cada segredo mora (os dois arquivos são gitignored):

| segredo | arquivo | para quê |
|---|---|---|
| `GUACAMOLE_ADMIN_PASSWORD` | `guacamole/.env` | login humano na UI do Guacamole |
| `GUACAMOLE_USERNAME` / `GUACAMOLE_PASSWORD` | `.env` da raiz | o que o backend usa na API REST |

O usuário de serviço é `dashboard-backend` com **`CREATE_CONNECTION` e mais nada**. No
Guacamole, quem cria uma conexão recebe controle sobre ela — então isso basta para
criar/ler/editar/remover as conexões que o próprio backend criou, e não dá nenhum poder
administrativo. Verificado depois de provisionar:

- `guacadmin` / `guacadmin` → **403** (a senha padrão está morta);
- o usuário de serviço lista usuários e enxerga **só a si mesmo** (`["dashboard-backend"]`);
- nenhuma permissão de sistema além de `CREATE_CONNECTION`.

> **Erro cometido e corrigido no caminho, registrado porque a lição vale**: na primeira
> tentativa o script trocou a senha do `guacadmin` **antes** de persistir o valor gerado, e a
> gravação falhou depois — a senha nova existiu só na memória daquele processo e se perdeu, com
> o `guacadmin` trancado. Como o catálogo estava vazio, a recuperação foi recriar o volume
> (`down -v`). O script passou a **persistir o segredo antes de qualquer mutação**. É a mesma
> classe do `AdPasswordAmbiguousError` da Onda 3: a única cópia de um segredo gerado não pode
> depender de um passo que ainda pode falhar.

## Sincronização AD → Guacamole (subtarefa 4)

`POST /remote-access/sync` reconcilia o catálogo do Guacamole com `GET /ad/computers`.

### A âncora

A correlação é pelo **`objectGUID`** do computador, gravado no **parâmetro** `ad-object-guid` da
conexão. As duas metades dessa frase foram verificadas contra o sistema real, não deduzidas:

- **`objectGUID` porque é imutável** — sobrevive a renomeação e a mudança de OU. O nome não
  sobrevive nem à primeira: casar por nome faria uma máquina renomeada virar conexão duplicada,
  com a antiga órfã para sempre.
- **Parâmetro, não atributo** — os atributos de conexão do Guacamole são um conjunto **fechado**
  de 7 campos, e um atributo custom é aceito com **HTTP 200 e descartado em silêncio**
  (`tools/guacamole-attr-probe.mjs`). Uma âncora que não grava produziria duplicação a cada
  rodada, reportando sucesso sempre.

### Regras

| situação | o que o sync faz |
|---|---|
| computador novo no AD | cria a conexão, ancorada |
| computador já ancorado, nada mudou | **não escreve nada** |
| computador renomeado / FQDN mudou | **atualiza** a conexão existente |
| computador saiu do AD | **remove** a conexão |
| computador desabilitado no AD | **remove** a conexão (revoga o acesso) |
| `enabled` ilegível (`null`) | trata como não habilitado — falha FECHADO |
| conexão **sem** âncora (feita à mão) | **nunca toca**; reporta em `ignoradas` |

### Por que REMOVER e não desabilitar

Porque o rastro de auditoria não é filho da conexão — e isso foi **confirmado por experimento**
contra o banco real, não presumido. Em `guacamole_connection_history`, `connection_id` é
`ON DELETE SET NULL` e `connection_name` é uma cópia `NOT NULL`. Apagando a conexão, a linha do
histórico permanece com usuário, nome da conexão e datas intactos; só o `connection_id` vira
NULL. Se o histórico caísse junto, a decisão correta seria desabilitar em vez de remover.

### Teste de fumaça contra AD + Guacamole reais

`npx tsx tools/guacamole-sync-smoke.mts` (`--manter` preserva o resultado para inspeção).
Execução de 2026-09-15 contra `evokaudio.local`: **51 computadores, 48 conexões criadas, 3
pulados** — os três eram contas de computador **desabilitadas** no AD (`EA-PC-EST01`,
`EA-PC-FAT01`, `EA-PC-EST02`), exatamente o comportamento desenhado. A 2ª rodada não criou, não
atualizou e não removeu nada; releitura independente confirmou 48 conexões com 48 âncoras
distintas. O catálogo foi devolvido ao estado inicial ao fim.

## Abertura de sessão (subtarefa 5)

`POST /remote-access/computers/:objectGuid/session` devolve a URL do Guacamole que o frontend
abre. `GET /remote-access/computers` lista os PCs do AD já cruzados com o catálogo.

### O desenho perigoso que a sonda matou antes de existir

O caminho natural seria o backend reaproveitar a própria sessão do Guacamole e entregar aquele
token ao navegador. **Medido** (`tools/guacamole-session-probe.mjs`): o token carrega as
permissões de quem autenticou — `/self/permissions` com o token do usuário de serviço reporta
`CREATE_CONNECTION`. Uma pessoa com o DevTools aberto poderia **criar conexões RDP arbitrárias
direto no gateway**, fora de qualquer controle do backend. Escalação de privilégio.

### O desenho adotado: uma conta Guacamole por pessoa

| | |
|---|---|
| nome da conta | `dash-<usuário do dashboard>`, **determinístico** |
| chave de correlação | o `sub` do JWT — o mesmo que o log de auditoria grava como `actor` |
| permissão | `READ` **apenas** na conexão que está sendo aberta |
| senha | aleatória, **rotacionada a cada abertura**; o backend não a guarda entre chamadas |

A chave determinística resolve para pessoa↔conta o mesmo problema que o `objectGUID` resolve
para computador↔conexão: sem ela, cada abertura criaria uma conta nova e o Guacamole acumularia
órfãos.

### Pré-requisito: `CREATE_USER` no usuário de serviço — e a prova de que está contido

```bash
node tools/guacamole-privilege-probe.mjs
```

A sonda concede `CREATE_USER` ao usuário de serviço e **mede** se isso é ampliação contida. O
risco não é "criar usuários" (é o objetivo), é **criar um usuário e dar a ele mais poder do que
o criador tem** — se desse, `CREATE_USER` seria equivalente a admin. Resultado de 2026-09-15,
com cada tentativa confirmada por **releitura independente**, não pelo status HTTP:

| tentativa | resultado |
|---|---|
| dar `ADMINISTER` a um usuário novo | **403, não efetivou** |
| passar `CREATE_USER` adiante (auto-replicação em cadeia) | **403, não efetivou** |
| dar `ADMINISTER` a si mesmo (auto-promoção) | **403, não efetivou** |

### A credencial de domínio não passa pelo backend

Não é "usada e descartada com disciplina": **não há o que descartar porque ela nunca chega
aqui**. A conexão não carrega `username`/`password` (os dois são parâmetros opcionais do RDP no
Guacamole — verificado no schema), então o Guacamole pede a credencial no navegador e ela vai
direto ao `guacd`. A garantia é do **caminho do dado**, não do código estar correto — mesma
lógica de `createRdpConnection` não ter parâmetro de credencial.

A senha que este módulo gera é outra coisa, de outra natureza: a da conta Guacamole da pessoa.

### Auditoria

O hook global `onResponse` de `src/app.ts` grava **ator, rota, `objectGuid` do PC, status e
timestamp** — inclusive nas tentativas que **falham**, que são as que mais importam numa
investigação. Não há gravação manual na rota de propósito: uma segunda escrita poderia divergir
da do hook. Há teste afirmando que a entrada é registrada de fato (não só que a sessão abre),
que o corpo da requisição nunca entra no log, e que o ator vem do JWT e **nunca** do corpo.

Com a conta por pessoa, o histórico do **próprio Guacamole** vira uma segunda trilha,
independente do nosso log.

### Teste de fumaça contra o Guacamole real

`npx tsx tools/guacamole-session-smoke.mts` — 14 verificações, execução de 2026-09-15: conta
criada com nome determinístico; **o token da pessoa não carrega `CREATE_CONNECTION` nem
permissão de sistema nenhuma**; `READ` só na conexão da sessão, sem `ADMINISTER`; a 2ª abertura
**reusa a mesma conta** (contagem de usuários inalterada) com token próprio; conta e conexão
removidas ao fim.

## Tela de Acesso Remoto (subtarefa 6)

`frontend/src/pages/RemoteAccess.tsx`, no menu lateral como **Acesso Remoto**.

### Onde o token da sessão vive — e por que é aceitável

A URL devolvida por `POST .../session` carrega o token da conta Guacamole **da pessoa** na query
string. O navegador **é** o cliente do Guacamole, então o token precisa chegar até ele; a
pergunta honesta não é "como esconder", é **onde ele pode parar e quem o alcança**:

- **não é o token do usuário de serviço** (aquele carrega `CREATE_CONNECTION` — medido). O
  token daqui não tem permissão de sistema nenhuma e dá `READ` em uma conexão: é a credencial da
  própria pessoa, para um acesso que ela já tem;
- **nunca vai para `window.location`** — iria para o histórico do navegador, que sobrevive à
  sessão. É `src` de um `iframe`, não navegação;
- **nunca é persistido** — nada de `localStorage`/`sessionStorage`; vive só no estado do React e
  some ao encerrar;
- **nunca é logado nem exibido em texto** na página;
- é buscado **no clique**, nunca em lote junto da lista — cada chamada emite um token e grava uma
  linha de auditoria.

Cinco testes travam isso, incluindo "o token não aparece no texto da página" e "encerrar descarta
o token do DOM". **O que o tiraria do DOM de vez** é um proxy reverso same-origin injetando a
autenticação do lado do servidor — infraestrutura própria, registrada como a saída, não como
pendência esquecida.

### Transparência de sessão ativa

Ver a tela de outra máquina não pode ser discreto:

- card **"Sessões ativas"** no topo, que fica em tom de alerta quando > 0, com o texto "alguém
  está vendo a tela de uma máquina agora";
- selo por máquina na lista (`Sessão ativa` / `N sessões ativas`), vindo do `activeConnections`
  que o próprio Guacamole reporta;
- com a sessão aberta, um banner `role="alert"` no topo com **o nome da máquina e a conta
  registrada em auditoria**, e o botão de encerrar sempre visível.
