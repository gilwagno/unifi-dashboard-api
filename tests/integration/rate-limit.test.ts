import { describe, expect, it, vi } from 'vitest';

process.env.RATE_LIMIT_CLIENT_ACTION_MAX = '1';

vi.mock('../../src/services/unifi.service.js', () => ({
  unifiService: {},
  UniFiApiError: class UniFiApiError extends Error {},
}));

vi.mock('../../src/services/unifi-classic.service.js', () => ({
  unifiClassicService: {
    isConfigured: vi.fn(() => true),
    getBlockedMacs: vi.fn(async () => new Set<string>()),
    blockClient: vi.fn(async () => undefined),
    unblockClient: vi.fn(async () => undefined),
  },
  UniFiClassicApiError: class UniFiClassicApiError extends Error {},
  ClassicApiNotConfiguredError: class ClassicApiNotConfiguredError extends Error {},
}));

const { buildApp } = await import('../../src/app.js');

describe('rate limit configurável via env', () => {
  it('usa RATE_LIMIT_CLIENT_ACTION_MAX para limitar POST /clients/:mac/block', async () => {
    const app = await buildApp();
    const token = app.jwt.sign({ sub: 'admin' });
    const headers = { authorization: `Bearer ${token}` };

    const first = await app.inject({ method: 'POST', url: '/clients/aa:bb:cc:dd:ee:ff/block', headers });
    const second = await app.inject({ method: 'POST', url: '/clients/aa:bb:cc:dd:ee:ff/block', headers });

    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);

    await app.close();
  });
});
