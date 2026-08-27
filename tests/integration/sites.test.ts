import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/unifi.service.js', () => ({
  unifiService: {
    listSites: vi.fn(async () => ({
      data: [
        { id: 'default', name: 'Matriz' },
        { id: 'site-2', name: 'Filial' },
      ],
    })),
  },
  UniFiApiError: class UniFiApiError extends Error {},
}));

const { buildApp } = await import('../../src/app.js');
const { unifiService } = await import('../../src/services/unifi.service.js');

describe('GET /sites', () => {
  it('retorna a lista de sites do controller', async () => {
    const app = await buildApp();
    const token = app.jwt.sign({ sub: 'admin' });

    const res = await app.inject({
      method: 'GET',
      url: '/sites',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(2);
    expect(unifiService.listSites).toHaveBeenCalled();

    await app.close();
  });
});
