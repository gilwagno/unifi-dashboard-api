import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/unifi.service.js', () => ({
  unifiService: {
    listClients: vi.fn(async () => ({ data: [] })),
    listWifiBroadcasts: vi.fn(async () => ({ data: [] })),
    getWifiBroadcast: vi.fn(async () => undefined),
    createWifiBroadcast: vi.fn(async () => ({ id: 'wifi-1', name: 'Nova rede', enabled: true })),
    listRadiusProfiles: vi.fn(async () => ({ data: [{ id: 'radius-1', name: 'RADIUS Windows AD' }] })),
    updateWifiBroadcastPassword: vi.fn(async () => ({ id: 'wifi-1', name: 'Rede', enabled: true })),
    setWifiBroadcastEnabled: vi.fn(async () => ({ id: 'wifi-1', name: 'Rede', enabled: false })),
    deleteWifiBroadcast: vi.fn(async () => undefined),
    listNetworks: vi.fn(async () => ({ data: [] })),
    createNetwork: vi.fn(async () => ({ id: 'net-1', name: 'Nova VLAN', vlanId: 10 })),
    deleteNetwork: vi.fn(async () => undefined),
    listFirewallZones: vi.fn(async () => ({
      data: [
        { id: 'zone-internal', name: 'Internal', networkIds: ['net-default', 'net-corp'] },
        { id: 'zone-external', name: 'External', networkIds: [] },
      ],
    })),
  },
  UniFiApiError: class UniFiApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
}));

vi.mock('../../src/services/unifi-classic.service.js', () => ({
  unifiClassicService: {
    isConfigured: vi.fn(() => false),
    getBlockedMacs: vi.fn(async () => new Set<string>()),
    blockClient: vi.fn(async () => undefined),
    unblockClient: vi.fn(async () => undefined),
    setClientFixedIp: vi.fn(async () => undefined),
  },
  UniFiClassicApiError: class UniFiClassicApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  ClassicApiNotConfiguredError: class ClassicApiNotConfiguredError extends Error {},
}));

const { buildApp } = await import('../../src/app.js');
const { unifiService } = await import('../../src/services/unifi.service.js');

beforeEach(() => {
  vi.mocked(unifiService.listFirewallZones).mockClear();
  vi.mocked(unifiService.createNetwork).mockClear();
  vi.mocked(unifiService.createWifiBroadcast).mockClear();
});

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token };
}

