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

  getDeviceHealth: (site = env.UNIFI_CONTROLLER_SITE) => fetchDeviceHealth(site),

  getClientSignalStrength: (site = env.UNIFI_CONTROLLER_SITE) => fetchClientSignalStrength(site),

  getWanUptimeHistory: (site = env.UNIFI_CONTROLLER_SITE) => fetchWanUptimeHistory(site),

  getRawTrafficCounters: (site = env.UNIFI_CONTROLLER_SITE) => fetchRawTrafficCounters(site),

  getSshInfo: (site = env.UNIFI_CONTROLLER_SITE) => getSshInfo(site),

  rotateSshCredentials: (opts: { username?: string; password?: string }, site = env.UNIFI_CONTROLLER_SITE) =>
    rotateSshCredentials(opts, site),
};

export { UniFiClassicApiError, ClassicApiNotConfiguredError, UnknownClientError };
