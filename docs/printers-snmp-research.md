# Pesquisa: SNMP nas impressoras reais da rede (referência para o módulo de manutenção)

Levantamento feito em 2026-08-31 contra fontes oficiais, para embasar a Onda 2 (Módulo de
Manutenção de Impressoras). As 3 impressoras confirmadas na rede via API clássica do controller
(`rest/user`):

| Nome no controller | Fabricante (OUI) | MAC | IP atual | IP fixo |
|---|---|---|---|---|
| `HPLaserMFP135w` (FINANCEIRO) | HP Inc. | `50:81:40:d8:6c:7e` | `172.16.0.89` | Sim |
| `HLL2360DWVENDAS` | Brother Industries | `e8:6f:38:ba:b9:32` | `172.16.0.222` | Não |
| `BRW849E567E0445` | Brother Industries (OUI `84:9E:56`, confirmado) | `84:9e:56:7e:04:45` | `172.16.0.80` | Não |

Achado operacional importante: nenhuma das 3 aparece na **API oficial de Integração**
(`GET /sites/{id}/clients`) além da `BRW849E567E0445` — as outras duas só aparecem via
**API clássica** (`rest/user`). O merge de status do módulo de impressoras precisa tentar a
Integration API primeiro e cair pra API clássica, não confiar só na primeira.

## HP Laser MFP 135w (Product No. 4ZB83A)

Fonte: datasheet oficial HP, `https://www8.hp.com/h20195/v2/getpdf.aspx/4aa7-4746enl.pdf`
(4AA7-4746ENL, October 2019, R1) — texto extraído diretamente do PDF oficial.

- **Conectividade padrão:** "Hi-Speed USB 2.0; Wireless 802.11 b/g/n". **Sem Ethernet.**
  `Network Capabilities: No` no datasheet (campo próprio da HP, não indica ausência de rede —
  a impressora tem Wi-Fi — mas confirma que não há porta de rede cabeada).
- **Wireless:** "Yes, built-in Wi-Fi 802.11b/g/n" — compatível com 2.4 GHz e 5.0 GHz.
- **Gestão de segurança (campo "Security Management" do datasheet, citação exata):**
  > "Password-protected network embedded Web server; enable/disable Network ports; SNMPv1
  > community password change; SNMPV2&V3; IPSec; Filtering: MAC, IPv4, IPv6"
- **Printer Management (campo próprio do datasheet):** `None` — a HP não lista nenhuma
  ferramenta de gestão de frota (tipo HP Web Jetadmin) pra esta linha de entrada.
- **Potência:** interna, 110–127 VAC ou 220–240 VAC — liga direto na tomada, sem PoE.

Confirma as premissas da Seção 0 do spec original: sem Ethernet/PoE, SNMPv1/v2c/v3 suportado
oficialmente, servidor Web embarcado protegido por senha (bate com a URL `/sws/index.html`
observada — ver nota abaixo sobre origem Samsung).

## Brother HL-L2360DW (referência pra `HLL2360DWVENDAS`)

Fonte: `https://support.brother.com/g/b/spec.aspx?c=us&lang=en&prod=hll2360dw_us` (specs oficiais).

- **Conectividade:** Ethernet 10BASE-T/100BASE-TX (cat 5+), Wi-Fi 802.11b/g/n
  (infraestrutura/ad-hoc) + Wi-Fi Direct, USB 2.0 Hi-Speed.
- **Protocolos de gestão:** SNMPv1/v2c/v3 (cabeado e sem fio), servidor HTTP embarcado
  (Web Based Management da Brother), SMTP-AUTH, DNS, mDNS, LPR/LPD, IPP, FTP.
- **Segurança de rede:** WEP 64/128-bit, WPA-PSK/WPA2-PSK (TKIP/AES), WPS, autenticação SNMPv3.

MIB privada da Brother não é pública — só sob pedido a `ask.pm@brother.com`. Para este módulo,
usar apenas o Printer-MIB padrão (RFC 3805) e Host Resources MIB (RFC 2790), que são
implementados pela Brother de forma padrão (confirmado indiretamente pelo suporte a SNMPv1/2c/3
listado nas specs — o padrão de mercado é implementar RFC 3805 por cima disso).

## `BRW849E567E0445` — modelo exato não identificado

O hostname `BRW<MAC sem dois-pontos>` é a convenção padrão de nomeação Brother, e o OUI
`84:9E:56` foi confirmado como Brother Industries (Printing & Solutions Company) via busca de
fabricante. O modelo exato não foi confirmado nesta pesquisa — a Onda 1 (poller real) vai revelar
via SNMP (`sysDescr`/`hrDeviceDescr`) qual modelo é, sem bloquear o desenvolvimento: tratado
genericamente como "impressora Brother padrão RFC 3805" até prova em contrário.

## Origem Samsung da linha HP Laser MFP (contexto, não uma fonte separada)

