import { randomBytes } from 'node:crypto';
import { env } from '../config/env.js';

// Cliente para a API CLÁSSICA/privada do UniFi (a mesma usada pelo app
// UniFi Network internamente), não a Integration API oficial. Existe só
// porque a Integration API não suporta bloquear/desbloquear um cliente
// comum (só AUTHORIZE_GUEST_ACCESS/UNAUTHORIZE_GUEST_ACCESS, restrito a
// clientes guest) nem expõe o campo `blocked` de forma confiável. Isso foi
// confirmado testando contra um controller real e contra a doc OpenAPI
// oficial da Integration API.
//
// Como é uma API não-documentada, o controller pode mudar o formato sem
// aviso em atualizações de firmware — trate isso como mais frágil que o
// resto do projeto.

const BASE_URL = `https://${env.CONTROLLER_HOST}`;

class UniFiClassicApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'UniFiClassicApiError';
  }
}

// Lançado quando UNIFI_CONTROLLER_USER/UNIFI_CONTROLLER_PASSWORD não estão
// configurados — a feature de block/unblock fica indisponível de forma
// clara em vez de o app inteiro falhar ao subir (essas env vars são
// opcionais, ao contrário de CONTROLLER_HOST/UNIFI_API_KEY).
class ClassicApiNotConfiguredError extends Error {
  constructor() {
    super(
      'API clássica do controller não configurada: defina UNIFI_CONTROLLER_USER e ' +
        'UNIFI_CONTROLLER_PASSWORD no .env (as credenciais do PAINEL do controller, ' +
        'não ADMIN_USER/ADMIN_PASSWORD_HASH, que são o login deste dashboard).',
    );
    this.name = 'ClassicApiNotConfiguredError';
  }
}

// Sessão em memória a nível de módulo — mesmo padrão de estado-em-memória
// usado em unifi-events.hub.ts. Não persiste entre restarts do processo, e
// como o processo tipicamente roda uma única instância, não há necessidade
// de compartilhar isso entre processos.
let session: { cookie: string; csrfToken: string } | null = null;

function isClassicApiConfigured(): boolean {
  return Boolean(env.UNIFI_CONTROLLER_USER && env.UNIFI_CONTROLLER_PASSWORD);
}

async function login(): Promise<{ cookie: string; csrfToken: string }> {
  if (!isClassicApiConfigured()) {
    throw new ClassicApiNotConfiguredError();
  }

  const res = await fetch(`${BASE_URL}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username: env.UNIFI_CONTROLLER_USER,
      password: env.UNIFI_CONTROLLER_PASSWORD,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new UniFiClassicApiError(res.status, body || `Login na API clássica falhou (${res.status})`);
  }

  const setCookie = res.headers.get('set-cookie');
  const csrfToken = res.headers.get('x-csrf-token');

  if (!setCookie || !csrfToken) {
    throw new UniFiClassicApiError(
      502,
      'Login na API clássica não retornou Set-Cookie ou X-Csrf-Token — resposta inesperada do controller',
    );
  }

  // Só o primeiro cookie do header importa pra sessão (o resto são
  // atributos como Path/HttpOnly/SameSite, separados por ';').
  const cookie = setCookie.split(';')[0];

  session = { cookie, csrfToken };
  return session;
}

async function ensureSession(): Promise<{ cookie: string; csrfToken: string }> {
  if (session) return session;
  return login();
}

// Faz uma requisição autenticada na API clássica. O controller não
// documenta TTL de sessão, então tratamos qualquer 401 como "sessão
// expirou" e refazemos login uma única vez antes de desistir (evita loop
// infinito se as credenciais estiverem simplesmente erradas).
async function classicFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const current = await ensureSession();

  const doRequest = async (auth: { cookie: string; csrfToken: string }) =>
    fetch(`${BASE_URL}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        Cookie: auth.cookie,
        'X-Csrf-Token': auth.csrfToken,
        ...init.headers,
      },
    });

  let res = await doRequest(current);

  if (res.status === 401) {
    session = null;
    const refreshed = await login();
    res = await doRequest(refreshed);
  }

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    let message = body;
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed?.meta?.msg === 'string') message = parsed.meta.msg;
    } catch {
      // corpo não era JSON — mantém o texto cru
    }
    throw new UniFiClassicApiError(res.status, message || `API clássica do UniFi respondeu ${res.status}`);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

interface ClassicClient {
  mac: string;
  blocked?: boolean;
  // Campos usados pelo merge de status de rede do módulo de impressoras
  // (ver src/routes/printers.routes.ts): `is_wired` distingue cabeado/
  // sem-fio, `use_fixedip`/`fixed_ip` são o IP fixo (reserva de DHCP, mesmo
  // conceito de setClientFixedIp abaixo) e `last_ip` é o último IP dinâmico
  // observado quando o cliente NÃO usa IP fixo. Nenhum desses é a fonte de
  // verdade sobre o cliente estar online agora — /rest/user é o registro de
  // clientes CONHECIDOS pelo controller (histórico), não a lista de
  // conectados agora (essa é /stat/sta, usada em fetchClientSignalStrength/
  // fetchDeviceHealth acima). Por isso o merge de impressoras nunca deriva
  // "online" a partir daqui.
  is_wired?: boolean;
  use_fixedip?: boolean;
  fixed_ip?: string;
  last_ip?: string;
  [key: string]: unknown;
}

interface ClassicResponse<T> {
  meta: { rc: string; msg?: string };
  data: T;
}

