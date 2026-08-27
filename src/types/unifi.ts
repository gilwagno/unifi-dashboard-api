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

// Porta de um device (switch/AP com portas), como vem no endpoint de
// DETALHE (GET /sites/{siteId}/devices/{deviceId}). Note que este formato
// (interfaces.ports como objeto/array de objetos) é diferente do campo
// `interfaces` do endpoint de LISTAGEM (GET /sites/{siteId}/devices), onde
// `interfaces` é um array de strings de capacidade (ex: ["ports"]).
export interface UniFiDevicePort {
  idx: number;
  state: 'UP' | 'DOWN';
  connector?: string;
  maxSpeedMbps?: number;
  speedMbps?: number;
}

// Detalhe de um device (GET /sites/{siteId}/devices/{deviceId}). Só os
// campos usados por este projeto — o payload real do controller tem mais
// campos que não modelamos aqui.
export interface UniFiDeviceDetail {
  id: string;
  macAddress: string;
  ipAddress?: string;
  name: string;
  model: string;
  supported: boolean;
  state: 'ONLINE' | 'OFFLINE' | 'PENDING' | 'UPDATING';
  firmwareVersion?: string;
  firmwareUpdatable?: boolean;
  adoptedAt?: string;
  provisionedAt?: string;
  configurationId?: string;
  uplink?: { deviceId: string };
  interfaces?: {
    ports?: UniFiDevicePort[];
  };
}
