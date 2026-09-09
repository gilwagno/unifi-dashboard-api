import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Regressão da subtarefa 0.2 do plano da Onda 3 (docs/ad-module-plan.md):
// DELETE /wifi/:id, DELETE /networks/:id e DELETE /printers/:id não usavam
// RATE_LIMIT_CLIENT_ACTION_MAX como as demais rotas de escrita dos mesmos
// arquivos — caíam no limite global (RATE_LIMIT_MAX, default 100/min) em vez
// do restrito (default 10/min). Mesmo padrão de rate-limit.test.ts/
// rate-limit-device-restart.test.ts: RATE_LIMIT_CLIENT_ACTION_MAX=1 antes de
// importar o app, pra provar que a SEGUNDA chamada já estoura o limite —
// se alguma dessas 3 rotas voltar a usar o limite global (100/min), a
// segunda chamada aqui passaria (200) em vez de 429, e o teste pega.
process.env.RATE_LIMIT_CLIENT_ACTION_MAX = '1';

const tmpDir = mkdtempSync(join(tmpdir(), 'rate-limit-delete-test-'));
process.env.PRINTERS_DB_FILE = join(tmpDir, 'printers.db');

vi.mock('../../src/services/unifi.service.js', () => ({
  unifiService: {
    listClients: vi.fn(async () => ({ data: [] })),
    deleteWifiBroadcast: vi.fn(async () => undefined),
    deleteNetwork: vi.fn(async () => undefined),
  },
  UniFiApiError: class UniFiApiError extends Error {},
}));

vi.mock('../../src/services/unifi-classic.service.js', () => ({
  unifiClassicService: {
    isConfigured: vi.fn(() => false),
    getKnownClientsNetworkInfo: vi.fn(async () => new Map()),
    getConnectedMacs: vi.fn(async () => new Set()),
    getBlockedMacs: vi.fn(async () => new Set<string>()),
    blockClient: vi.fn(async () => undefined),
    unblockClient: vi.fn(async () => undefined),
  },
  UniFiClassicApiError: class UniFiClassicApiError extends Error {},
  ClassicApiNotConfiguredError: class ClassicApiNotConfiguredError extends Error {},
}));

const { buildApp } = await import('../../src/app.js');
const { unifiService } = await import('../../src/services/unifi.service.js');
const { printersRepository } = await import('../../src/routes/printers.routes.js');

afterAll(() => {
  printersRepository.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token, headers: { authorization: `Bearer ${token}` } };
}

describe('rate limit em rotas DELETE usa RATE_LIMIT_CLIENT_ACTION_MAX (não o limite global)', () => {
  it('DELETE /wifi/:id', async () => {
    const { app, headers } = await authedApp();

    const first = await app.inject({ method: 'DELETE', url: '/wifi/wifi-1', headers });
    const second = await app.inject({ method: 'DELETE', url: '/wifi/wifi-1', headers });

    expect(first.statusCode).toBe(200);
    expect(unifiService.deleteWifiBroadcast).toHaveBeenCalledTimes(1);
    expect(second.statusCode).toBe(429);
    expect(unifiService.deleteWifiBroadcast).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('DELETE /networks/:id', async () => {
    const { app, headers } = await authedApp();

    const first = await app.inject({ method: 'DELETE', url: '/networks/net-1', headers });
    const second = await app.inject({ method: 'DELETE', url: '/networks/net-1', headers });

    expect(first.statusCode).toBe(200);
    expect(unifiService.deleteNetwork).toHaveBeenCalledTimes(1);
    expect(second.statusCode).toBe(429);
    expect(unifiService.deleteNetwork).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('DELETE /printers/:id', async () => {
    const { app, headers } = await authedApp();

    const created = await app.inject({
      method: 'POST',
      url: '/printers',
      headers,
      payload: {
        name: 'Impressora rate-limit',
        mac: 'aa:bb:cc:dd:ee:ff',
        snmp: { version: 'v2c', community: 'segredo-qualquer' },
      },
    });
    const printerId = created.json().id;

    const first = await app.inject({ method: 'DELETE', url: `/printers/${printerId}`, headers });
    const second = await app.inject({ method: 'DELETE', url: `/printers/${printerId}`, headers });

    // A primeira chamada de fato apaga (200); a segunda, mesmo que o registro
    // já não exista mais, precisa ser barrada pelo rate limit (429) ANTES de
    // chegar no handler — não pode virar 404 (não é isso que estamos testando
    // aqui, e um 404 esconderia uma regressão de rate limit).
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(429);

    await app.close();
  });
});