A HP adquiriu a divisão de impressoras da Samsung em 2017. A interface web embarcada observada
(`https://<IP>/sws/index.html`) usa a assinatura `sws` da **SyncThru Web Service**, historicamente
usada pela Samsung — consistente com a HP Laser MFP 10x/13x sendo hardware de origem Samsung
rebatizado. Não encontrei documentação pública da HP que confirme isso explicitamente (é inferência
a partir da URL observada, não uma fonte oficial separada) — tratar como pista útil pra
depuração/suporte, não como fato documentado por fonte oficial.

## OIDs padrão do Printer-MIB (RFC 3805) relevantes para este módulo

Fonte primária: `https://www.rfc-editor.org/rfc/rfc3805.html` (IETF, RFC 3805 — "Printer MIB v2").
A busca automatizada nesta sessão confirmou diretamente da RFC, Seção 2.4, a semântica dos
valores-sentinela para objetos `Integer32` do MIB:

> - `other(-1)`: condição indeterminada ou não-padrão
> - `unknown(-2)`: o valor não pode ser determinado
> - `partial(-3)`: "there is some supply remaining (but the amount is indeterminate)" — ainda há
>   suprimento restante, mas a quantidade é indeterminada

**Importante:** o spec original da Onda 2 menciona só `-1`/`-2`; a RFC também define `-3`
(`partial`) como um terceiro sentinela válido para os campos de suprimento. O poller SNMP deste
módulo precisa tratar os três, não só dois.

Os OIDs numéricos abaixo são os valores padrão, estáveis e amplamente documentados do Printer-MIB
(não obtidos por fonte fresca nesta busca — as ferramentas de leitura de OID individual
(`oid-info.com`) estavam inacessíveis no momento da pesquisa; são os valores de referência padrão
usados por qualquer implementação SNMP de impressora desde a RFC 1759/3805, e devem ser
**confirmados empiricamente contra as 3 impressoras reais na Onda 1**, não assumidos como certos
sem teste):

| Nome | OID (rascunho, a confirmar na Onda 1) | Uso |
|---|---|---|
| `prtMarkerSuppliesDescription` | `1.3.6.1.2.1.43.11.1.1.6` | nome do suprimento (toner, tambor) |
| `prtMarkerSuppliesType` | `1.3.6.1.2.1.43.11.1.1.5` | tipo do suprimento |
| `prtMarkerSuppliesMaxCapacity` | `1.3.6.1.2.1.43.11.1.1.8` | capacidade máxima |
| `prtMarkerSuppliesLevel` | `1.3.6.1.2.1.43.11.1.1.9` | nível atual |
| `prtMarkerLifeCount` | `1.3.6.1.2.1.43.10.2.1.4` | contador de páginas |
| `hrPrinterDetectedErrorState` | `1.3.6.1.2.1.25.3.5.1.2` | bitmap de erros ativos (RFC 2790) |
| `hrDeviceStatus` | `1.3.6.1.2.1.25.3.2.1.5` | status geral do dispositivo (RFC 2790) |

## CONFIRMAÇÃO EMPÍRICA contra as 3 impressoras reais (2026-08-31, subtarefa 5)

Sonda SNMP descartável executada da máquina do dashboard contra os 3 IPs, com `net-snmp` 3.26.3,
`community="public"`, timeout 2,5s, retries 1, em SNMP v1 e v2c. **As 3 responderam.** O que segue
substitui a tabela "rascunho, a confirmar" acima como fonte de verdade.

### Identificação real (via `sysDescr` / `hrDeviceDescr.1`)

| Cadastro | `sysDescr` | Modelo real (`hrDeviceDescr.1`) |
|---|---|---|
| HPLaserMFP135w (`172.16.0.89`) | `HP Laser MFP 131 133 135-138; V3.82.01.10 DEC-09-2019; Engine V1.00.11; NIC 31.03.60_0.1; S/N BRBSQ2G13Q` | `HP Laser MFP 131 133 135-138` |
| HLL2360DWVENDAS (`172.16.0.222`) | `Brother NC-8300w, Firmware Ver.Z ,MID 84U-F77` | `Brother HL-L2360D series` |
| BRW849E567E0445 (`172.16.0.80`) | `Brother NC-9200w, Firmware Ver.1.46 ,MID 8CE-922FID 2` | **`Brother DCP-L3560CDW series`** |

**O modelo antes desconhecido está identificado:** a `BRW849E567E0445` é uma **Brother
DCP-L3560CDW**, multifuncional **colorida** — não uma mono como as outras duas. Ela expõe 10 linhas
na `prtMarkerSuppliesTable` (4 toners CMYK, waste toner box, belt unit, 4 drums), contra 2 da
HL-L2360D e 6 da HP.

### OIDs confirmados (todos os 7 da tabela de rascunho responderam nas 3)