// Lançado quando block/unblock é pedido para um MAC que o controller nunca
// viu na rede. O comando clássico `block-sta`/`unblock-sta` NÃO valida isso
// — se o MAC não existe ainda como cliente conhecido, o controller cria um
// registro "fantasma" novo (já bloqueado), em vez de recusar. Confirmado
// contra um controller real: bloquear um MAC nunca visto fez a contagem de
// clientes em /rest/user subir de 444 para 445. Por isso validamos aqui
// ANTES de mandar o comando.
class UnknownClientError extends UniFiClassicApiError {
  constructor(mac: string) {
    super(404, `Cliente ${mac} não é conhecido pelo controller (nunca foi visto na rede)`);
    this.name = 'UnknownClientError';
  }
}

async function fetchKnownClients(site: string): Promise<ClassicClient[]> {
  const { data } = await classicFetch<ClassicResponse<ClassicClient[]>>(
    `/proxy/network/api/s/${site}/rest/user`,
  );
  return data;
}

async function assertKnownClient(mac: string, site: string, knownClients?: ClassicClient[]): Promise<void> {
  const clients = knownClients ?? (await fetchKnownClients(site));
  const isKnown = clients.some((client) => client.mac.toLowerCase() === mac.toLowerCase());
  if (!isKnown) throw new UnknownClientError(mac);
}

// --- Descoberta de candidatos a impressora (achado 10 do CLAUDE.md) -------
//
// Decisão de arquitetura já registrada no CLAUDE.md: NÃO fazer varredura de
// rede ativa (scan de porta/broadcast SNMP) — arriscado, ruidoso e
// desnecessário. Em vez disso, reaproveita o que o controller UniFi já sabe
// (`rest/user`, mesma fonte de `fetchKnownClients`) e filtra por
// fabricante (`oui`) e padrão de hostname conhecidos de impressora.
//
// Confirmado ao vivo (sessão de continuação, rede real desta empresa) que um
// filtro ingênuo por substring de fabricante gera falsos positivos sérios:
// "Samsung Electronics Co.,Ltd" aparece tanto nas 2 impressoras reais quanto
// num ar-condicionado, um celular e um dispositivo sem hostname — Samsung
// fabrica muito mais que impressoras (a maioria das impressoras deste porte
// tem motor Samsung/HP-Samsung por baixo, mas o MAC/OUI de rede pode ser
// tanto do motor quanto de outro componente Samsung do aparelho anfitrião).
// Por isso os fabricantes ficam em duas categorias:
//   - INEQUÍVOCOS (`UNAMBIGUOUS_PRINTER_OUI_SUBSTRINGS`): "Brother
//     Industries", Kyocera, Xerox, Lexmark, Ricoh — fabricantes cujo negócio
//     é só impressão/imagem, sem linha de notebook/desktop/monitor. Basta
//     bater o OUI.
//   - AMBÍGUOS (`AMBIGUOUS_PRINTER_OUI_SUBSTRINGS`): Samsung, Canon, Epson,
//     e **HP Inc.** — fabricam impressoras E outras categorias de aparelho.
//     **CORREÇÃO (achado da revisão crítica, 2026-09-09)**: "HP Inc." estava
//     na lista de inequívocos com o comentário "nenhum outro tipo comum de
//     aparelho usa esse OUI" — factualmente errado. Desde a cisão HP
//     Inc./HPE (2015), "HP Inc." é o OUI de TODA a linha de PCs/notebooks/
//     monitores HP também, não só impressoras — um notebook HP comum na
//     rede entraria como falso candidato. Movido pra ambíguo: as 2 HPs reais
//     deste projeto continuam detectadas normalmente, porque o `name`
//     delas ("HPLaserMFP135w...") bate em `AMBIGUOUS_HOSTNAME_HINTS`
//     ("laser"/"mfp") — só o teste de fabricante sozinho que não basta mais.
//     Só contam como candidato se o `hostname` OU `name` também bater um
//     padrão de impressora — sem isso, o ar-condicionado do exemplo acima
//     (ou um notebook HP) entraria na lista.
// Prefixos de hostname Brother (`BRW`/`HLL`/`DCP`/`MFC`, já confirmados no
// achado 10 original) e HP (`NPI`, prefixo padrão de fábrica da linha
// JetDirect/embedded quando a impressora nunca foi renomeada) contam como
// sinal PRÓPRIO, independente do OUI — cobre o caso de uma impressora cujo
// OUI de rede não seja o do fabricante do motor (ex.: um adaptador Wi-Fi de
// outro fabricante).
const UNAMBIGUOUS_PRINTER_OUI_SUBSTRINGS = ['brother industries', 'kyocera', 'xerox', 'lexmark', 'ricoh'];
const AMBIGUOUS_PRINTER_OUI_SUBSTRINGS = ['samsung', 'canon', 'epson', 'hp inc'];
const AMBIGUOUS_HOSTNAME_HINTS = ['print', 'laser', 'mfp', 'ink', 'scan'];
const PRINTER_HOSTNAME_PREFIXES = ['brw', 'hll', 'dcp', 'mfc', 'npi'];

function containsAny(haystack: string, needles: string[]): boolean {
  return needles.some((needle) => haystack.includes(needle));
}

