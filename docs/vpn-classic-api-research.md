# VPN no UniFi — o que a API realmente expõe (pesquisa da subtarefa 0)

> Mesmo espírito de `printers-snmp-research.md` e `fake-ldap-rfc-vs-real.md`: **comportamento
> observado contra o controller real**, nunca suposto. Tudo abaixo veio de requisições
> **SOMENTE LEITURA** (`tools/vpn-discovery-probe.mjs`) — nenhuma escrita foi feita.

## Ambiente medido

| | |
|---|---|
| Data | 2026-09-15 |
| Controller | UniFi Network **10.6.101** |
| Console | **UDR Ultra** (`UDRULT.ipq5322.v5.1.33.44ce47b.260909.0025`) |
| Site clássico | `default` · Site Integration API `88f7af54-98f8-306a-a1c7-c9349722b1f6` |

## Achado principal: VPN não tem "API de VPN" na clássica — é `rest/networkconf`

Os servidores de VPN de acesso remoto **são entradas de rede** com `purpose: "remote-user-vpn"`,
no mesmo `rest/networkconf` que guarda LAN/VLAN/WAN. Não existe `/vpn`, `/vpn/servers` nem
`v2/api/site/<site>/vpn` na clássica — **todos os três responderam 404** (testados).

```
GET /proxy/network/api/s/default/rest/networkconf   -> 200, 6 redes
```

| name | purpose | vpn_type | _id | external_id |
|---|---|---|---|---|
| Rede Solution | `wan` | — | `691d…84ae` | — |
| Default | `corporate` | — | `691d…84af` | — |
| Turbo Conect | `wan` | — | `691d…84be` | — |
| **One-Click VPN** | `remote-user-vpn` | **`wireguard-server`** | `6925f7ca822d59605439f112` | `fcc3f7db-168d-4a1e-8930-d1f201411f8a` |
| **OpenVPN Server** | `remote-user-vpn` | **`openvpn-server`** | `6a3c197e095c8457f04debe0` | `6f0c79f6-57eb-4959-b0e6-58b94d1a9da1` |
| Evok-Corporativa | `corporate` | — | `6a61…1c55` | — |

**Consequência de arquitetura**: criar/editar/remover VPN é `POST`/`PUT`/`DELETE` em
`rest/networkconf` — o mesmo idioma REST clássico que o projeto já usa em `rest/user`
(IP fixo, apelido, hostname) e `rest/setting/mgmt` (SSH). O `PUT` do `networkconf` é
**full-object**, como o `mgmt` do SSH: o padrão obrigatório é **GET completo → trocar só os
campos pedidos → PUT do objeto inteiro** (subtarefa 3 do plano).

## Campos reais dos dois servidores existentes

Chaves com `x_` (material criptográfico) e `private_key` estão **redigidas aqui de propósito** —
existem no objeto e **precisam ser preservadas no PUT de edição**; perdê-las invalida a VPN.

### WireGuard (`One-Click VPN`)

```json
{
  "_id": "6925f7ca822d59605439f112",
  "external_id": "fcc3f7db-168d-4a1e-8930-d1f201411f8a",
  "name": "One-Click VPN",
  "purpose": "remote-user-vpn",
  "vpn_type": "wireguard-server",
  "enabled": true,
  "setting_preference": "auto",
  "ip_subnet": "192.168.11.1/24",
  "local_port": 51820,
  "wireguard_interface": "wan",
  "wireguard_local_wan_ip": "any",
  "wireguard_id": 1,
  "wireguard_interface_binding_mode_ip_version": "v4",
  "vpn_binding_mode": "interface",
  "x_wireguard_private_key": "<REDIGIDO — presente no objeto>",
  "interface_mtu_enabled": false,
  "mss_clamp": "auto",
  "firewall_zone_id": "6a8595b0596728392798c257",
  "site_id": "691d468f4464870d74d48495"
}
```

### OpenVPN (`OpenVPN Server`)

