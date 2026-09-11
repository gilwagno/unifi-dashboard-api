# Infraestrutura — Cloudflare Tunnel + Access

> Isto é infraestrutura/deploy, não código do Gauntlet Loop — não segue o harness de
> 4 pontos, é um passo a passo de configuração fora do repositório.

## Objetivo

Acessar o dashboard (e, por trás dele, o Guacamole da Onda 4) de qualquer lugar, pelo
navegador, sem VPN instalada no dispositivo de quem acessa — com uma camada de login antes
mesmo de chegar na tela de login do próprio dashboard.

## Por que Tunnel em vez de abrir porta no roteador

Cloudflare Tunnel cria uma conexão de saída do seu servidor pra Cloudflare — nunca abre
porta de entrada no seu roteador/firewall. O servidor com o dashboard nunca fica com um IP
público exposto diretamente.

## Passo a passo

1. **Ter um domínio no Cloudflare** (pode ser um subdomínio barato só pra isso).
2. Instalar o `cloudflared` na mesma máquina onde roda o backend do dashboard.
3. Criar o túnel: `cloudflared tunnel create dashboard-rede` — gera um ID e um arquivo de
   credenciais.
4. Configurar o roteamento (`config.yml` do `cloudflared`) apontando o subdomínio (ex.:
   `rede.seudominio.com`) pra porta local do backend (ex.: `localhost:3000`).
5. Subir o túnel como serviço (`cloudflared service install`) — fica rodando
   permanentemente, reconecta sozinho se cair.
6. No painel da Cloudflare, ativar **Cloudflare Access** nesse subdomínio: define quem pode
   sequer chegar na tela de login do dashboard (login por e-mail com código, Google, etc.) —
   uma camada de autenticação inteira antes da autenticação do próprio app.

## Onde isso se encaixa nas outras ondas

- O dashboard (frontend + backend) fica atrás dessa camada.
- Quando a Onda 4 (Guacamole) estiver de pé, ela **não** ganha subdomínio/túnel próprio —
  fica acessível só através do dashboard (que já está atrás do Tunnel + Access), nunca
  exposta diretamente.
- Isso é independente da Onda 3 e da Onda 4 — pode ser feito a qualquer momento, em
  paralelo.

## Segurança — pontos que valem atenção

- O segredo do túnel (`credentials.json`) dá acesso a rotear tráfego pro seu servidor —
  tratar com o mesmo cuidado que uma senha de admin.
- Cloudflare Access precisa estar configurado **antes** de anunciar o subdomínio pra
  qualquer pessoa — sem ele, o túnel sozinho só resolve "não abrir porta no roteador", não
  substitui autenticação.
- Revisar periodicamente quem tem acesso liberado no Access (mesmo princípio de auditoria
  das outras ondas — login sem rastro é exatamente o tipo de lacuna que já causou o
  incidente original deste projeto).
