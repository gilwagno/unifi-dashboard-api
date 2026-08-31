import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/unifi.service.js', () => ({
  unifiService: {
    listDevices: vi.fn(async () => ({ data: [] })),
    restartDevice: vi.fn(async () => undefined),
    getDevice: vi.fn(async () => ({
      id: 'dev-1',
      macAddress: 'd0:21:f9:e7:e2:7c',
      ipAddress: '172.16.0.94',
      name: 'USW Flex Mini',
      model: 'USW Flex Mini',
      supported: true,
      state: 'ONLINE',
      firmwareVersion: '2.1.6',
      firmwareUpdatable: false,
      interfaces: {
        ports: [
          { idx: 1, state: 'UP', connector: 'RJ45', maxSpeedMbps: 1000, speedMbps: 1000 },
          { idx: 2, state: 'UP', connector: 'RJ45', maxSpeedMbps: 1000, speedMbps: 1000 },
        ],
      },
    })),
    powerCyclePort: vi.fn(async () => undefined),
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

const { buildApp } = await import('../../src/app.js');
const { unifiService, UniFiApiError } = await import('../../src/services/unifi.service.js');

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

  it('pagina os resultados com page e pageSize', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiService.listDevices).mockResolvedValueOnce({
      data: Array.from({ length: 5 }, (_, i) => ({
        id: `dev-${i}`,
        name: `AP ${i}`,
        model: 'U6',
        macAddress: `aa:aa:aa:aa:aa:0${i}`,
        state: 'ONLINE',
      })),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/devices?page=2&pageSize=2',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].id).toBe('dev-2');
    expect(body.pagination).toEqual({ page: 2, pageSize: 2, total: 5, totalPages: 3 });

    await app.close();
  });

  it('rejeita pageSize acima do limite', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/devices?pageSize=500',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);

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

  it('retorna 401 sem token', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'POST', url: '/devices/dev-1/restart' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it('repassa o status de erro do serviço quando o device não existe', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiService.restartDevice).mockRejectedValueOnce(new UniFiApiError(404, 'Device não encontrado'));

    const res = await app.inject({
      method: 'POST',
      url: '/devices/nao-existe/restart',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().details).toBe('Device não encontrado');

    await app.close();
  });
});

describe('GET /devices/:id', () => {
  it('retorna o detalhe do device, incluindo as portas', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/devices/dev-1',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiService.getDevice).toHaveBeenCalledWith('dev-1', undefined);
    const body = res.json();
    expect(body.id).toBe('dev-1');
    expect(body.interfaces.ports).toHaveLength(2);
    expect(body.interfaces.ports[0]).toMatchObject({ idx: 1, state: 'UP' });

    await app.close();
  });

  it('repassa siteId da query string para o serviço', async () => {
    const { app, token } = await authedApp();

    await app.inject({
      method: 'GET',
      url: '/devices/dev-1?siteId=site-2',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(unifiService.getDevice).toHaveBeenCalledWith('dev-1', 'site-2');

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'GET', url: '/devices/dev-1' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe('POST /devices/:id/ports/:portIdx/power-cycle', () => {
  it('chama unifiService.powerCyclePort com deviceId, portIdx e siteId', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/devices/dev-1/ports/3/power-cycle?siteId=site-2',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiService.powerCyclePort).toHaveBeenCalledWith('dev-1', 3, 'site-2');

    await app.close();
  });

  it('usa o site padrão quando siteId não é informado', async () => {
    const { app, token } = await authedApp();

    await app.inject({
      method: 'POST',
      url: '/devices/dev-1/ports/1/power-cycle',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(unifiService.powerCyclePort).toHaveBeenCalledWith('dev-1', 1, undefined);

    await app.close();
  });

  it('rejeita portIdx inválido (não numérico) com 400', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/devices/dev-1/ports/abc/power-cycle',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const app = await buildApp();

    const res = await app.inject({ method: 'POST', url: '/devices/dev-1/ports/1/power-cycle' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it('repassa o status de erro do serviço quando a porta não existe', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiService.powerCyclePort).mockRejectedValueOnce(new UniFiApiError(404, 'Porta não encontrada'));

    const res = await app.inject({
      method: 'POST',
      url: '/devices/dev-1/ports/99/power-cycle',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
    expect(res.json().details).toBe('Porta não encontrada');

    await app.close();
  });
});