```json
{
  "_id": "6a3c197e095c8457f04debe0",
  "external_id": "6f0c79f6-57eb-4959-b0e6-58b94d1a9da1",
  "name": "OpenVPN Server",
  "purpose": "remote-user-vpn",
  "vpn_type": "openvpn-server",
  "enabled": true,
  "setting_preference": "manual",
  "ip_subnet": "10.132.135.1/24",
  "dhcpd_start": "10.132.135.2",
  "dhcpd_stop": "10.132.135.254",
  "dhcpd_dns_enabled": false,
  "dhcpd_wins_enabled": false,
  "local_port": 51194,
  "openvpn_interface": "wan",
  "openvpn_local_wan_ip": "any",
  "openvpn_id": 1,
  "openvpn_compression_disabled": true,
  "vpn_client_configuration_remote_ip_override_enabled": false,
  "radiusprofile_id": "691d46944464870d74d484a8",
  "mss_clamp": "auto",
  "firewall_zone_id": "6a8595b0596728392798c257",
  "site_id": "691d468f4464870d74d48495",
  "x_ca_crt": "<REDIGIDO>", "x_ca_key": "<REDIGIDO>",
  "x_server_crt": "<REDIGIDO>", "x_server_key": "<REDIGIDO>",
  "x_dh_key": "<REDIGIDO>", "x_auth_key": "<REDIGIDO>",
  "x_shared_client_crt": "<REDIGIDO>", "x_shared_client_key": "<REDIGIDO>"
}
```

**Nota de segurança que já muda o desenho da subtarefa 1**: o objeto cru carrega chave privada
WireGuard e a CA/chave do servidor OpenVPN. Qualquer rota de leitura deste dashboard tem de
**filtrar por allowlist de campos** (nunca `delete` de blocklist) — mesmo regime do segredo SNMP
e do `wbmCredentials`.

## Teleport e Site-to-Site NÃO são `networkconf`

Vivem em `rest/setting`, o que **invalida a premissa de "criar/editar/remover"** para eles:

| `key` | conteúdo real | o que dá pra fazer |
|---|---|---|
| `teleport` | `{ enabled: true }` — só isso | **liga/desliga**, não tem CRUD |
| `magic_site_to_site_vpn` | `{ enabled: true, public_key, x_private_key }` | Site Magic: liga/desliga + par de chaves |
| `openvpn` | `x_pregenerated_dh_key` | material global, não um servidor |
| `ipsec`, `radius` | — | relacionados, não inspecionados a fundo |

**Nenhum túnel site-to-site clássico existe hoje neste site** (`purpose: "site-vpn"` não aparece
em `networkconf`), então **não há objeto real para modelar a subtarefa 5** — ela continua
dependendo de captura ao vivo, e é a única que realmente precisa do DevTools para a LEITURA.

## Integration API oficial: existe, e é só uma lista

```
GET /proxy/network/integration/v1/sites/{siteId}/vpn/servers   -> 200
{"offset":0,"limit":25,"count":2,"totalCount":2,"data":[
  {"type":"WIREGUARD","id":"fcc3f7db-…","name":"One-Click VPN","enabled":true,
   "metadata":{"origin":"USER_DEFINED"}},
  {"type":"OPENVPN","id":"6f0c79f6-…","name":"OpenVPN Server","enabled":true,
   "metadata":{"origin":"USER_DEFINED"}}]}
```

Testados e **404**: `…/vpn`, `…/vpn-servers`, `…/vpn/servers/{id}` (detalhe), `…/vpn/clients`,
`…/vpn/site-to-site`, `…/vpn/tunnels`, `…/vpn-tunnels`.

**O `id` da Integration API é o `external_id` do `networkconf`** — confirmado nos dois servidores.
Essa é a ponte que permite listar pelo canal oficial (estável) e escrever pelo clássico
(`_id`), sem inventar correlação por nome.

Ou seja, a Integration API dá: tipo, id, nome, enabled. **Não dá** sub-rede, porta, interface,
status de conexão, nem nada de site-to-site — e não escreve nada.

## O que AINDA precisa de captura no DevTools (o gate continua de pé, menor)

A leitura e o formato dos objetos existentes estão resolvidos sem DevTools. Falta só o que
**nenhum GET revela**:

1. **POST de criação** — quais campos o controller EXIGE vs. preenche sozinho
   (`wireguard_id`/`openvpn_id`/`external_id`/`firewall_zone_id`/chaves são gerados pelo
   servidor? O `x_wireguard_private_key` vem do navegador ou do controller?). **Esta é a única
   pergunta que sobrou de verdade**, e é o coração da subtarefa 2.
2. **PUT de edição** — se a UI manda objeto inteiro ou parcial (esperado: inteiro).
3. **DELETE** — path/resposta, e o que acontece com uma VPN em uso.
4. **Site-to-site** — criar um túnel de teste é o único jeito de ver o objeto.
5. **Teleport** — confirmar que é só `PUT rest/setting/teleport {enabled}`.

Roteiro de captura, por operação: **path + método + corpo enviado + resposta** — e, para
edição, o **GET que a UI faz antes**, que é o que prova se o PUT é full-object.

## Sondas

`tools/vpn-discovery-probe.mjs` — **somente leitura**, redige `x_*`/`private_key` na saída.
Não faz nenhuma requisição de escrita.
