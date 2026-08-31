const BASE_URL = '/api';

export class ApiError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export interface UniFiSite {
  id: string;
  internalReference?: string;
  name: string;
}

export interface UniFiClient {
  id: string;
  macAddress: string;
  ipAddress?: string;
  name?: string;
  hostname?: string;
  connectedAt?: string;
  type: 'WIRED' | 'WIRELESS';
  blocked: boolean;
}

export interface WifiBroadcast {
  id: string;
  name: string;
  enabled: boolean;
  type: string;
  securityConfiguration: { type: string; passphrase?: string };
  [key: string]: unknown;
}

export interface RadiusProfile {
  id: string;
  name: string;
}

export interface FirewallZone {
  id: string;
  name: string;
  networkIds?: string[];
  [key: string]: unknown;
}

export interface UniFiNetwork {
  id: string;
  name: string;
  management: string;
  enabled: boolean;
  vlanId?: number;
  zoneId?: string;
  ipv4Configuration?: {
    hostIpAddress?: string;
    prefixLength?: number;
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

export interface UniFiDevice {
  id: string;
  name: string;
  model: string;
  macAddress: string;
  ipAddress?: string;
  state: 'ONLINE' | 'OFFLINE' | 'PENDING' | 'UPDATING';
}

export interface UniFiDevicePort {
  idx: number;
  state: 'UP' | 'DOWN';
  connector?: string;
  maxSpeedMbps?: number;
  speedMbps?: number;
}

export interface UniFiDeviceDetail {
  id: string;
  macAddress: string;
  ipAddress?: string;
  name: string;
  model: string;
  state: 'ONLINE' | 'OFFLINE' | 'PENDING' | 'UPDATING';
  firmwareVersion?: string;
  interfaces?: {
    ports?: UniFiDevicePort[];
  };
}

export interface UniFiEventRecord {
  receivedAt: string;
  data: string;
}

export interface SecuritySummary {
  threatsDetected: number;
  ipsEnabled: boolean;
  signaturesActive: number;
  upgradableDeviceCount: number;
}

// Formato de cada item não é confirmado (o ambiente de teste não tinha
// nenhum evento crítico no momento) — tratado como registro genérico,
// renderizado de forma dinâmica no frontend, sem assumir campos fixos.
export type CriticalEvent = Record<string, unknown>;

export interface AdminRole {
  site_name?: string;
  role?: string;
  permissions?: unknown;
  [key: string]: unknown;
}

export interface Admin {
  name?: string;
  email?: string;
  roles?: AdminRole[];
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

export interface ClientSignal {
  mac: string;
  hostname: string;
  signalDbm?: number;
  rssi?: number;
  satisfactionScore?: number;
  channel?: number;
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

export interface BandwidthSnapshot {
  timestamp: string;
  perDevice: Array<{ mac: string; name: string; rxBytes: number; txBytes: number }>;
  perClient: Array<{ mac: string; hostname: string; rxBytes: number; txBytes: number }>;
}

export interface BandwidthDelta {
  intervalStart: string;
  intervalEnd: string;
  perDevice: Array<{ mac: string; name: string; rxBytes: number | null; txBytes: number | null }>;
  perClient: Array<{ mac: string; hostname: string; rxBytes: number | null; txBytes: number | null }>;
}

export interface SshInfo {
  sshEnabled: boolean;
  sshUsername: string;
  passwordAuthEnabled: boolean;
}

// --- Impressoras (módulo de manutenção) ---
// Shapes espelhando exatamente src/db/printers.db.ts e
// src/services/printer-network-status.service.ts do backend — nenhum campo
// inventado aqui. `snmpSecret` nunca é devolvido em nenhuma resposta (GET
// tanto quanto POST/PATCH), mesmo princípio de SshInfo acima.
export type PrinterSnmpVersion = 'v1' | 'v2c' | 'v3';

export interface PrinterMaintenancePolicy {
  intervalDays: number | null;
  intervalPages: number | null;
  consumableLowThresholdPct: number | null;
}

export interface Printer {
  id: string;
  name: string;
  mac: string;
  ipOverride: string | null;
  snmpVersion: PrinterSnmpVersion;
  maintenance: PrinterMaintenancePolicy;
  createdAt: string;
  updatedAt: string;
}

export interface PrinterNetworkStatus {
  source: 'integration' | 'classic' | 'unknown';
  online: boolean | null;
  ipAddress: string | null;
  connectionType: 'WIRED' | 'WIRELESS' | null;
}

export type PrinterWithNetwork = Printer & { network: PrinterNetworkStatus };

export interface PrinterSnmpV3Auth {
  username: string;
  authProtocol?: 'MD5' | 'SHA';
  authPassword?: string;
  privProtocol?: 'DES' | 'AES';
  privPassword?: string;
}

// Mesmo shape condicional aceito por POST/PATCH /printers (ver
// src/routes/printers.routes.ts, snmpSchema): community obrigatório em
// v1/v2c, v3Auth obrigatório em v3.
export type PrinterSnmpInput =
  | { version: 'v1' | 'v2c'; community: string }
  | { version: 'v3'; v3Auth: PrinterSnmpV3Auth };

export interface CreatePrinterBody {
  name: string;
  mac: string;
  ipOverride?: string;
  snmp: PrinterSnmpInput;
  maintenance?: Partial<PrinterMaintenancePolicy>;
}

// No PATCH `snmp` é opcional — omitir mantém o segredo/versão atuais (ver
// updatePrinterBody no backend).
export interface UpdatePrinterBody {
  name?: string;
  mac?: string;
  ipOverride?: string | null;
  snmp?: PrinterSnmpInput;
  maintenance?: Partial<PrinterMaintenancePolicy>;
}

export type ConsumableSupplyStatus = 'ok' | 'low' | 'unknown' | 'not-measured' | 'partial' | 'unsupported' | 'error';

export interface PrinterConsumableSupply {
  name: string;
  levelPercent: number | null;
  status: ConsumableSupplyStatus;
}

export interface PrinterConsumablesResponse {
  printerId: string;
  collectedAt: string | null;
  pageCount: number | null;
  lowThresholdPct: number | null;
  supplies: PrinterConsumableSupply[];
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

let accessToken: string | null = localStorage.getItem('unifi_token');
let refreshToken: string | null = localStorage.getItem('unifi_refresh_token');

export function getAccessToken() {
  return accessToken;
}

function setTokens(token: string, refresh?: string) {
  accessToken = token;
  localStorage.setItem('unifi_token', token);
  if (refresh) {
    refreshToken = refresh;
    localStorage.setItem('unifi_refresh_token', refresh);
  }
}

export function clearTokens() {
  accessToken = null;
  refreshToken = null;
  localStorage.removeItem('unifi_token');
  localStorage.removeItem('unifi_refresh_token');
}

async function refreshAccessToken(): Promise<boolean> {
  if (!refreshToken) return false;
  const res = await fetch(`${BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return false;
  const body = await res.json();
  setTokens(body.token);
  return true;
}

async function request<T>(path: string, init: RequestInit = {}, retry = true): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      // Fastify rejeita Content-Type: application/json com corpo vazio
      // ("Body cannot be empty..."), então só manda o header quando há body.
      ...(init.body ? { 'Content-Type': 'application/json' } : {}),
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      ...init.headers,
    },
  });

  if (res.status === 401 && retry && refreshToken) {
    const refreshed = await refreshAccessToken();
    if (refreshed) return request<T>(path, init, false);
  }

  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    // `details` carrega a mensagem real do controller UniFi (ex: "Port does
    // not support PoE") — sem isso, o usuário só via o genérico "Erro na
    // API do UniFi", sem saber o motivo de verdade.
    const detail =
      typeof body.details === 'string' ? body.details : body.details ? JSON.stringify(body.details) : undefined;
    const message = [body.error ?? res.statusText, detail].filter(Boolean).join(': ');
    throw new ApiError(res.status, message);
  }

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  async login(username: string, password: string) {
    const body = await request<{ token: string; refreshToken: string }>('/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    setTokens(body.token, body.refreshToken);
    return body;
  },

  logout() {
    clearTokens();
  },

  listSites: () => request<{ data: UniFiSite[] }>('/sites'),

  listClients: (params: { page?: number; pageSize?: number; type?: string; blocked?: boolean } = {}) => {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    if (params.type && params.type !== 'ALL') qs.set('type', params.type);
    if (params.blocked !== undefined) qs.set('blocked', String(params.blocked));
    return request<{ data: UniFiClient[]; pagination: Pagination }>(`/clients?${qs.toString()}`);
  },

  blockClient: (mac: string) => request<{ ok: true }>(`/clients/${mac}/block`, { method: 'POST' }),
  unblockClient: (mac: string) => request<{ ok: true }>(`/clients/${mac}/unblock`, { method: 'POST' }),

  listDevices: (params: { page?: number; pageSize?: number } = {}) => {
    const qs = new URLSearchParams();
    if (params.page) qs.set('page', String(params.page));
    if (params.pageSize) qs.set('pageSize', String(params.pageSize));
    return request<{ data: UniFiDevice[]; pagination: Pagination }>(`/devices?${qs.toString()}`);
  },

  restartDevice: (id: string) => request<{ ok: true }>(`/devices/${id}/restart`, { method: 'POST' }),

  getDevice: (id: string) => request<UniFiDeviceDetail>(`/devices/${id}`),

  powerCyclePort: (id: string, portIdx: number) =>
    request<{ ok: true }>(`/devices/${id}/ports/${portIdx}/power-cycle`, { method: 'POST' }),

  eventsHistory: (limit = 50) => request<{ data: UniFiEventRecord[] }>(`/events/history?limit=${limit}`),

  getSecuritySummary: () => request<SecuritySummary>('/security/summary'),
  getSecurityEvents: () => request<{ data: CriticalEvent[] }>('/security/events'),
  getAdmins: () => request<{ data: Admin[] }>('/security/admins'),

  // --- Redes Wi-Fi (SSIDs) ---
  listWifi: () => request<{ data: WifiBroadcast[] }>('/wifi'),
  // Perfis RADIUS cadastrados manualmente no painel do UniFi (ex: "RADIUS
  // Windows AD", apontando pro NPS do Windows Server) — só leitura, usado
  // pra popular o select de rede Enterprise/802.1X.
  listRadiusProfiles: () => request<{ data: RadiusProfile[] }>('/wifi/radius-profiles'),
  createWifi: (
    body:
      | { name: string; passphrase: string; hideName?: boolean; clientIsolationEnabled?: boolean }
      | {
          name: string;
          securityType: 'WPA2_ENTERPRISE' | 'WPA3_ENTERPRISE' | 'WPA2_WPA3_ENTERPRISE';
          radiusProfileId: string;
          hideName?: boolean;
          clientIsolationEnabled?: boolean;
        },
  ) => request<WifiBroadcast>('/wifi', { method: 'POST', body: JSON.stringify(body) }),
  setWifiPassword: (id: string, passphrase: string) =>
    request<WifiBroadcast>(`/wifi/${id}/password`, { method: 'PATCH', body: JSON.stringify({ passphrase }) }),
  setWifiEnabled: (id: string, enabled: boolean) =>
    request<WifiBroadcast>(`/wifi/${id}/enabled`, { method: 'PATCH', body: JSON.stringify({ enabled }) }),
  deleteWifi: (id: string) => request<{ ok: true }>(`/wifi/${id}`, { method: 'DELETE' }),

  // --- Networks (VLANs) ---
  listNetworks: () => request<{ data: UniFiNetwork[] }>('/networks'),
  listFirewallZones: () => request<{ data: FirewallZone[] }>('/networks/zones'),
  createNetwork: (body: {
    name: string;
    vlanId: number;
    hostIpAddress: string;
    prefixLength: number;
    internetAccessEnabled?: boolean;
    isolationEnabled?: boolean;
    zoneId?: string;
  }) => request<UniFiNetwork>('/networks', { method: 'POST', body: JSON.stringify(body) }),
  deleteNetwork: (id: string) => request<{ ok: true }>(`/networks/${id}`, { method: 'DELETE' }),

  // --- IP fixo por cliente ---
  setClientFixedIp: (mac: string, opts: { enabled: boolean; ip?: string; networkId?: string }) =>
    request<{ ok: true }>(`/clients/${mac}/fixed-ip`, { method: 'PATCH', body: JSON.stringify(opts) }),

  // --- Saúde operacional ---
  getDeviceHealth: () => request<{ data: DeviceHealth[] }>('/health/devices'),
  getClientSignalStrength: () => request<{ data: ClientSignal[] }>('/health/clients-signal'),
  getWanUptimeHistory: () => request<{ data: WanHistoryDetail[] }>('/health/wan-uptime'),

  // --- Histórico de uso de banda ---
  getBandwidthHistory: () => request<{ data: BandwidthSnapshot[] }>('/bandwidth/history'),
  getBandwidthSummary: () => request<{ data: BandwidthDelta[] }>('/bandwidth/history/summary'),

  // --- Credencial SSH dos equipamentos (APs/switches) ---
  // Configuração única por site (não por device) — GET nunca traz a senha
  // atual. O rotate devolve a senha NOVA em texto puro uma única vez: o
  // chamador é responsável por não logar/persistir esse retorno (ver
  // Security.tsx, que só guarda a senha no estado do componente).
  getSshInfo: () => request<SshInfo>('/ssh-credentials'),
  rotateSshCredentials: (opts: { username?: string; password?: string } = {}) =>
    request<{ sshUsername: string; sshPassword: string }>('/ssh-credentials/rotate', {
      method: 'POST',
      body: JSON.stringify(opts),
    }),

  // --- Apelido do cliente no UniFi (genérico por MAC, ver clients.routes.ts) ---
  setClientAlias: (mac: string, alias: string) =>
    request<{ ok: true }>(`/clients/${mac}/alias`, { method: 'PATCH', body: JSON.stringify({ alias }) }),

  // --- Impressoras (módulo de manutenção) ---
  listPrinters: () => request<PrinterWithNetwork[]>('/printers'),
  getPrinter: (id: string) => request<PrinterWithNetwork>(`/printers/${id}`),
  createPrinter: (body: CreatePrinterBody) =>
    request<Printer>('/printers', { method: 'POST', body: JSON.stringify(body) }),
  updatePrinter: (id: string, body: UpdatePrinterBody) =>
    request<Printer>(`/printers/${id}`, { method: 'PATCH', body: JSON.stringify(body) }),
  deletePrinter: (id: string) => request<{ ok: true }>(`/printers/${id}`, { method: 'DELETE' }),
  reconnectPrinter: (id: string) =>
    request<{ ok: true; note: string }>(`/printers/${id}/reconnect`, { method: 'POST' }),
  getPrinterConsumables: (id: string) => request<PrinterConsumablesResponse>(`/printers/${id}/consumables`),
};