function looksLikePrinter(client: ClassicClient): boolean {
  const oui = typeof client.oui === 'string' ? client.oui.toLowerCase() : '';
  const hostname = typeof client.hostname === 'string' ? client.hostname.toLowerCase() : '';
  const name = typeof client.name === 'string' ? client.name.toLowerCase() : '';

  if (containsAny(oui, UNAMBIGUOUS_PRINTER_OUI_SUBSTRINGS)) return true;
  if (PRINTER_HOSTNAME_PREFIXES.some((prefix) => hostname.startsWith(prefix))) return true;
  if (containsAny(oui, AMBIGUOUS_PRINTER_OUI_SUBSTRINGS)) {
    return containsAny(hostname, AMBIGUOUS_HOSTNAME_HINTS) || containsAny(name, AMBIGUOUS_HOSTNAME_HINTS);
  }
  return false;
}

export interface PrinterDiscoveryCandidate {
  mac: string;
  hostname: string | null;
  name: string | null;
  oui: string | null;
  ipAddress: string | null;
}

// Não valida contra `printersRepository` aqui — este arquivo não conhece o
// módulo de impressoras (evita acoplamento de um serviço genérico do UniFi a
// um domínio específico). A rota (`GET /printers/discover-candidates`) cruza
// o resultado com o cadastro já existente antes de responder.
async function fetchPrinterDiscoveryCandidates(site: string): Promise<PrinterDiscoveryCandidate[]> {
  const clients = await fetchKnownClients(site);
  return clients.filter(looksLikePrinter).map((client) => ({
    mac: client.mac.toLowerCase(),
    hostname: typeof client.hostname === 'string' ? client.hostname : null,
    name: typeof client.name === 'string' ? client.name : null,
    oui: typeof client.oui === 'string' ? client.oui : null,
    ipAddress: toNetworkInfo(client).ipAddress,
  }));
}

// --- Merge de status de rede do módulo de impressoras (Onda 2, subtarefa 2) ---
//
// Reaproveita fetchKnownClients (mesma função já usada por getBlockedMacs)
// em vez de duplicar a lógica de fetch/login — só reprocessa o array cru de
// /rest/user num formato mais útil pro merge: um Map por MAC (minúsculo,
// mesma normalização usada no cadastro de impressoras) com IP e tipo de
// conexão. Uma chamada só, reaproveitada por todas as impressoras da
// listagem em GET /printers — igual ao padrão de getBlockedMacs em
// clients.routes.ts, que também busca uma vez e cruza localmente.
export interface ClassicClientNetworkInfo {
  ipAddress: string | null;
  connectionType: 'WIRED' | 'WIRELESS' | null;
}

function toNetworkInfo(client: ClassicClient): ClassicClientNetworkInfo {
  // Prioriza o IP fixo quando ligado (é o IP que o cliente de fato tem
  // enquanto use_fixedip estiver ativo) — senão cai pro último IP dinâmico
  // conhecido. Nenhum dos dois garante que o IP ainda está em uso agora
  // (ver nota em ClassicClient acima sobre `/rest/user` não ser a lista de
  // conectados).
  const ip = client.use_fixedip ? client.fixed_ip : client.last_ip;
  return {
    ipAddress: typeof ip === 'string' && ip.length > 0 ? ip : null,
    connectionType: typeof client.is_wired === 'boolean' ? (client.is_wired ? 'WIRED' : 'WIRELESS') : null,
  };
}

async function fetchKnownClientsNetworkInfo(site: string): Promise<Map<string, ClassicClientNetworkInfo>> {
  const clients = await fetchKnownClients(site);
  const info = new Map<string, ClassicClientNetworkInfo>();
  for (const client of clients) {
    info.set(client.mac.toLowerCase(), toNetworkInfo(client));
  }
  return info;
}

async function findClientByMac(mac: string, site: string): Promise<ClassicClient> {
  const clients = await fetchKnownClients(site);
  const client = clients.find((c) => c.mac.toLowerCase() === mac.toLowerCase());
  if (!client) throw new UnknownClientError(mac);
  return client;
}

// IP fixo (reserva de DHCP) por cliente. Esse conceito não existe na
// Integration API oficial — só no registro do cliente na API clássica
// (/rest/user), via os campos `use_fixedip`/`fixed_ip`. Reaproveita o mesmo
// lookup por MAC usado no bloqueio pra achar o `_id` do registro antes do
// PUT.
async function setFixedIp(
  mac: string,
  site: string,
  opts: { enabled: boolean; ip?: string; networkId?: string },
): Promise<ClassicResponse<unknown[]>> {
  const client = await findClientByMac(mac, site);
  const clientId = client._id as string | undefined;
  if (!clientId) {
    throw new UniFiClassicApiError(502, `Registro do cliente ${mac} não tem campo _id — resposta inesperada do controller`);
  }

  const body: Record<string, unknown> = { use_fixedip: opts.enabled };
  if (opts.enabled) {
    body.fixed_ip = opts.ip;
    if (opts.networkId) body.network_id = opts.networkId;
  }

  return classicFetch<ClassicResponse<unknown[]>>(`/proxy/network/api/s/${site}/rest/user/${clientId}`, {
    method: 'PUT',
    body: JSON.stringify(body),
  });
}

