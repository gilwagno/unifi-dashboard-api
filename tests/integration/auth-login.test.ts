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

  it('retorna um token e um refreshToken com credenciais corretas', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'admin', password: 'correct-password' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTypeOf('string');
    expect(res.json().refreshToken).toBeTypeOf('string');
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

describe('POST /auth/refresh', () => {
  it('troca um refresh token válido por um novo access token', async () => {
    const app = await buildApp();
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'admin', password: 'correct-password' },
    });
    const { refreshToken } = login.json();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().token).toBeTypeOf('string');
    await app.close();
  });

  it('rejeita um access token no lugar de um refresh token', async () => {
    const app = await buildApp();
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'admin', password: 'correct-password' },
    });
    const { token } = login.json();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: token },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('rejeita um refresh token inválido', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: { refreshToken: 'lixo-invalido' },
    });

    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('retorna 400 se faltar refreshToken', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/auth/refresh',
      payload: {},
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });
});
