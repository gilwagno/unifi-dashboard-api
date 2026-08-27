import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/unifi.service.js', () => ({
  unifiService: {
    listClients: vi.fn(async () => ({ data: [] })),
    blockClient: vi.fn(async () => undefined),
    unblockClient: vi.fn(async () => undefined),
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
});

describe('POST /clients/:mac/block', () => {
  it('repassa siteId da query string para o serviço', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/clients/aa:bb:cc:dd:ee:ff/block?siteId=site-2',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiService.blockClient).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff', 'site-2');

    await app.close();
  });
});

describe('POST /clients/:mac/unblock', () => {
  it('repassa siteId da query string para o serviço', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/clients/aa:bb:cc:dd:ee:ff/unblock?siteId=site-2',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiService.unblockClient).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff', 'site-2');

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
