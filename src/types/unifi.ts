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

// Rede Wi-Fi (SSID), como vem em GET/POST/PUT
// /sites/{siteId}/wifi/broadcasts[/{id}]. Só os campos que este projeto
// realmente usa — o schema oficial completo tem mais opções (RADIUS,
// mesh, agendamento etc.) que não modelamos aqui.
export interface UniFiWifiSecurityConfiguration {
  type: 'OPEN' | 'WPA2_PERSONAL' | 'WPA3_PERSONAL' | string;
  passphrase?: string;
  // Obrigatório pelo controller (não pelo schema OpenAPI, que o declara
  // opcional) sempre que `bssTransitionEnabled: true` está setado no
  // broadcast — confirmado contra um controller real, que rejeita a
  // criação com 400 sem este campo.
  fastRoamingEnabled?: boolean;
  [key: string]: unknown;
}

export interface UniFiWifiBroadcast {
  id: string;
  type: string;
  name: string;
  enabled: boolean;
  hideName?: boolean;
  channel2gLockedTo6?: boolean;
  clientIsolationEnabled?: boolean;
  dtimPeriod2gLockedTo3?: boolean;
  multicastToUnicastConversionEnabled?: boolean;
  uapsdEnabled?: boolean;
  advertiseDeviceName?: boolean;
  arpProxyEnabled?: boolean;
  bssTransitionEnabled?: boolean;
  broadcastingFrequenciesGHz?: number[];
  securityConfiguration: UniFiWifiSecurityConfiguration;
  network?: { id: string };
  [key: string]: unknown;
}

// Payload mínimo pra criar uma rede Wi-Fi (POST /sites/{siteId}/wifi/broadcasts).
export interface UniFiWifiBroadcastCreate {
  type: 'STANDARD';
  name: string;
  enabled: boolean;
  hideName: boolean;
  channel2gLockedTo6: boolean;
  clientIsolationEnabled: boolean;
  dtimPeriod2gLockedTo3: boolean;
  multicastToUnicastConversionEnabled: boolean;
  uapsdEnabled: boolean;
  advertiseDeviceName: boolean;
  arpProxyEnabled: boolean;
  bssTransitionEnabled: boolean;
  broadcastingFrequenciesGHz: number[];
  // Obrigatório pelo controller quando a segurança é WPA2_PERSONAL com
  // passphrase (em vez de presharedKeys) — confirmado contra um
  // controller real: sem isso o controller rejeita com 400
  // ("WPA2 personal security requires exactly one of [preshared keys
  // setting, all of [network setting, passphrase setting]]"). `{ type:
  // "NATIVE" }` é o valor mínimo válido, usado pela maioria das redes
  // reais observadas via GET /wifi/broadcasts.
  network: { type: 'NATIVE' };
  securityConfiguration: { type: 'WPA2_PERSONAL'; passphrase: string; fastRoamingEnabled: boolean };
}

// Network/VLAN, como vem em GET/POST /sites/{siteId}/networks[/{id}]. Só
// os campos usados por este projeto.
export interface UniFiNetworkIpv4Configuration {
  autoScaleEnabled?: boolean;
  hostIpAddress?: string;
  prefixLength?: number;
  dhcpConfiguration?: { mode?: string; [key: string]: unknown };
  [key: string]: unknown;
}

export interface UniFiNetwork {
  id: string;
  management: string;
  name: string;
  enabled: boolean;
  vlanId?: number;
  internetAccessEnabled?: boolean;
  isolationEnabled?: boolean;
  zoneId?: string;
  ipv4Configuration?: UniFiNetworkIpv4Configuration;
  [key: string]: unknown;
}

// Zona de firewall, como vem em GET /sites/{siteId}/firewall/zones. Toda
// network precisa referenciar uma zona (ver `zoneId` em
// UniFiNetworkCreate) — confirmado contra um controller real, que rejeita
// a criação de network com 400 ("zoneId must not be null") apesar de o
// OpenAPI oficial declarar o campo como opcional.
export interface UniFiFirewallZone {
  id: string;
  name: string;
  networkIds?: string[];
  metadata?: unknown;
  [key: string]: unknown;
}

// Payload mínimo pra criar uma VLAN gerenciada pelo gateway (POST
// /sites/{siteId}/networks).
export interface UniFiNetworkCreate {
  management: 'GATEWAY';
  name: string;
  enabled: boolean;
  vlanId: number;
  cellularBackupEnabled: boolean;
  internetAccessEnabled: boolean;
  isolationEnabled: boolean;
  // Obrigatório pelo controller (não pelo schema OpenAPI) — o id de uma
  // zona de firewall existente (GET /sites/{siteId}/firewall/zones). Sem
  // isso o controller rejeita com 400 ("zoneId must not be null").
  zoneId: string;
  ipv4Configuration: {
    autoScaleEnabled: boolean;
    hostIpAddress: string;
    prefixLength: number;
    // O OpenAPI oficial declara os três campos abaixo como opcionais, mas o
    // controller rejeita a criação com 400 sem eles quando `mode: "SERVER"`
    // — confirmado contra um controller real ("ipv4Configuration.
    // dhcpConfiguration.ipAddressRange must not be null", idem para
    // leaseTimeSeconds e pingConflictDetectionEnabled).
    dhcpConfiguration: {
      mode: 'SERVER';
      ipAddressRange: { start: string; stop: string };
      leaseTimeSeconds: number;
      pingConflictDetectionEnabled: boolean;
    };
  };
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
