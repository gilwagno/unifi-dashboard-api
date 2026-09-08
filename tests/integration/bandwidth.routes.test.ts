import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mocka o service INTEIRO — importante: isso impede que o módulo real de
// bandwidth-history.service.ts seja importado durante os testes, o que
// dispararia o setInterval real do poller (mesmo com unref(), não queremos
// chamadas de rede reais rodando durante a suíte de testes).
vi.mock('../../src/services/bandwidth-history.service.js', () => ({
  bandwidthHistoryService: {
    getHistory: vi.fn(() => [
      {
        timestamp: '2026-08-27T12:00:00.000Z',
        perDevice: [{ mac: 'aa:bb:cc:dd:ee:ff', name: 'AP Sala', rxBytes: 1000, txBytes: 500 }],
        perClient: [{ mac: '11:22:33:44:55:66', hostname: 'iPhone', rxBytes: 200, txBytes: 100 }],
      },
      {
        timestamp: '2026-08-27T12:05:00.000Z',
        perDevice: [{ mac: 'aa:bb:cc:dd:ee:ff', name: 'AP Sala', rxBytes: 1500, txBytes: 700 }],
        perClient: [{ mac: '11:22:33:44:55:66', hostname: 'iPhone', rxBytes: 350, txBytes: 120 }],
      },
    ]),
    computeDelta: vi.fn(() => [
      {
        intervalStart: '2026-08-27T12:00:00.000Z',
        intervalEnd: '2026-08-27T12:05:00.000Z',
        perDevice: [{ mac: 'aa:bb:cc:dd:ee:ff', name: 'AP Sala', rxBytes: 500, txBytes: 200 }],
        perClient: [{ mac: '11:22:33:44:55:66', hostname: 'iPhone', rxBytes: 150, txBytes: 20 }],
      },
    ]),
    getLongRange: vi.fn(() => [
      {
        intervalStart: '2026-07-01T08:00:00.000Z',
        intervalEnd: '2026-07-01T09:00:00.000Z',
        perDevice: [{ mac: 'aa:bb:cc:dd:ee:ff', name: 'AP Sala', rxBytes: 4000, txBytes: 1000 }],
        perClient: [],
      },
    ]),
  },
}));

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
    getDeviceHealth: vi.fn(async () => []),
    getClientSignalStrength: vi.fn(async () => []),
    getWanUptimeHistory: vi.fn(async () => []),
    getRawTrafficCounters: vi.fn(async () => ({ perDevice: [], perClient: [] })),
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
const { bandwidthHistoryService } = await import('../../src/services/bandwidth-history.service.js');

beforeEach(() => {
  vi.mocked(bandwidthHistoryService.getHistory).mockClear();
  vi.mocked(bandwidthHistoryService.computeDelta).mockClear();
  vi.mocked(bandwidthHistoryService.getLongRange).mockClear();
});

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token };
}

describe('GET /bandwidth/history', () => {
  it('retorna o buffer bruto de snapshots do service', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/bandwidth/history',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(2);
    expect(res.json().data[0]).toEqual({
      timestamp: '2026-08-27T12:00:00.000Z',
      perDevice: [{ mac: 'aa:bb:cc:dd:ee:ff', name: 'AP Sala', rxBytes: 1000, txBytes: 500 }],
      perClient: [{ mac: '11:22:33:44:55:66', hostname: 'iPhone', rxBytes: 200, txBytes: 100 }],
    });
    expect(bandwidthHistoryService.getHistory).toHaveBeenCalled();

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();

    const res = await app.inject({ method: 'GET', url: '/bandwidth/history' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe('GET /bandwidth/history/summary', () => {
  it('retorna o delta já calculado a partir do histórico', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/bandwidth/history/summary',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      {
        intervalStart: '2026-08-27T12:00:00.000Z',
        intervalEnd: '2026-08-27T12:05:00.000Z',
        perDevice: [{ mac: 'aa:bb:cc:dd:ee:ff', name: 'AP Sala', rxBytes: 500, txBytes: 200 }],
        perClient: [{ mac: '11:22:33:44:55:66', hostname: 'iPhone', rxBytes: 150, txBytes: 20 }],
      },
    ]);
    expect(bandwidthHistoryService.computeDelta).toHaveBeenCalledWith(bandwidthHistoryService.getHistory());

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();

    const res = await app.inject({ method: 'GET', url: '/bandwidth/history/summary' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe('GET /bandwidth/history/long-range', () => {
  it('retorna o histórico combinado (amostras finas + rollup) já calculado pelo service', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/bandwidth/history/long-range',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      {
        intervalStart: '2026-07-01T08:00:00.000Z',
        intervalEnd: '2026-07-01T09:00:00.000Z',
        perDevice: [{ mac: 'aa:bb:cc:dd:ee:ff', name: 'AP Sala', rxBytes: 4000, txBytes: 1000 }],
        perClient: [],
      },
    ]);
    expect(bandwidthHistoryService.getLongRange).toHaveBeenCalledWith({
      mac: undefined,
      from: undefined,
      to: undefined,
    });

    await app.close();
  });

  it('repassa mac/from/to (normalizando o mac para minúsculas) para o service', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url:
        '/bandwidth/history/long-range?mac=AA:BB:CC:DD:EE:FF&from=2026-01-01T00:00:00.000Z&to=2026-02-01T00:00:00.000Z',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(bandwidthHistoryService.getLongRange).toHaveBeenCalledWith({
      mac: 'aa:bb:cc:dd:ee:ff',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-02-01T00:00:00.000Z',
    });

    await app.close();
  });

  it('retorna 400 para mac com formato inválido', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/bandwidth/history/long-range?mac=nao-e-um-mac',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();

    const res = await app.inject({ method: 'GET', url: '/bandwidth/history/long-range' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});