// "Apelido" do cliente, exibido no painel do UniFi — campo `name` do
// registro em /rest/user. Não confundir com `hostname` (o que o próprio
// dispositivo anuncia via DHCP/mDNS/NetBIOS) — ver `setHostname` logo
// abaixo pro porquê de `hostname` bruto não ser a rota certa pra sobrepor
// esse valor. Mesmo padrão de setFixedIp acima: busca o cliente por MAC pra
// pegar o `_id` e faz um PUT parcial só com o campo que muda — confirmado
// contra um controller real que /rest/user/{id} aceita atualização parcial
// (diferente do PUT de SSH em /set/setting/mgmt/{id}, que exige o objeto
// completo).
async function setAlias(mac: string, site: string, alias: string): Promise<ClassicResponse<unknown[]>> {
  const client = await findClientByMac(mac, site);
  const clientId = client._id as string | undefined;
  if (!clientId) {
    throw new UniFiClassicApiError(502, `Registro do cliente ${mac} não tem campo _id — resposta inesperada do controller`);
  }

  return classicFetch<ClassicResponse<unknown[]>>(`/proxy/network/api/s/${site}/rest/user/${clientId}`, {
    method: 'PUT',
    body: JSON.stringify({ name: alias }),
  });
}

// Lançado quando `setHostname` é chamado pra um cliente sem IP fixo
// habilitado — o mecanismo que funciona de verdade (`local_dns_record`,
// ver abaixo) exige isso, e o controller recusa com
// `api.err.LocalDnsRecordRequiresFixedIp` sem essa condição.
export class LocalDnsRecordRequiresFixedIpError extends UniFiClassicApiError {
  constructor(mac: string) {
    super(
      409,
      `Cliente ${mac} precisa ter IP fixo habilitado antes de definir um hostname local ` +
        '(configure via PATCH /clients/:mac/fixed-ip primeiro)',
    );
    this.name = 'LocalDnsRecordRequiresFixedIpError';
  }
}

// ACHADO AO VIVO — em duas rodadas (sessão de continuação do reboot HP,
// 2026-09-09). Uma impressora HP com IP estático teve o hostname de rede
// corrigido em 3 lugares diferentes DELA MESMA (SNMP sysName, TCP/IPv4,
// mDNS FQDN — e depois confirmado também via NetBIOS, `nbtstat`) e mesmo
// assim o UniFi nunca reaprendeu o valor novo sozinho: nem reboot, nem
// forçar reconexão, nem `forgetClient` (redescoberta completa), nem power
// cycle físico mudaram o `hostname` exibido no painel.
//
// RODADA 1 (abandonada): escrever `hostname` direto por PUT em
// `/rest/user/{id}` FUNCIONA — o controller aceita e devolve o valor novo
// na hora — mas **não é permanente**: confirmado ao vivo que reverte
// sozinho pro valor antigo em ~20 segundos (monitorado com leituras
// sucessivas). Isso indica um motor interno do controller (fingerprinting/
// descoberta, campo `confidence` no registro do cliente) que reafirma o
// `hostname` "aprendido" por cima de qualquer escrita direta nesse campo —
// não é um problema de cache parado, é uma disputa ativa de quem escreve
// por último.
//
// RODADA 2 (a que funciona): o registro do cliente tem um mecanismo OFICIAL
// pra isso — os campos `local_dns_record_enabled`/`local_dns_record`
// (visíveis na própria UI do controller como o checkbox "Registro DNS
// Local", ao lado de "Endereço IP Fixo"). Confirmado ao vivo que, uma vez
// habilitado, o valor de `local_dns_record` NÃO é sobrescrito pelo motor de
// fingerprinting (monitorado por mais de 100s sem reverter, contra os ~20s
// de vida do `hostname` bruto). Único requisito: o controller exige
// `use_fixedip: true` (com `fixed_ip` presente) na MESMA requisição —
// devolve `api.err.LocalDnsRecordRequiresFixedIp` sem isso.
async function setHostname(mac: string, site: string, hostname: string): Promise<ClassicResponse<unknown[]>> {
  const client = await findClientByMac(mac, site);
  const clientId = client._id as string | undefined;
  if (!clientId) {
    throw new UniFiClassicApiError(502, `Registro do cliente ${mac} não tem campo _id — resposta inesperada do controller`);
  }
  if (client.use_fixedip !== true || !client.fixed_ip) {
    throw new LocalDnsRecordRequiresFixedIpError(mac);
  }

  return classicFetch<ClassicResponse<unknown[]>>(`/proxy/network/api/s/${site}/rest/user/${clientId}`, {
    method: 'PUT',
    body: JSON.stringify({
      use_fixedip: true,
      fixed_ip: client.fixed_ip,
      local_dns_record_enabled: true,
      local_dns_record: hostname,
    }),
  });
}

async function setBlockedState(
  mac: string,
  site: string,
  cmd: 'block-sta' | 'unblock-sta',
): Promise<ClassicResponse<unknown[]>> {
  // Reaproveita a mesma busca de /rest/user pra validar que o MAC é
  // conhecido antes de mandar o comando — uma chamada extra por
  // block/unblock, mas evita criar o registro fantasma descrito acima.
  await assertKnownClient(mac, site);
  return classicFetch<ClassicResponse<unknown[]>>(`/proxy/network/api/s/${site}/cmd/stamgr`, {
    method: 'POST',
    body: JSON.stringify({ cmd, mac }),
  });
}

