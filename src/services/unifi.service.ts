import https from 'node:https';
import { env } from '../config/env.js';
import type { UniFiClient, UniFiDevice, UniFiSite } from '../types/unifi.js';

const BASE_URL = `https://${env.CONTROLLER_HOST}/proxy/network/integration/v1`;

// Controllers locais quase sempre usam certificado autoassinado.
// Isso desativa a verificação de TLS SÓ para essas chamadas — aceitável em
// rede local/confiável, mas não use isso pra falar com hosts na internet.
const agent = new https.Agent({
  rejectUnauthorized: !env.UNIFI_ALLOW_SELF_SIGNED,
});

class UniFiApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
    this.name = 'UniFiApiError';
  }
}

async function unifiFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    // @ts-expect-error — a lib de tipos do fetch nativo ainda não conhece `agent`
    agent,
    headers: {
      Authorization: `Bearer ${env.UNIFI_API_KEY}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
      ...init.headers,
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new UniFiApiError(res.status, `UniFi API respondeu ${res.status}: ${body}`);
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

  restartDevice: (deviceId: string, siteId = env.SITE_ID) =>
    unifiFetch<void>(`/sites/${siteId}/devices/${deviceId}/actions`, {
      method: 'POST',
      body: JSON.stringify({ action: 'RESTART' }),
    }),
};

export { UniFiApiError };
