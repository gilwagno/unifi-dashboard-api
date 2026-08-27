import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/unifi.service.js', () => ({
  unifiService: {
    listClients: vi.fn(async () => ({ data: [] })),
  },
  UniFiApiError: class UniFiApiError extends Error {},
}));

vi.mock('../../src/services/unifi-classic.service.js', () => ({
  unifiClassicService: {
    isConfigured: vi.fn(() => false),
    getBlockedMacs: vi.fn(async () => new Set<string>()),
    blockClient: vi.fn(async () => undefined),
    unblockClient: vi.fn(async () => undefined),
    getSecuritySummary: vi.fn(async () => ({
      threatsDetected: 0,
      ipsEnabled: true,
      signaturesActive: 0,
      upgradableDeviceCount: 0,
    })),
    getCriticalEvents: vi.fn(async () => []),
    getAdmins: vi.fn(async () => []),
    getDeviceHealth: vi.fn(async () => [
      {
        mac: 'aa:bb:cc:dd:ee:ff',
        name: 'AP Sala',
        cpu: 2.6,
        mem: 32.9,
        uptimeSeconds: 208615,
        clientCount: 3,
        radios: [
          { name: 'ra0', channel: 1, channelUtilizationPct: 24, satisfactionScore: -1, clientCount: 0 },
          { name: 'rai0', channel: 157, channelUtilizationPct: 4, satisfactionScore: 95, clientCount: 3 },
        ],
      },
    ]),
    getClientSignalStrength: vi.fn(async () => [
      { mac: '11:22:33:44:55:66', hostname: 'iPhone', signalDbm: -64, rssi: 32, satisfactionScore: 100, channel: 60 },
    ]),
    getWanUptimeHistory: vi.fn(async () => [
      {
        downtime_history: [],
        health_history: [{ timestamp: 1787770800000, wan_downtime: false, high_latency: false, packet_loss: false }],
      },
    ]),
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
const { unifiClassicService, ClassicApiNotConfiguredError } = await import(
  '../../src/services/unifi-classic.service.js'
);

beforeEach(() => {
  vi.mocked(unifiClassicService.getDeviceHealth).mockClear();
  vi.mocked(unifiClassicService.getClientSignalStrength).mockClear();
  vi.mocked(unifiClassicService.getWanUptimeHistory).mockClear();
});

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token };
}

describe('GET /health (health-check simples, sem token)', () => {
  it('continua respondendo status ok mesmo após registrar as rotas de saúde operacional', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });

    await app.close();
  });
});

describe('GET /health/devices', () => {
  it('retorna a saúde dos devices do serviço', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/health/devices',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      {
        mac: 'aa:bb:cc:dd:ee:ff',
        name: 'AP Sala',
        cpu: 2.6,
        mem: 32.9,
        uptimeSeconds: 208615,
        clientCount: 3,
        radios: [
          { name: 'ra0', channel: 1, channelUtilizationPct: 24, satisfactionScore: -1, clientCount: 0 },
          { name: 'rai0', channel: 157, channelUtilizationPct: 4, satisfactionScore: 95, clientCount: 3 },
        ],
      },
    ]);
    expect(unifiClassicService.getDeviceHealth).toHaveBeenCalled();

    await app.close();
  });

  it('retorna 503 quando a API clássica não está configurada', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.getDeviceHealth).mockRejectedValueOnce(new ClassicApiNotConfiguredError());

    const res = await app.inject({
      method: 'GET',
      url: '/health/devices',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(503);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();

    const res = await app.inject({ method: 'GET', url: '/health/devices' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe('GET /health/clients-signal', () => {
  it('retorna a força de sinal dos clientes do serviço', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/health/clients-signal',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      { mac: '11:22:33:44:55:66', hostname: 'iPhone', signalDbm: -64, rssi: 32, satisfactionScore: 100, channel: 60 },
    ]);
    expect(unifiClassicService.getClientSignalStrength).toHaveBeenCalled();

    await app.close();
  });

  it('retorna 503 quando a API clássica não está configurada', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.getClientSignalStrength).mockRejectedValueOnce(new ClassicApiNotConfiguredError());

    const res = await app.inject({
      method: 'GET',
      url: '/health/clients-signal',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(503);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();

    const res = await app.inject({ method: 'GET', url: '/health/clients-signal' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe('GET /health/wan-uptime', () => {
  it('retorna o histórico de saúde do WAN do serviço', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/health/wan-uptime',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      {
        downtime_history: [],
        health_history: [{ timestamp: 1787770800000, wan_downtime: false, high_latency: false, packet_loss: false }],
      },
    ]);
    expect(unifiClassicService.getWanUptimeHistory).toHaveBeenCalled();

    await app.close();
  });

  it('retorna 503 quando a API clássica não está configurada', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.getWanUptimeHistory).mockRejectedValueOnce(new ClassicApiNotConfiguredError());

    const res = await app.inject({
      method: 'GET',
      url: '/health/wan-uptime',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(503);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();

    const res = await app.inject({ method: 'GET', url: '/health/wan-uptime' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});
