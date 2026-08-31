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

## Consequência prática pro plano da Onda 2

1. Subtarefa 2 (merge com status UniFi) precisa de fallback pra API clássica — 2 das 3
   impressoras reais só aparecem lá.
2. O tratamento de sentinela do poller SNMP (subtarefa 4/5) precisa cobrir `-1`, `-2` **e `-3`**
   (partial), não só os dois que o spec original citou.
3. A impressora Brother sem modelo confirmado deve ser tratada de forma genérica (RFC 3805 puro)
   até a Onda 1 revelar o que ela responde de fato.
4. Os OIDs numéricos acima são o ponto de partida do poller, mas a fonte de verdade final é a
   resposta real das 3 impressoras, testada na Onda 1 — não confiar cegamente nesta tabela.
