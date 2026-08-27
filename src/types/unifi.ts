// Tipos baseados na UniFi Network Integration API (v1).
// Os nomes de campo podem variar entre versões do controller — confira o
// schema exposto pelo próprio controller (Settings > Control Plane >
// Integrations) antes de confiar cegamente nestes tipos.

export interface UniFiSite {
  id: string;
  name: string;
  desc?: string;
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

export interface UniFiDevice {
  id: string;
  name: string;
  model: string;
  macAddress: string;
  ipAddress?: string;
  state: 'ONLINE' | 'OFFLINE' | 'PENDING' | 'UPDATING';
}
