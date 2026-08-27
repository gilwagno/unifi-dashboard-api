import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

describe('rotas protegidas', () => {
  it('GET /clients sem token retorna 401', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/clients' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it('POST /devices/:id/restart sem token retorna 401', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'POST', url: '/devices/abc123/restart' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });

  it('GET /sites sem token retorna 401', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/sites' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});
