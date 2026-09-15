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

> ### ⛔ BLOQUEANTE DE PRODUÇÃO — dependência mútua com o `ignore-cert=true`
>
> Esta regra e o parâmetro `ignore-cert=true` das conexões RDP
> (`createRdpConnection` em [`src/services/remote-access.service.ts`](../src/services/remote-access.service.ts))
> são **um par indivisível**. Um sem o outro é inseguro:
>
> - `ignore-cert=true` existe porque os PCs do domínio usam certificado RDP autoassinado — sem
>   ele o `guacd` recusa e a conexão nunca abre. O custo é que o `guacd` **deixa de verificar
>   com quem está falando**: num segmento onde alguém possa responder pelo IP do alvo, a sessão
>   iria para uma máquina forjada, com a credencial de domínio de quem acessa junto.
> - A regra de firewall é o que torna esse custo aceitável: se o 3389 só trafega entre o host do
>   `guacd` e os PCs, não há terceiro no caminho para forjar o alvo.
>
> **Sem esta regra aplicada, o módulo de acesso remoto não vai a produção.** Não é gate só da
> subtarefa 7 (e2e): é pré-condição da decisão de desenho que já está no código. Quem afrouxar
> o firewall depois precisa, no mesmo momento, tirar o `ignore-cert=true` — senão a única linha
> de defesa desaparece em silêncio.
>
> O `docs/guacamole-setup.md` e o docblock de `createRdpConnection` apontam de volta para cá.

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

## 3. Como a sessão autentica — ✅ DECIDIDO: passe-through (2026-09-15)

Decisão do usuário. O que ela implica no código já está escrito como regra dura no topo de
`src/services/remote-access.service.ts`: **passe-through não persiste credencial**. As conexões
do catálogo não carregam `username`/`password`, e `createRdpConnection` sequer tem parâmetro
para recebê-los — um catálogo RDP com credencial embutida seria um cofre de senhas de domínio.
A credencial de quem acessa é usada para montar a sessão e descartada, nunca gravada "para
reconectar".

O quadro abaixo fica como registro do porquê.

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

## Onda futura (registrar, NÃO fazer agora): validar certificado de verdade

O arranjo acima deixa o **firewall como única linha de defesa** da identidade do alvo. A forma
de remover essa dependência é emitir certificados RDP pela PKI interna do domínio (AD CS) e
trocar `ignore-cert=true` por verificação real no `guacd`.

Não é para esta onda: depende de PKI interna com template de certificado RDP distribuído por
GPO — infraestrutura própria, não um parâmetro de conexão. Fica registrado como item de onda
futura para que a decisão atual seja **uma escolha com prazo**, não um default herdado.
Precedente do projeto: a flag de TLS do módulo de AD, que foi eliminada em vez de defendida
assim que houve caminho melhor (`AD_TLS_CA_FILE`, PR #32).

## ⚠️ Estar no grupo ≠ ter o direito de logon remoto

**São dois controles separados no Windows, e satisfazer um não satisfaz o outro.** Esta é a causa
mais provável de "acesso negado" quando o RDP for para o parque via GPO — e já mordeu neste
projeto, no teste da subtarefa 7 contra a `EA-PC-MKT01`.

| controle | onde fica | o que faz |
|---|---|---|
| **associação ao grupo** | grupo local *Usuários da Área de Trabalho Remota* | coloca a pessoa na lista |
| **direito de usuário** | `secpol.msc` → Políticas Locais → **Atribuição de Direitos de Usuário** → *"Permitir logon por meio dos Serviços de Área de Trabalho Remota"* (`SeRemoteInteractiveLogonRight`) | é o que **de fato** autoriza o logon |

Por padrão o direito já contém *Administradores* **e** *Usuários da Área de Trabalho Remota* — mas
**uma GPO de domínio que defina essa atribuição SUBSTITUI a lista inteira**. Se a GPO listar só
*Administradores*, adicionar alguém ao grupo não produz efeito nenhum: admin entra, usuário comum
é recusado, e a associação ao grupo está lá, correta e inútil.

### Como reconhecer no log do `guacd`

O sintoma muda conforme o estágio, e a distinção economiza horas:

| mensagem do `guacd` | significado |
|---|---|
| `Server refused connection (wrong security type?)` | a estação recusou **antes** de autenticar — tipicamente sem o direito/associação |
| `Authentication failure (invalid credentials?)` | a estação aceitou a conexão e **rejeitou a credencial** |
| `DNS lookup failed (incorrect hostname?)` | a máquina saiu do DNS (ex.: durante um reboot) |

### O discriminador que não exige testar senha

`badPwdCount` da conta no AD (atributo por controlador de domínio) separa as duas causas **sem
ninguém digitar credencial**:

- tentativa nova e `badPwdCount` **sobe** → a senha está chegando ao DC e é **inválida**;
- tentativa nova e `badPwdCount` **fica em 0** → a credencial **nem chega ao DC**: é direito de
  logon, não senha.

### Verificações na estação

```powershell
Get-LocalGroupMember -Group "Usuários da Área de Trabalho Remota"
whoami /groups   # rodado COMO a pessoa: se o grupo não aparecer, o token é antigo
```

O `whoami /groups` importa: a associação de grupo só entra no **token do próximo logon**. Adicionar
ao grupo e testar na sessão já aberta falha mesmo com tudo correto.
