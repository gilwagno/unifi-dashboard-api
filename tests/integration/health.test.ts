import { describe, expect, it } from 'vitest';
import { buildApp } from '../../src/app.js';

describe('GET /health', () => {
  it('retorna status ok', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ status: 'ok' });

    await app.close();
  });
});
