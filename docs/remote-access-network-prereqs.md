# Pré-requisitos de rede do Acesso Remoto (subtarefa 2 — gate humano)

> **Esta subtarefa não produz código.** Produz este checklist, que você executa no domínio e
> confirma. O loop para aqui: as subtarefas 3+ (serviço, sync, rotas) podem ser escritas antes,
> mas **nenhuma sessão RDP funciona** até estes três itens estarem feitos.
>
> Domínio deste projeto: `evokaudio.local` · DC: `EA-SRV-AD01`.

## 1. Habilitar RDP no domínio por GPO

Máquina por máquina não escala e some no próximo PC novo. Com AD, é uma GPO.

`gpmc.msc` → nova GPO ligada à OU dos computadores (`OU=EvokAudio`, a mesma que o módulo de
AD já usa) → editar:

| Caminho | Valor |
|---|---|
| `Computer Configuration → Policies → Administrative Templates → Windows Components → Remote Desktop Services → Remote Desktop Session Host → Connections`<br>**Allow users to connect remotely by using Remote Desktop Services** | **Enabled** |
| mesma árvore → `Security` → **Require user authentication for remote connections by using Network Level Authentication** | **Enabled** |

NLA ligado é intencional: sem ele, a máquina aceita montar sessão antes de autenticar. O
Guacamole fala NLA sem problema (`security=nla` na conexão RDP, subtarefa 3).

**Quem pode entrar**: por padrão, só administradores locais. Para dar acesso a um grupo do AD
sem tornar ninguém admin da máquina, use
`Computer Configuration → Policies → Windows Settings → Security Settings → Restricted Groups`
(ou Group Policy Preferences → Local Users and Groups) adicionando o grupo ao
**Remote Desktop Users** local.

> Aqui cabe o mesmo cuidado que a Decisão 2 da Onda 3 cobrou caro: **se esse grupo tiver grupos
> aninhados, quem herda acesso não é revogável de forma determinística.** Use um grupo próprio,
> de membership direta — o precedente do `wifi-dashboard` vale igual.

**Aplicar**: `gpupdate /force` numa máquina de teste e conferir com `rsop.msc`, ou
`Get-GPResultantSetOfPolicy`. Não confie no "deve ter aplicado".

## 2. Firewall — 3389 só entre o host do Guacamole e os PCs

Inegociável: **RDP nunca exposto à internet**. É um dos vetores de ransomware mais explorados
que existem. O acesso de fora entra por Cloudflare Tunnel → dashboard → Guacamole; o 3389 só
trafega dentro da LAN, e idealmente só a partir de um IP.

GPO de Windows Firewall (`Computer Configuration → Policies → Windows Settings → Security
Settings → Windows Firewall with Advanced Security`), regra de entrada:

- Porta TCP **3389**
- **Scope → Remote IP address**: só o IP do host que roda o `guacd`
- Profile: **Domain** (não Public)

Confirme também que o firewall do UniFi não roteia 3389 de fora para dentro (nenhum
port-forward).

## 3. Como a sessão autentica — DECISÃO SUA, e ela muda a auditoria

O `remote-access-plan.md` deixou em aberto; a subtarefa 3 precisa da resposta.

| | Passe-through (credencial de domínio de quem acessa) | Conta de serviço única |
|---|---|---|
| Quem aparece no log do PC alvo | **a pessoa real** | sempre "o dashboard" |
| Permissão no PC | o que a pessoa já tem | uma conta com logon remoto em todas |
| Custo | a pessoa digita a senha do domínio ao abrir a sessão | nenhum atrito |
| Risco | credencial de domínio trafegando pelo Guacamole | **uma credencial que abre qualquer PC** |

**Recomendação**: passe-through. A auditoria do dashboard registra quem clicou, mas o log do
**PC alvo** só registra a conta que entrou — com conta de serviço, todo acesso do histórico do
Windows fica indistinguível, e o módulo perde metade do rastro que é a razão dele existir.

## Confirmação

Quando os três estiverem feitos, confirme aqui na conversa — a subtarefa 7 (e2e contra RDP
real) também depende de uma **VM Windows de teste** com RDP habilitado, que é o alvo real
desta onda (mesmo papel das impressoras reais na Onda 2). Nunca a máquina de alguém em uso.