// "Esquecer" um cliente (achado ao vivo, sessão de continuação do reboot HP):
// o campo `hostname` de /rest/user é um cache do controller, aprendido uma
// vez (provavelmente no primeiro DHCPREQUEST que o cliente já mandou) e
// NUNCA reaprendido em reconexões seguintes — confirmado ao vivo contra a HP
// de Compras/Financeiro (172.16.0.34): nem reiniciar a impressora (novo
// hostname já confirmado via SNMP `sysName`) nem forçar block+unblock
// (desconexão/reconexão de rede) atualizaram o `hostname` cacheado. A forma
// documentada pela comunidade (não é API oficial/documentada pela Ubiquiti,
// mesmo espírito de risco do resto deste arquivo) de forçar o controller a
// esquecer e redescobrir um cliente do zero é `cmd: 'forget-sta'` neste
// mesmo endpoint `cmd/stamgr` — mas com `macs` (plural, array), diferente de
// `mac` (singular) usado por block-sta/unblock-sta.
//
// AÇÃO DESTRUTIVA: apaga o HISTÓRICO desse cliente no controller (gráficos
// de tráfego, primeira/última vez visto, etc.) — não afeta o equipamento
// físico nem sua configuração de rede. Nunca chamado automaticamente por
// nenhuma rota deste projeto; só disponível como utilidade pontual.
async function forgetClient(mac: string, site: string): Promise<ClassicResponse<unknown[]>> {
  await assertKnownClient(mac, site);
  return classicFetch<ClassicResponse<unknown[]>>(`/proxy/network/api/s/${site}/cmd/stamgr`, {
    method: 'POST',
    body: JSON.stringify({ cmd: 'forget-sta', macs: [mac] }),
  });
}

// --- Segurança e auditoria (Prioridade 2) ---
//
// Três endpoints adicionais da mesma API clássica, confirmados manualmente
// contra um controller real (UDM, UniFi OS 10.5.67, Network app):
//
// 1. /v2/api/site/{site}/aggregated-dashboard — traz, entre outras coisas,
//    o resumo do Threat Management/IPS (`cybersecure`) e a contagem de
//    dispositivos com firmware desatualizado (`upgradable_device_count`).
// 2. /v2/api/site/{site}/system-log/critical (POST, corpo vazio) — feed de
//    eventos/alarmes críticos. O formato de cada item não foi confirmado
//    (o ambiente de teste não tinha nenhum evento crítico no momento) —
//    repassamos o array cru, sem assumir nenhum campo específico.
// 3. /api/stat/admin — lista de admins com `roles` (permissões por site).
//    Existe também /proxy/users/api/v2/users/admin/uos (API de usuários a
//    nível de sistema UniFi OS, prefixo diferente), mas escolhemos
//    stat/admin porque reaproveita exatamente o mesmo padrão de sessão e
//    base URL já usado no resto deste arquivo, sem prefixo novo.
//
// Não implementado: log de login de administrador no controller — não foi
// encontrado nenhum endpoint confiável para isso (pesquisa extensiva feita
// pelo orquestrador, incluindo testes contra o controller real). Pode ser
// que esta versão do controller simplesmente não emita esse tipo de
// evento.

interface AggregatedDashboardResponse {
  cybersecure?: {
    ips_enabled?: boolean;
    threats?: number;
    signatures?: number;
    [key: string]: unknown;
  };
  upgradable_device_count?: {
    device_count?: number;
  };
  [key: string]: unknown;
}

export interface SecuritySummary {
  threatsDetected: number;
  ipsEnabled: boolean;
  signaturesActive: number;
  upgradableDeviceCount: number;
}

export interface ClassicAdmin {
  name?: string;
  email?: string;
  roles?: Array<{ site_name?: string; role?: string; permissions?: unknown; [key: string]: unknown }>;
  [key: string]: unknown;
}

async function fetchSecuritySummary(site: string): Promise<SecuritySummary> {
  const res = await classicFetch<AggregatedDashboardResponse>(
    `/proxy/network/v2/api/site/${site}/aggregated-dashboard?historySeconds=86400`,
  );
  return {
    threatsDetected: res.cybersecure?.threats ?? 0,
    ipsEnabled: res.cybersecure?.ips_enabled ?? false,
    signaturesActive: res.cybersecure?.signatures ?? 0,
    upgradableDeviceCount: res.upgradable_device_count?.device_count ?? 0,
  };
}

async function fetchCriticalEvents(site: string): Promise<Record<string, unknown>[]> {
  // Formato de retorno não confirmado além de "é um array" — tratado como
  // unknown[] de propósito, sem assumir campos específicos.
  const res = await classicFetch<unknown>(`/proxy/network/v2/api/site/${site}/system-log/critical`, {
    method: 'POST',
    body: JSON.stringify({}),
  });
  return Array.isArray(res) ? (res as Record<string, unknown>[]) : [];
}

async function fetchAdmins(): Promise<ClassicAdmin[]> {
  const { data } = await classicFetch<ClassicResponse<ClassicAdmin[]>>('/proxy/network/api/stat/admin');
  return data;
}

// --- Saúde operacional (Prioridade 3, parte 1) ---
//
// Três conjuntos de dados adicionais da mesma API clássica, confirmados
// manualmente contra um controller real:
//
// 1. POST /proxy/network/api/s/{site}/stat/device (body vazio) — traz TODOS
//    os devices (APs e switches) com CPU/memória/uptime, contagem de
//    clientes e, só em APs, utilização de canal e satisfação por rádio
//    (`radio_table_stats`). Switches puros não têm esse campo.
// 2. GET /proxy/network/api/s/{site}/stat/sta — traz TODOS os clientes
//    conectados agora, com muito mais detalhe que a Integration API,
//    incluindo força de sinal (`signal`, em dBm) pros clientes wireless.
//    Clientes com fio (`is_wired: true`) não têm esses campos.
// 3. GET /proxy/network/v2/api/site/{site}/aggregated-dashboard — mesmo
//    endpoint já usado em fetchSecuritySummary acima, mas aqui extraímos
//    `wan_history` em vez de `cybersecure`/`upgradable_device_count`. O
//    histórico de saúde do WAN (`health_history`, ~1 ponto a cada 5min nas
//    últimas 24h) já é mantido pelo próprio controller — não precisamos
//    persistir nada pra isso.

