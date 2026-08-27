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
      signaturesActive: 32876,
      upgradableDeviceCount: 0,
    })),
    getCriticalEvents: vi.fn(async () => []),
    getAdmins: vi.fn(async () => []),
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
  vi.mocked(unifiClassicService.getSecuritySummary).mockClear();
  vi.mocked(unifiClassicService.getCriticalEvents).mockClear();
  vi.mocked(unifiClassicService.getAdmins).mockClear();
});

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token };
}

describe('GET /security/summary', () => {
  it('retorna o resumo de segurança do serviço', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/security/summary',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      threatsDetected: 0,
      ipsEnabled: true,
      signaturesActive: 32876,
      upgradableDeviceCount: 0,
    });
    expect(unifiClassicService.getSecuritySummary).toHaveBeenCalled();

    await app.close();
  });

  it('retorna 503 quando a API clássica não está configurada', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.getSecuritySummary).mockRejectedValueOnce(new ClassicApiNotConfiguredError());

    const res = await app.inject({
      method: 'GET',
      url: '/security/summary',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(503);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();

    const res = await app.inject({ method: 'GET', url: '/security/summary' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe('GET /security/events', () => {
  it('retorna os eventos críticos do serviço', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.getCriticalEvents).mockResolvedValueOnce([{ msg: 'algo aconteceu' }]);

    const res = await app.inject({
      method: 'GET',
      url: '/security/events',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([{ msg: 'algo aconteceu' }]);

    await app.close();
  });

  it('retorna 503 quando a API clássica não está configurada', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.getCriticalEvents).mockRejectedValueOnce(new ClassicApiNotConfiguredError());

    const res = await app.inject({
      method: 'GET',
      url: '/security/events',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(503);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();

    const res = await app.inject({ method: 'GET', url: '/security/events' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe('GET /security/admins', () => {
  it('retorna os admins do serviço', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.getAdmins).mockResolvedValueOnce([
      { name: 'Admin', email: 'admin@example.com', roles: [{ site_name: 'default', role: 'admin' }] },
    ]);

    const res = await app.inject({
      method: 'GET',
      url: '/security/admins',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      { name: 'Admin', email: 'admin@example.com', roles: [{ site_name: 'default', role: 'admin' }] },
    ]);

    await app.close();
  });

  it('retorna 503 quando a API clássica não está configurada', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.getAdmins).mockRejectedValueOnce(new ClassicApiNotConfiguredError());

    const res = await app.inject({
      method: 'GET',
      url: '/security/admins',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(503);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();

    const res = await app.inject({ method: 'GET', url: '/security/admins' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});