Todos os OIDs listados na seção anterior existem e respondem nas 3 impressoras. Índices reais:
`prtMarkerSuppliesTable` usa `<hrDeviceIndex>.<supplyIndex>` = `1.1`, `1.2`, … ;
`prtMarkerLifeCount` responde em `1.3.6.1.2.1.43.10.2.1.4.1.1` (linha única nas 3);
`hrDeviceStatus`/`hrPrinterDetectedErrorState` respondem no índice `.1` nas 3 (na HP o índice 1 é a
impressora — os índices 2–7 são CPU, RAM, Wi-Fi, USB, copy service e scanner).

### 3 achados novos que mudam o desenho do poller

1. **`getBulk` não é confiável.** O `walk()`/`subtree()` do `net-snmp` usa GETBULK quando a versão
   é v2c/v3 — e isso **falha em 2 das 3**: a HP responde `GeneralError` e a DCP-L3560CDW dá
   timeout, ambas para *qualquer* subárvore. Um walk manual por **GETNEXT** funciona nas 3, em v1
   **e** em v2c. O poller implementa o walk próprio (`walkColumn()`), não usa o da biblioteca.
2. **Semântica de "OID não existe" difere entre v1 e v2c.** Em v2c o varbind volta como
   `noSuchObject` e os demais varbinds do mesmo GET seguem válidos; em **v1 o PDU INTEIRO falha
   com `NoSuchName`** (RFC 1157) — um único OID não suportado derrubaria todos os outros campos
   pedidos junto. Por isso o poller busca **um escalar por requisição**.
3. **A HP reporta nível maior que a capacidade.** Em 3 dos 6 suprimentos (Transfer Roller, Fuser
   Life, Pick-up Roller) ela devolve `prtMarkerSuppliesLevel = 143066` com
   `prtMarkerSuppliesMaxCapacity = 100` e unidade `percent(19)` — um valor incoerente do firmware.
   Calcular percentual ingenuamente daria 143066%; o poller devolve `levelPercent: null` nesses
   casos.

### Os 3 sentinelas aparecem de verdade (não são hipótese)

- `partial(-3)`: nível de **todos** os toners das duas Brother (`prtMarkerSuppliesLevel`).
- `unknown(-2)`: `prtMarkerSuppliesMaxCapacity` dos toners das duas Brother.
- `other(-1)`: não observado nas 3 nesta rodada, mas tratado igual aos outros dois no poller.

Valores reais colhidos (amostra): HP com toner preto em **0%** (`level=0`, `max=100`,
unidade percent) e 59.700 páginas; HL-L2360D com drum em 69% (8278/12000) e 52.994 páginas;
DCP-L3560CDW com `hrDeviceStatus = 3 (warning)` e `hrPrinterDetectedErrorState = 0x20`, que decodifica
para **`lowToner`** — coerente com os 4 toners em `partial(-3)`.

## 4ª impressora: Brother DCP-1610NW (172.16.0.85)

Confirmada em 2026-08-31 via login real na WBM (senha de admin fornecida pelo usuário — não
registrada em nenhum arquivo do repositório). MAC real obtido direto da própria impressora (aba
Network Status, dois MACs — cabeado `94-dd-f8-23-a7-71` e Wi-Fi `4c-82-a9-e0-ad-b4`; conectada via
Wi-Fi, confirmado pelo controller). Cadastrada no módulo com `mac: 4c:82:a9:e0:ad:b4`,
`community: 'public'` (mesma das outras 3, ainda não confirmada por SNMP nesta unidade
especificamente).

**Achado definitivo sobre reboot remoto** (fecha a investigação da Seção 0 pra esta família de
impressoras Brother): a aba Administrator da WBM só expõe três botões — **Machine Reset**,
**Network Reset**, **All Settings Reset** — todos de RESET DESTRUTIVO (apagam configuração), não
um reboot simples e reversível. Não há nenhuma opção de "restart"/"reboot" limpo em nenhuma aba
(Administrator, Network, General) desta unidade. **Reboot remoto seguro não é viável via WBM nesta
família Brother** — a subtarefa de spike (item 9 do plano) deve tratar isso como resultado
negativo confirmado para Brother, não como pendência em aberto.

**Confirmado**: a notificação nativa por e-mail existe de verdade nesta unidade
(`/net/net/notification.html`, campos "SMTP Server Address"/"Device E-mail Address") — bate com o
que a documentação geral da família SyncThru/WBM já sugeria.

## Consequência prática pro plano da Onda 2

1. Subtarefa 2 (merge com status UniFi) precisa de fallback pra API clássica — 2 das 3
   impressoras reais só aparecem lá.
2. O tratamento de sentinela do poller SNMP (subtarefa 4/5) precisa cobrir `-1`, `-2` **e `-3`**
   (partial), não só os dois que o spec original citou.
3. A impressora Brother sem modelo confirmado deve ser tratada de forma genérica (RFC 3805 puro)
   até a Onda 1 revelar o que ela responde de fato.
4. Os OIDs numéricos acima são o ponto de partida do poller, mas a fonte de verdade final é a
   resposta real das 3 impressoras, testada na Onda 1 — não confiar cegamente nesta tabela.
