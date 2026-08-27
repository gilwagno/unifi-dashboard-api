import { env } from '../config/env.js';
import type {
  UniFiClient,
  UniFiDevice,
  UniFiDeviceDetail,
  UniFiFirewallZone,
  UniFiNetwork,
  UniFiNetworkCreate,
  UniFiSite,
  UniFiWifiBroadcast,
  UniFiWifiBroadcastCreate,
} from '../types/unifi.js';

const BASE_URL = `https://${env.CONTROLLER_HOST}/proxy/network/integration/v1`;

// Controllers locais quase sempre usam certificado autoassinado. O fetch
// nativo do Node não aceita um https.Agent nem um dispatcher externo do
// pacote `undici` pra desativar a verificação de TLS de forma confiável
// (a interface interna muda entre versões do Node e do pacote) — a forma
// suportada é essa flag de processo. Como as únicas chamadas HTTPS deste
// processo são para o controller UniFi, o escopo do risco é esse; ainda
// assim, só desative isso em rede local/confiável, nunca pra falar com
// hosts na internet.
if (env.UNIFI_ALLOW_SELF_SIGNED) {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

class UniFiApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'UniFiApiError';
  }
}

async function unifiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      'X-API-Key': env.UNIFI_API_KEY,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...init.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    // Erros do controller vêm como JSON ({ code, message, ... }) — usa a
    // mensagem real quando dá pra parsear, em vez de jogar o corpo cru
    // (que inclui requestPath/requestId/timestamp) pro usuário final ler.
    let message = body;
    try {
      const parsed = JSON.parse(body);
      if (typeof parsed.message === 'string') message = parsed.message;
    } catch {
      // corpo não era JSON — mantém o texto cru
    }
    throw new UniFiApiError(res.status, message || `UniFi API respondeu ${res.status}`);
  }

  // Não basta confiar em `res.status === 204` pra saber que não há corpo:
  // confirmado contra um controller real que alguns endpoints (ex: DELETE
  // /wifi/broadcasts/{id} e DELETE /networks/{id}) respondem 200 com corpo
  // completamente vazio (content-type null, body length 0). Chamar
  // `res.json()` direto nesse caso lança (JSON inválido: string vazia), o
  // que virava um 500 genérico escondendo que a ação tinha funcionado de
  // verdade no controller. Por isso lê como texto primeiro e só faz
  // JSON.parse quando há de fato algo pra parsear.
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export const unifiService = {
  listSites: () => unifiFetch<{ data: UniFiSite[] }>('/sites'),

  listClients: (siteId = env.SITE_ID) =>
    unifiFetch<{ data: UniFiClient[] }>(`/sites/${siteId}/clients`),

  listDevices: (siteId = env.SITE_ID) =>
    unifiFetch<{ data: UniFiDevice[] }>(`/sites/${siteId}/devices`),

  getDevice: (deviceId: string, siteId = env.SITE_ID) =>
    unifiFetch<UniFiDeviceDetail>(`/sites/${siteId}/devices/${deviceId}`),

  restartDevice: (deviceId: string, siteId = env.SITE_ID) =>
    unifiFetch<void>(`/sites/${siteId}/devices/${deviceId}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'RESTART' }),
    }),

  // Power-cycle de uma porta PoE de um switch. A API de Integração do
  // UniFi NÃO suporta habilitar/desabilitar porta remotamente — a única
  // ação válida confirmada contra o controller é 'POWER_CYCLE' (o
  // controller rejeita qualquer outro valor com 400 listando os válidos).
  // Isso força um reboot de qualquer coisa PoE conectada naquela porta.
  powerCyclePort: (deviceId: string, portIdx: number, siteId = env.SITE_ID) =>
    unifiFetch<void>(`/sites/${siteId}/devices/${deviceId}/interfaces/ports/${portIdx}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'POWER_CYCLE' }),
    }),

  // --- Wi-Fi (SSIDs) — GET/POST/PUT/DELETE /sites/{siteId}/wifi/broadcasts ---

  listWifiBroadcasts: (siteId = env.SITE_ID) =>
    unifiFetch<{ data: UniFiWifiBroadcast[] }>(`/sites/${siteId}/wifi/broadcasts`),

  getWifiBroadcast: (wifiBroadcastId: string, siteId = env.SITE_ID) =>
    unifiFetch<UniFiWifiBroadcast>(`/sites/${siteId}/wifi/broadcasts/${wifiBroadcastId}`),

  createWifiBroadcast: (body: UniFiWifiBroadcastCreate, siteId = env.SITE_ID) =>
    unifiFetch<UniFiWifiBroadcast>(`/sites/${siteId}/wifi/broadcasts`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteWifiBroadcast: (wifiBroadcastId: string, siteId = env.SITE_ID) =>
    unifiFetch<void>(`/sites/${siteId}/wifi/broadcasts/${wifiBroadcastId}`, { method: 'DELETE' }),

  // PUT substitui o objeto inteiro (não é PATCH parcial) — por isso as duas
  // operações abaixo fazem GET do broadcast atual, trocam só o campo
  // pedido, e mandam o objeto inteiro de volta, preservando todo o resto
  // exatamente como estava.
  updateWifiBroadcastPassword: async (
    wifiBroadcastId: string,
    passphrase: string,
    siteId = env.SITE_ID,
  ): Promise<UniFiWifiBroadcast> => {
    const current = await unifiFetch<UniFiWifiBroadcast>(`/sites/${siteId}/wifi/broadcasts/${wifiBroadcastId}`);
    const updated: UniFiWifiBroadcast = {
      ...current,
      securityConfiguration: { ...current.securityConfiguration, passphrase },
    };
    return unifiFetch<UniFiWifiBroadcast>(`/sites/${siteId}/wifi/broadcasts/${wifiBroadcastId}`, {
      method: 'PUT',
      body: JSON.stringify(updated),
    });
  },

  setWifiBroadcastEnabled: async (
    wifiBroadcastId: string,
    enabled: boolean,
    siteId = env.SITE_ID,
  ): Promise<UniFiWifiBroadcast> => {
    const current = await unifiFetch<UniFiWifiBroadcast>(`/sites/${siteId}/wifi/broadcasts/${wifiBroadcastId}`);
    const updated: UniFiWifiBroadcast = { ...current, enabled };
    return unifiFetch<UniFiWifiBroadcast>(`/sites/${siteId}/wifi/broadcasts/${wifiBroadcastId}`, {
      method: 'PUT',
      body: JSON.stringify(updated),
    });
  },

  // --- Networks (VLANs) — GET/POST/DELETE /sites/{siteId}/networks ---

  listNetworks: (siteId = env.SITE_ID) => unifiFetch<{ data: UniFiNetwork[] }>(`/sites/${siteId}/networks`),

  createNetwork: (body: UniFiNetworkCreate, siteId = env.SITE_ID) =>
    unifiFetch<UniFiNetwork>(`/sites/${siteId}/networks`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  deleteNetwork: (networkId: string, siteId = env.SITE_ID) =>
    unifiFetch<void>(`/sites/${siteId}/networks/${networkId}`, { method: 'DELETE' }),

  // Zonas de firewall (ex: "Internal", "External", "DMZ") — toda network
  // precisa referenciar uma via `zoneId` (ver UniFiNetworkCreate).
  listFirewallZones: (siteId = env.SITE_ID) =>
    unifiFetch<{ data: UniFiFirewallZone[] }>(`/sites/${siteId}/firewall/zones`),
};

export { UniFiApiError };
