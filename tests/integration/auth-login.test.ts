import { describe, expect, it, vi } from 'vitest';

vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn(async (plain: string) => plain === 'correct-password'),
  },
}));

const { buildApp } = await import('../../src/app.js');

describe('POST /auth/login', () => {
  it('retorna 401 com senha errada', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'admin', password: 'wrong-password' },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('retorna um token com credenciais corretas', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'admin', password: 'correct-password' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTypeOf('string');
    await app.close();
  });

  it('retorna 400 se faltar campo', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'admin' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
