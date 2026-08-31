import { describe, expect, it, vi } from 'vitest';

process.env.RATE_LIMIT_DEVICE_RESTART_MAX = '1';

vi.mock('../../src/services/unifi.service.js', () => ({
  unifiService: {
    restartDevice: vi.fn(async () => undefined),
    powerCyclePort: vi.fn(async () => undefined),
  },
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
const { unifiService } = await import('../../src/services/unifi.service.js');

describe('rate limit configurável via env (RATE_LIMIT_DEVICE_RESTART_MAX)', () => {
  it('usa RATE_LIMIT_DEVICE_RESTART_MAX (diferente de RATE_LIMIT_CLIENT_ACTION_MAX) para limitar POST /devices/:id/restart', async () => {
    const app = await buildApp();
    const token = app.jwt.sign({ sub: 'admin' });
    const headers = { authorization: `Bearer ${token}` };

    const first = await app.inject({ method: 'POST', url: '/devices/dev-1/restart', headers });
    const second = await app.inject({ method: 'POST', url: '/devices/dev-1/restart', headers });

    expect(first.statusCode).toBe(200);
    expect(unifiService.restartDevice).toHaveBeenCalledTimes(1);
    expect(second.statusCode).toBe(429);
    expect(unifiService.restartDevice).toHaveBeenCalledTimes(1);

    await app.close();
  });

  // O power-cycle de porta PoE é tão disruptivo quanto reiniciar o device
  // inteiro e por isso compartilha o mesmo limite — se alguém trocar essa
  // rota pro RATE_LIMIT_CLIENT_ACTION_MAX (default 10), este teste pega.
  it('usa RATE_LIMIT_DEVICE_RESTART_MAX também para POST /devices/:id/ports/:portIdx/power-cycle', async () => {
    const app = await buildApp();
    const token = app.jwt.sign({ sub: 'admin' });
    const headers = { authorization: `Bearer ${token}` };

    const first = await app.inject({ method: 'POST', url: '/devices/dev-1/ports/1/power-cycle', headers });
    const second = await app.inject({ method: 'POST', url: '/devices/dev-1/ports/1/power-cycle', headers });

    expect(first.statusCode).toBe(200);
    expect(unifiService.powerCyclePort).toHaveBeenCalledTimes(1);
    expect(second.statusCode).toBe(429);
    expect(unifiService.powerCyclePort).toHaveBeenCalledTimes(1);

    await app.close();
  });
});