interface ClassicRadioTableStat {
  name?: string;
  radio?: string;
  channel?: number;
  cu_total?: number;
  satisfaction?: number;
  num_sta?: number;
  state?: string;
  [key: string]: unknown;
}

interface ClassicDevice {
  mac?: string;
  name?: string;
  'system-stats'?: { cpu?: string; mem?: string; uptime?: string };
  uptime?: number;
  num_sta?: number;
  radio_table_stats?: ClassicRadioTableStat[];
  [key: string]: unknown;
}

export interface DeviceRadioHealth {
  name: string;
  channel?: number;
  channelUtilizationPct?: number;
  satisfactionScore?: number;
  clientCount?: number;
}

export interface DeviceHealth {
  mac: string;
  name: string;
  cpu: number;
  mem: number;
  uptimeSeconds: number;
  clientCount: number;
  radios: DeviceRadioHealth[];
}

function toNumber(value: unknown): number {
  const n = typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : NaN;
  return Number.isFinite(n) ? n : 0;
}

async function fetchDeviceHealth(site: string): Promise<DeviceHealth[]> {
  const { data } = await classicFetch<ClassicResponse<ClassicDevice[]>>(
    `/proxy/network/api/s/${site}/stat/device`,
    { method: 'POST', body: JSON.stringify({}) },
  );

  return data.map((device) => ({
    mac: device.mac ?? '',
    name: device.name ?? device.mac ?? 'Dispositivo desconhecido',
    cpu: toNumber(device['system-stats']?.cpu),
    mem: toNumber(device['system-stats']?.mem),
    uptimeSeconds: toNumber(device.uptime ?? device['system-stats']?.uptime),
    clientCount: toNumber(device.num_sta),
    radios: (device.radio_table_stats ?? []).map((radio) => ({
      name: radio.name ?? radio.radio ?? '—',
      channel: radio.channel,
      channelUtilizationPct: radio.cu_total,
      satisfactionScore: radio.satisfaction,
      clientCount: radio.num_sta,
    })),
  }));
}

interface ClassicClientStation {
  mac?: string;
  hostname?: string;
  name?: string;
  is_wired?: boolean;
  signal?: number;
  rssi?: number;
  satisfaction?: number;
  channel?: number;
  [key: string]: unknown;
}

export interface ClientSignal {
  mac: string;
  hostname: string;
  signalDbm?: number;
  rssi?: number;
  satisfactionScore?: number;
  channel?: number;
}

async function fetchClientSignalStrength(site: string): Promise<ClientSignal[]> {
  const { data } = await classicFetch<ClassicResponse<ClassicClientStation[]>>(
    `/proxy/network/api/s/${site}/stat/sta`,
  );

  return data
    .filter((client) => client.is_wired !== true)
    .map((client) => ({
      mac: client.mac ?? '',
      hostname: client.hostname ?? client.name ?? client.mac ?? 'Cliente desconhecido',
      signalDbm: client.signal,
      rssi: client.rssi,
      satisfactionScore: client.satisfaction,
      channel: client.channel,
    }));
}

// Usado pelo merge de status de rede do módulo de impressoras
// (printer-network-status.service.ts) para dar um online/offline REAL às
// impressoras que só aparecem via API clássica (`rest/user`, achado 1 do
// CLAUDE.md) — `rest/user` é o registro de conhecidos, não de conectados
// agora; `stat/sta` (mesmo endpoint de fetchClientSignalStrength, mas SEM o
// filtro `is_wired !== true` dele, que descartaria impressoras cabeadas) é
// quem responde isso de verdade. Devolve só os MACs (minúsculos) — quem
// chama já tem o resto do dado (IP, tipo de conexão) vindo de
// getKnownClientsNetworkInfo.
async function fetchConnectedMacs(site: string): Promise<Set<string>> {
  const { data } = await classicFetch<ClassicResponse<ClassicClientStation[]>>(
    `/proxy/network/api/s/${site}/stat/sta`,
  );
  return new Set(data.map((client) => client.mac?.toLowerCase()).filter((mac): mac is string => Boolean(mac)));
}

export interface WanHealthPoint {
  timestamp?: number;
  wan_downtime?: boolean;
  high_latency?: boolean;
  packet_loss?: boolean;
  failover_wan_active?: boolean;
  wan2_failover_active?: boolean;
  [key: string]: unknown;
}

export interface WanHistoryDetail {
  downtime_history?: unknown[];
  health_history?: WanHealthPoint[];
  [key: string]: unknown;
}

