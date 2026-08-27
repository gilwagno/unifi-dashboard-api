import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/unifi.service.js', () => ({
  unifiService: {
    listDevices: vi.fn(async () => ({ data: [] })),
    restartDevice: vi.fn(async () => undefined),
  },
  UniFiApiError: class UniFiApiError extends Error {},
}));

const { buildApp } = await import('../../src/app.js');
const { unifiService } = await import('../../src/services/unifi.service.js');

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token };
}

describe('GET /devices', () => {
  it('usa o site padrão quando siteId não é informado', async () => {
    const { app, token } = await authedApp();

    await app.inject({ method: 'GET', url: '/devices', headers: { authorization: `Bearer ${token}` } });

    expect(unifiService.listDevices).toHaveBeenCalledWith(undefined);

    await app.close();
  });

  it('repassa siteId da query string para o serviço', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/devices?siteId=site-2',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiService.listDevices).toHaveBeenCalledWith('site-2');

    await app.close();
  });
});

describe('POST /devices/:id/restart', () => {
  it('repassa siteId da query string para o serviço', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/devices/dev-1/restart?siteId=site-2',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiService.restartDevice).toHaveBeenCalledWith('dev-1', 'site-2');

    await app.close();
  });
});
