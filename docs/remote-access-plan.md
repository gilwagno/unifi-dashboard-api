# Plano da Onda 4 — Acesso Remoto a Qualquer PC (Guacamole)

> Documento de referência técnica. Depende da Onda 3 (lista de computadores vem do AD) —
> não iniciar antes da Onda 3 ter pelo menos o endpoint `GET /ad/computers` aprovado.

## Objetivo

Controlar e acessar remotamente qualquer computador da rede, direto do navegador, sem
instalar nada no PC de quem acessa. Ver a tela e interagir, não só disparar comando.

## Por que Guacamole

Apache Guacamole é um gateway de acesso remoto **clientless**: fala RDP, VNC e SSH, e
entrega tudo via HTML5 no navegador. Bate exatamente com o objetivo de "comandar via HTML".
Alternativas descartadas: TeamViewer/AnyDesk (exigem agente instalado em cada PC + conta em
serviço de terceiro); RustDesk (viável, mas Guacamole tem integração mais madura com
LDAP/AD pra autenticação, o que já vamos ter pronto na Onda 3).

## Arquitetura

```
[Dashboard, no navegador]
        |
  iframe ou link pra sessão do Guacamole (após login do dashboard)
        |
  [guacamole-client] (interface web + API REST)
        |
  [guacd] (proxy que fala RDP/VNC/SSH de verdade)
        |
  [PC alvo] — Remote Desktop do Windows habilitado
```

- `guacd` + `guacamole-client` sobem via Docker Compose, numa máquina dentro da rede
  (pode ser a mesma que já roda o backend do dashboard).
- Banco de conexões: Postgres ou MySQL (Guacamole suporta os dois oficialmente).
- RDP já vem nativo no Windows — não precisa agente. Precisa só estar habilitado
  (Settings > System > Remote Desktop) em cada máquina.

## Pré-requisitos do lado da rede (fora do código, documentado só pra contexto)

1. **Habilitar RDP em todos os PCs via GPO** — já que existe AD, não precisa fazer máquina
   por máquina: uma GPO em `Computer Configuration > Administrative Templates > Windows
   Components > Remote Desktop Services` habilita em todo o domínio de uma vez.
2. **Firewall**: liberar porta 3389 (RDP) só entre o host do Guacamole e os PCs — nunca
   exposta pra fora da rede local diretamente (o acesso de fora passa pelo Cloudflare
   Tunnel + dashboard + Guacamole, nunca RDP direto na internet).
3. **Conta de serviço** com permissão de logon remoto (não precisa ser admin do PC,
   dependendo do que se quer fazer depois de conectado) — ou autenticação passe-through
   com a própria credencial de domínio do usuário que está acessando.

## Integração com o resto do projeto

- **Lista de máquinas**: `GET /ad/computers` (Onda 3) alimenta automaticamente as conexões
  do Guacamole — endpoint novo `POST /remote-access/sync` (ou um job periódico) que
  cria/atualiza conexões no Guacamole via API REST dele, uma por computador do AD.
- **Autenticação em camadas**: Cloudflare Access → login do dashboard (JWT já existente) →
  só então a sessão chega no Guacamole. O dashboard nunca expõe o Guacamole diretamente;
  atua como proxy/gateway de acesso.
- **Auditoria**: toda sessão remota aberta grava no log de auditoria (mesmo mecanismo da
  Onda 3, subtarefa 0.1) — quem acessou qual PC, quando. Esse é o tipo de ação que mais
  precisa de rastro no projeto inteiro.

## Escopo funcional

- Listar PCs disponíveis pra acesso remoto (a partir do AD)
- Abrir sessão RDP de um PC específico, dentro do dashboard
- Encerrar sessão
- Histórico de acessos (quem, quando, qual PC) — via log de auditoria

## Fora de escopo desta onda

- Wake-on-LAN (ligar PC desligado remotamente) — possível de adicionar depois, mecanismo
  separado (pacote mágico UDP), não faz parte do Guacamole
- Execução de comando/script sem interface (isso seria WinRM puro, não RDP) — se precisar,
  vira subtarefa própria, não redefine esta onda

## Estratégia de teste

Mesmo princípio das ondas anteriores: nunca testar contra PC de produção sem sandbox.
Sugestão: uma VM Windows de teste com RDP habilitado, usada como alvo real nos testes e2e
(mesmo espírito das "impressoras reais confirmadas na rede" da Onda 2) — já que Guacamole
proxyar uma sessão RDP de verdade é o tipo de coisa que só se valida contra o protocolo
real, um mock não pega os problemas que importam aqui.

## Subtarefas sugeridas (ordem de dependência)

1. Subir `guacd` + `guacamole-client` + banco via Docker Compose, documentar em
   `docker-compose.yml` do projeto
2. GPO de RDP no domínio (infraestrutura, fora do código)
3. Serviço `remote-access.service.ts` — fala com a API REST do Guacamole (criar/listar
   conexões)
4. Job/endpoint de sincronização: lista de PCs do AD → conexões no Guacamole
5. Rotas protegidas (`GET /remote-access/computers`, `POST
   /remote-access/computers/:id/session`) com auditoria
6. Frontend — tela de Acesso Remoto, iframe/link pra sessão do Guacamole
7. e2e contra a VM de teste (abrir sessão, confirmar tela renderizada, encerrar)