describe('GET /wifi', () => {
  it('lista as redes Wi-Fi do site', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiService.listWifiBroadcasts).mockResolvedValueOnce({
      data: [{ id: 'wifi-1', name: 'Escritório', enabled: true, type: 'STANDARD', securityConfiguration: { type: 'WPA2_PERSONAL' } }],
    });

    const res = await app.inject({ method: 'GET', url: '/wifi', headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/wifi' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('POST /wifi', () => {
  it('cria uma rede Wi-Fi com os defaults de STANDARD/WPA2_PERSONAL', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/wifi',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Rede Nova', passphrase: 'senha1234' },
    });

    expect(res.statusCode).toBe(201);
    expect(unifiService.createWifiBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'STANDARD',
        name: 'Rede Nova',
        enabled: true,
        network: { type: 'NATIVE' },
        securityConfiguration: { type: 'WPA2_PERSONAL', passphrase: 'senha1234', fastRoamingEnabled: false },
      }),
      undefined,
    );

    await app.close();
  });

  it('rejeita senha curta (< 8 caracteres)', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/wifi',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Rede Nova', passphrase: '123' },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('rejeita nome ausente', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/wifi',
      headers: { authorization: `Bearer ${token}` },
      payload: { passphrase: 'senha1234' },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/wifi', payload: { name: 'x', passphrase: 'senha1234' } });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('cria uma rede Wi-Fi Enterprise (WPA2_WPA3_ENTERPRISE) referenciando um perfil RADIUS existente', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/wifi',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Corporativa', securityType: 'WPA2_WPA3_ENTERPRISE', radiusProfileId: 'radius-1' },
    });

    expect(res.statusCode).toBe(201);
    expect(unifiService.createWifiBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'STANDARD',
        name: 'Corporativa',
        securityConfiguration: {
          type: 'WPA2_WPA3_ENTERPRISE',
          coaEnabled: false,
          fastRoamingEnabled: false,
          pmfMode: 'OPTIONAL',
          wpa3FastRoamingEnabled: false,
          radiusConfiguration: {
            profileId: 'radius-1',
            nasId: { type: 'DERIVED', source: 'BSSID' },
          },
        },
      }),
      undefined,
    );

    await app.close();
  });

  it('cria uma rede Wi-Fi Enterprise (WPA2_ENTERPRISE)', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/wifi',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Corp2', securityType: 'WPA2_ENTERPRISE', radiusProfileId: 'radius-1' },
    });

    expect(res.statusCode).toBe(201);
    expect(unifiService.createWifiBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        securityConfiguration: {
          type: 'WPA2_ENTERPRISE',
          coaEnabled: false,
          fastRoamingEnabled: false,
          radiusConfiguration: {
            profileId: 'radius-1',
            nasId: { type: 'DERIVED', source: 'BSSID' },
          },
        },
      }),
      undefined,
    );

    await app.close();
  });

  it('cria uma rede Wi-Fi Enterprise (WPA3_ENTERPRISE)', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/wifi',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Corp3', securityType: 'WPA3_ENTERPRISE', radiusProfileId: 'radius-1' },
    });

    expect(res.statusCode).toBe(201);
    expect(unifiService.createWifiBroadcast).toHaveBeenCalledWith(
      expect.objectContaining({
        securityConfiguration: {
          type: 'WPA3_ENTERPRISE',
          coaEnabled: false,
          fastRoamingEnabled: false,
          securityMode: 'DEFAULT',
          radiusConfiguration: {
            profileId: 'radius-1',
            nasId: { type: 'DERIVED', source: 'BSSID' },
          },
        },
      }),
      undefined,
    );

    await app.close();
  });

  it('rejeita securityType Enterprise sem radiusProfileId', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/wifi',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Corp', securityType: 'WPA2_ENTERPRISE' },
    });

    expect(res.statusCode).toBe(400);
    expect(unifiService.createWifiBroadcast).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejeita misturar passphrase com securityType Enterprise/radiusProfileId', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/wifi',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'Corp',
        securityType: 'WPA2_ENTERPRISE',
        radiusProfileId: 'radius-1',
        passphrase: 'senha1234',
      },
    });

    expect(res.statusCode).toBe(400);
    expect(unifiService.createWifiBroadcast).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejeita radiusProfileId sem securityType Enterprise (misturado com WPA2_PERSONAL implícito)', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/wifi',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'Corp', passphrase: 'senha1234', radiusProfileId: 'radius-1' },
    });

    expect(res.statusCode).toBe(400);
    expect(unifiService.createWifiBroadcast).not.toHaveBeenCalled();

    await app.close();
  });
});

describe('GET /wifi/radius-profiles', () => {
  it('lista os perfis RADIUS cadastrados no UniFi', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/wifi/radius-profiles',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([{ id: 'radius-1', name: 'RADIUS Windows AD' }]);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/wifi/radius-profiles' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('PATCH /wifi/:id/password', () => {
  it('troca a senha via GET+merge+PUT no serviço', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/wifi/wifi-1/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { passphrase: 'novaSenha123' },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiService.updateWifiBroadcastPassword).toHaveBeenCalledWith('wifi-1', 'novaSenha123', undefined);

    await app.close();
  });

  it('rejeita senha fora do range 8-63', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/wifi/wifi-1/password',
      headers: { authorization: `Bearer ${token}` },
      payload: { passphrase: 'a'.repeat(64) },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });
});

describe('PATCH /wifi/:id/enabled', () => {
  it('liga/desliga a rede via serviço', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/wifi/wifi-1/enabled',
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiService.setWifiBroadcastEnabled).toHaveBeenCalledWith('wifi-1', false, undefined);

    await app.close();
  });

  it('rejeita enabled não-booleano', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/wifi/wifi-1/enabled',
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: 'sim' },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });
});