interface AggregatedDashboardWanResponse {
  wan_history?: {
    wan_history_details?: WanHistoryDetail[];
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

async function fetchWanUptimeHistory(site: string): Promise<WanHistoryDetail[]> {
  const res = await classicFetch<AggregatedDashboardWanResponse>(
    `/proxy/network/v2/api/site/${site}/aggregated-dashboard?historySeconds=86400`,
  );
  return res.wan_history?.wan_history_details ?? [];
}

// --- Histórico de uso de banda (Prioridade 3, parte 2) ---
//
// stat/device e stat/sta (os mesmos dois endpoints já usados em
// fetchDeviceHealth/fetchClientSignalStrength acima) também trazem
// `tx_bytes`/`rx_bytes` — contadores CUMULATIVOS de bytes transmitidos/
// recebidos desde que o device ligou (stat/device) ou o cliente conectou
// (stat/sta). Não reaproveitamos fetchDeviceHealth/fetchClientSignalStrength
// porque eles filtram/remodelam o dado pra outro propósito (saúde de CPU/
// sinal) e um deles (fetchClientSignalStrength) descarta clientes com fio —
// pra banda queremos todos. Em vez disso, uma função enxuta própria que só
// extrai mac/nome + os dois contadores, reusando classicFetch/toNumber.
// Quem consome esses contadores cumulativos (bandwidth-history.service.ts)
// é responsável por calcular a diferença entre amostras — aqui devolvemos
// o valor cru, sem fazer suposição de intervalo.
export interface RawTrafficCounters {
  perDevice: Array<{ mac: string; name: string; rxBytes: number; txBytes: number }>;
  perClient: Array<{ mac: string; hostname: string; rxBytes: number; txBytes: number }>;
}

async function fetchRawTrafficCounters(site: string): Promise<RawTrafficCounters> {
  const [devicesRes, clientsRes] = await Promise.all([
    classicFetch<ClassicResponse<ClassicDevice[]>>(`/proxy/network/api/s/${site}/stat/device`, {
      method: 'POST',
      body: JSON.stringify({}),
    }),
    classicFetch<ClassicResponse<ClassicClientStation[]>>(`/proxy/network/api/s/${site}/stat/sta`),
  ]);

  return {
    perDevice: devicesRes.data.map((device) => ({
      mac: device.mac ?? '',
      name: device.name ?? device.mac ?? 'Dispositivo desconhecido',
      rxBytes: toNumber(device.rx_bytes),
      txBytes: toNumber(device.tx_bytes),
    })),
    perClient: clientsRes.data.map((client) => ({
      mac: client.mac ?? '',
      hostname: client.hostname ?? client.name ?? client.mac ?? 'Cliente desconhecido',
      rxBytes: toNumber(client.rx_bytes),
      txBytes: toNumber(client.tx_bytes),
    })),
  };
}

// --- Senha de administração/SSH dos equipamentos (APs/switches) ---
//
// Confirmado contra um controller real (incluindo um PUT no-op que devolveu
// os mesmos valores sem mudar nada de verdade): a credencial de SSH dos
// equipamentos é uma configuração ÚNICA POR SITE — não por device — guardada
// no objeto de settings com "key": "mgmt". Ela se aplica a TODOS os
// APs/switches adotados daquele site de uma vez; não existe SSH por
// dispositivo separado nesse contexto.
//
//   GET /proxy/network/api/s/{site}/get/setting        -> array de settings
//   PUT /proxy/network/api/s/{site}/set/setting/mgmt/{_id}  -> objeto COMPLETO de volta
//
// O PUT é de objeto inteiro, igual ao padrão já usado no módulo de Wi-Fi/
// networks: buscamos tudo, alteramos só os campos desejados e mandamos o
// objeto inteiro de volta — omitir um campo o apagaria/zeraria no
// controller.
//
// SEGURANÇA — regra não-negociável deste módulo: `MgmtSetting` (com os
// campos sensíveis: x_ssh_password, x_ssh_sha512passwd, x_api_token,
// x_mgmt_key) é um tipo PRIVADO deste arquivo e nunca é exportado. Toda
// leitura pública passa por `SshInfo`, que só expõe usuário/estado —
// jamais a senha atual ou os outros segredos do objeto. A única exceção
// intencional é `rotateSshCredentials`: como é o próprio ato de troca, a
// senha NOVA é devolvida em texto puro UMA ÚNICA VEZ nessa resposta — é
// assim que quem trocou fica sabendo a senha nova (não há outra forma de
// recuperá-la depois, nem por essa API nem pelo dashboard).
interface MgmtSetting {
  _id: string;
  key: 'mgmt';
  site_id?: string;
  x_ssh_enabled?: boolean;
  x_ssh_username?: string;
  x_ssh_password?: string;
  x_ssh_sha512passwd?: string;
  x_ssh_auth_password_enabled?: boolean;
  x_ssh_bind_wildcard?: boolean;
  x_api_token?: string;
  x_mgmt_key?: string;
  [key: string]: unknown;
}

export interface SshInfo {
  sshEnabled: boolean;
  sshUsername: string;
  passwordAuthEnabled: boolean;
}

async function fetchMgmtSetting(site: string): Promise<MgmtSetting> {
  const { data } = await classicFetch<ClassicResponse<MgmtSetting[]>>(`/proxy/network/api/s/${site}/get/setting`);
  const mgmt = data.find((setting) => setting.key === 'mgmt');
  if (!mgmt) {
    throw new UniFiClassicApiError(
      502,
      'Configuração "mgmt" (SSH dos equipamentos) não encontrada em get/setting — resposta inesperada do controller',
    );
  }
  return mgmt;
}

function toSshInfo(mgmt: MgmtSetting): SshInfo {
  return {
    sshEnabled: Boolean(mgmt.x_ssh_enabled),
    sshUsername: mgmt.x_ssh_username ?? '',
    passwordAuthEnabled: Boolean(mgmt.x_ssh_auth_password_enabled),
  };
}

async function getSshInfo(site: string): Promise<SshInfo> {
  const mgmt = await fetchMgmtSetting(site);
  return toSshInfo(mgmt);
}

// Senha forte aleatória gerada com node:crypto (não Math.random) — 24 bytes
// aleatórios em base64url dão 32 caracteres sem caracteres problemáticos
// pra um campo de senha (sem +, /, = do base64 padrão).
function generateStrongPassword(): string {
  return randomBytes(24).toString('base64url');
}

async function rotateSshCredentials(
  opts: { username?: string; password?: string },
  site: string,
): Promise<{ sshUsername: string; sshPassword: string }> {
  const current = await fetchMgmtSetting(site);

  const sshUsername = opts.username ?? current.x_ssh_username ?? '';
  const sshPassword = opts.password ?? generateStrongPassword();

  // PUT de objeto completo: preserva TODOS os outros campos do GET original
  // (_id, key, site_id, x_api_token, x_mgmt_key, wifiman_enabled, etc.) e
  // troca só username/senha. x_ssh_sha512passwd fica desatualizado no
  // objeto que temos em mãos, mas não é enviado por nós — é o próprio
  // controller que recalcula o hash a partir de x_ssh_password ao
  // processar o PUT.
  const updated: MgmtSetting = {
    ...current,
    x_ssh_username: sshUsername,
    x_ssh_password: sshPassword,
  };

  await classicFetch<ClassicResponse<MgmtSetting[]>>(
    `/proxy/network/api/s/${site}/set/setting/mgmt/${current._id}`,
    { method: 'PUT', body: JSON.stringify(updated) },
  );

  return { sshUsername, sshPassword };
}

export const unifiClassicService = {
  isConfigured: isClassicApiConfigured,

  blockClient: (mac: string, site = env.UNIFI_CONTROLLER_SITE) => setBlockedState(mac, site, 'block-sta'),

  unblockClient: (mac: string, site = env.UNIFI_CONTROLLER_SITE) => setBlockedState(mac, site, 'unblock-sta'),

  // Utilidade pontual (não exposta em nenhuma rota) — ver a DECISÃO em
  // `forgetClient` acima sobre por que isso existe e o que é destrutivo nele.
  forgetClient: (mac: string, site = env.UNIFI_CONTROLLER_SITE) => forgetClient(mac, site),

  // Usada pelo merge de status de rede do módulo de impressoras
  // (src/routes/printers.routes.ts) como fallback quando o MAC não aparece
  // na Integration API — ver `fetchKnownClientsNetworkInfo` acima.
  getKnownClientsNetworkInfo: (site = env.UNIFI_CONTROLLER_SITE): Promise<Map<string, ClassicClientNetworkInfo>> =>
    fetchKnownClientsNetworkInfo(site),

  getBlockedMacs: async (site = env.UNIFI_CONTROLLER_SITE): Promise<Set<string>> => {
    const clients = await fetchKnownClients(site);
    const blocked = new Set<string>();
    for (const client of clients) {
      if (client.blocked) blocked.add(client.mac);
    }
    return blocked;
  },

  getSecuritySummary: (site = env.UNIFI_CONTROLLER_SITE) => fetchSecuritySummary(site),

  getCriticalEvents: (site = env.UNIFI_CONTROLLER_SITE) => fetchCriticalEvents(site),

  getAdmins: () => fetchAdmins(),

  setClientFixedIp: (
    mac: string,
    opts: { enabled: boolean; ip?: string; networkId?: string },
    site = env.UNIFI_CONTROLLER_SITE,
  ) => setFixedIp(mac, site, opts),

  setClientAlias: (mac: string, alias: string, site = env.UNIFI_CONTROLLER_SITE) => setAlias(mac, site, alias),

  getDeviceHealth: (site = env.UNIFI_CONTROLLER_SITE) => fetchDeviceHealth(site),

  getClientSignalStrength: (site = env.UNIFI_CONTROLLER_SITE) => fetchClientSignalStrength(site),

  // MACs conectados agora de verdade (`stat/sta`) — ver `fetchConnectedMacs`
  // acima. Usado só pelo merge de status de rede do módulo de impressoras.
  getConnectedMacs: (site = env.UNIFI_CONTROLLER_SITE) => fetchConnectedMacs(site),

  setClientHostname: (mac: string, hostname: string, site = env.UNIFI_CONTROLLER_SITE) =>
    setHostname(mac, site, hostname),

  getWanUptimeHistory: (site = env.UNIFI_CONTROLLER_SITE) => fetchWanUptimeHistory(site),

  getRawTrafficCounters: (site = env.UNIFI_CONTROLLER_SITE) => fetchRawTrafficCounters(site),

  getSshInfo: (site = env.UNIFI_CONTROLLER_SITE) => getSshInfo(site),

  // Candidatos a impressora ainda não cadastrados no módulo (achado 10 do
  // CLAUDE.md) — ver `fetchPrinterDiscoveryCandidates` acima.
  getPrinterDiscoveryCandidates: (site = env.UNIFI_CONTROLLER_SITE) => fetchPrinterDiscoveryCandidates(site),

  rotateSshCredentials: (opts: { username?: string; password?: string }, site = env.UNIFI_CONTROLLER_SITE) =>
    rotateSshCredentials(opts, site),
};

export { UniFiClassicApiError, ClassicApiNotConfiguredError, UnknownClientError };
