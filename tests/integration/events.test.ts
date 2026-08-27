import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/unifi-events.hub.js', () => ({
  unifiEventsHub: {
    getHistory: vi.fn((limit?: number) => [
      { receivedAt: '2026-08-27T00:00:00.000Z', data: JSON.stringify({ meta: { limit } }) },
    ]),
    subscribe: vi.fn(() => () => {}),
  },
}));

const { buildApp } = await import('../../src/app.js');
const { unifiEventsHub } = await import('../../src/services/unifi-events.hub.js');

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin', type: 'access' });
  return { app, token };
}

describe('GET /events/history', () => {
  it('sem token retorna 401', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/events/history' });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('sem limit chama getHistory sem argumento', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/events/history',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(unifiEventsHub.getHistory).toHaveBeenCalledWith();

    await app.close();
  });

  it('repassa limit da query string', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/events/history?limit=5',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiEventsHub.getHistory).toHaveBeenCalledWith(5);

    await app.close();
  });

  it('rejeita limit inválido', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/events/history?limit=abc',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });
});