describe('DELETE /wifi/:id', () => {
  it('remove a rede Wi-Fi', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'DELETE',
      url: '/wifi/wifi-1',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiService.deleteWifiBroadcast).toHaveBeenCalledWith('wifi-1', undefined);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/wifi/wifi-1' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('GET /networks', () => {
  it('lista as VLANs do site', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiService.listNetworks).mockResolvedValueOnce({
      data: [{ id: 'net-1', name: 'IoT', management: 'GATEWAY', enabled: true, vlanId: 20 }],
    });

    const res = await app.inject({ method: 'GET', url: '/networks', headers: { authorization: `Bearer ${token}` } });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/networks' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('GET /networks/zones', () => {
  it('lista as zonas de firewall do site', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/networks/zones',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      { id: 'zone-internal', name: 'Internal', networkIds: ['net-default', 'net-corp'] },
      { id: 'zone-external', name: 'External', networkIds: [] },
    ]);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/networks/zones' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('POST /networks', () => {
  it('cria uma VLAN gerenciada pelo gateway com DHCP server e zoneId resolvido pra "Internal"', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/networks',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'IoT', vlanId: 10, hostIpAddress: '10.30.0.1', prefixLength: 24 },
    });

    expect(res.statusCode).toBe(201);
    expect(unifiService.listFirewallZones).toHaveBeenCalledWith(undefined);
    expect(unifiService.createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({
        management: 'GATEWAY',
        name: 'IoT',
        vlanId: 10,
        zoneId: 'zone-internal',
        ipv4Configuration: expect.objectContaining({
          hostIpAddress: '10.30.0.1',
          prefixLength: 24,
          dhcpConfiguration: {
            mode: 'SERVER',
            ipAddressRange: { start: '10.30.0.10', stop: '10.30.0.254' },
            leaseTimeSeconds: 86400,
            pingConflictDetectionEnabled: false,
          },
        }),
      }),
      undefined,
    );

    await app.close();
  });

  it('usa o zoneId explícito do body em vez de buscar a zona default', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/networks',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'IoT', vlanId: 10, hostIpAddress: '10.30.0.1', prefixLength: 24, zoneId: 'zone-external' },
    });

    expect(res.statusCode).toBe(201);
    expect(unifiService.listFirewallZones).not.toHaveBeenCalled();
    expect(unifiService.createNetwork).toHaveBeenCalledWith(
      expect.objectContaining({ zoneId: 'zone-external' }),
      undefined,
    );

    await app.close();
  });

  it('retorna 502 quando não há zona "Internal" e nenhum zoneId foi informado', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiService.listFirewallZones).mockResolvedValueOnce({
      data: [{ id: 'zone-external', name: 'External' }],
    });

    const res = await app.inject({
      method: 'POST',
      url: '/networks',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'IoT', vlanId: 10, hostIpAddress: '10.30.0.1', prefixLength: 24 },
    });

    expect(res.statusCode).toBe(502);
    expect(unifiService.createNetwork).not.toHaveBeenCalled();

    await app.close();
  });

  it('rejeita vlanId fora do range 2-4009', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/networks',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'IoT', vlanId: 1, hostIpAddress: '10.30.0.1', prefixLength: 24 },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('rejeita vlanId acima de 4009', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/networks',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'IoT', vlanId: 4010, hostIpAddress: '10.30.0.1', prefixLength: 24 },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('rejeita hostIpAddress inválido', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/networks',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'IoT', vlanId: 10, hostIpAddress: 'not-an-ip', prefixLength: 24 },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/networks',
      payload: { name: 'IoT', vlanId: 10, hostIpAddress: '10.30.0.1', prefixLength: 24 },
    });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('DELETE /networks/:id', () => {
  it('remove a VLAN', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'DELETE',
      url: '/networks/net-1',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiService.deleteNetwork).toHaveBeenCalledWith('net-1', undefined);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'DELETE', url: '/networks/net-1' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
