import { env } from '../config/env.js';
import type { UniFiClient, UniFiDevice, UniFiDeviceDetail, UniFiSite } from '../types/unifi.js';

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

  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const unifiService = {
  listSites: () => unifiFetch<{ data: UniFiSite[] }>('/sites'),

  listClients: (siteId = env.SITE_ID) =>
    unifiFetch<{ data: UniFiClient[] }>(`/sites/${siteId}/clients`),

  blockClient: (mac: string, siteId = env.SITE_ID) =>
    unifiFetch<void>(`/sites/${siteId}/clients/${mac}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'BLOCK' }),
    }),

  unblockClient: (mac: string, siteId = env.SITE_ID) =>
    unifiFetch<void>(`/sites/${siteId}/clients/${mac}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'UNBLOCK' }),
    }),

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
};

export { UniFiApiError };
