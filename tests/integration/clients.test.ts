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
const { unifiClassicService, ClassicApiNotConfiguredError, UniFiClassicApiError } = await import(
  '../../src/services/unifi-classic.service.js'
);

beforeEach(() => {
  vi.mocked(unifiClassicService.isConfigured).mockClear();
  vi.mocked(unifiClassicService.getBlockedMacs).mockClear();
  vi.mocked(unifiClassicService.blockClient).mockClear();
  vi.mocked(unifiClassicService.unblockClient).mockClear();
});

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token };
}

describe('GET /clients', () => {
  it('usa o site padrão quando siteId não é informado', async () => {
    const { app, token } = await authedApp();

    await app.inject({ method: 'GET', url: '/clients', headers: { authorization: `Bearer ${token}` } });

    expect(unifiService.listClients).toHaveBeenCalledWith(undefined);

    await app.close();
  });

  it('repassa siteId da query string para o serviço', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/clients?siteId=site-2',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiService.listClients).toHaveBeenCalledWith('site-2');

    await app.close();
  });

  it('filtra por blocked e type', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiService.listClients).mockResolvedValueOnce({
      data: [
        { id: '1', macAddress: 'aa:aa:aa:aa:aa:aa', type: 'WIRED', blocked: false },
        { id: '2', macAddress: 'bb:bb:bb:bb:bb:bb', type: 'WIRELESS', blocked: true },
        { id: '3', macAddress: 'cc:cc:cc:cc:cc:cc', type: 'WIRELESS', blocked: false },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/clients?blocked=false&type=WIRELESS',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      { id: '3', macAddress: 'cc:cc:cc:cc:cc:cc', type: 'WIRELESS', blocked: false },
    ]);

    await app.close();
  });

  it('pagina os resultados com page e pageSize', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiService.listClients).mockResolvedValueOnce({
      data: Array.from({ length: 5 }, (_, i) => ({
        id: `${i}`,
        macAddress: `aa:aa:aa:aa:aa:0${i}`,
        type: 'WIRED',
        blocked: false,
      })),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/clients?page=2&pageSize=2',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].id).toBe('2');
    expect(body.pagination).toEqual({ page: 2, pageSize: 2, total: 5, totalPages: 3 });

    await app.close();
  });

  it('rejeita type inválido', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/clients?type=BLUETOOTH',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('cruza o status de bloqueio com a API clássica quando configurada', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.isConfigured).mockReturnValueOnce(true);
    vi.mocked(unifiClassicService.getBlockedMacs).mockResolvedValueOnce(new Set(['bb:bb:bb:bb:bb:bb']));
    vi.mocked(unifiService.listClients).mockResolvedValueOnce({
      data: [
        { id: '1', macAddress: 'aa:aa:aa:aa:aa:aa', type: 'WIRED', blocked: false },
        { id: '2', macAddress: 'bb:bb:bb:bb:bb:bb', type: 'WIRELESS', blocked: false },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/clients',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const clients = res.json().data;
    expect(clients.find((c: { id: string }) => c.id === '1').blocked).toBe(false);
    expect(clients.find((c: { id: string }) => c.id === '2').blocked).toBe(true);

    await app.close();
  });

  it('não chama a API clássica quando ela não está configurada', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.isConfigured).mockReturnValueOnce(false);

    await app.inject({ method: 'GET', url: '/clients', headers: { authorization: `Bearer ${token}` } });

    expect(unifiClassicService.getBlockedMacs).not.toHaveBeenCalled();

    await app.close();
  });
});

describe('POST /clients/:mac/block', () => {
  it('chama unifiClassicService.blockClient com o mac', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/clients/aa:bb:cc:dd:ee:ff/block',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiClassicService.blockClient).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff');

    await app.close();
  });

  it('retorna 503 quando a API clássica não está configurada', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.blockClient).mockRejectedValueOnce(new ClassicApiNotConfiguredError());

    const res = await app.inject({
      method: 'POST',
      url: '/clients/aa:bb:cc:dd:ee:ff/block',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(503);

    await app.close();
  });

  it('retorna 404 quando o MAC nunca foi visto pelo controller (evita registro fantasma)', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.blockClient).mockRejectedValueOnce(
      new UniFiClassicApiError(404, 'Cliente ff:ff:ff:ff:ff:ff não é conhecido pelo controller'),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/clients/ff:ff:ff:ff:ff:ff/block',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);

    await app.close();
  });
});

describe('POST /clients/:mac/unblock', () => {
  it('chama unifiClassicService.unblockClient com o mac', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/clients/aa:bb:cc:dd:ee:ff/unblock',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiClassicService.unblockClient).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff');

    await app.close();
  });
});

describe('POST /clients/:mac/block validação', () => {
  it('mac inválido retorna 400 pelo error handler central', async () => {
    const { app, token } = await authedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/clients/not-a-mac/block',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Dados inválidos');

    await app.close();
  });
});
