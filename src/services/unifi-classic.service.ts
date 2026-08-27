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
};

export { UniFiClassicApiError, ClassicApiNotConfiguredError, UnknownClientError };
