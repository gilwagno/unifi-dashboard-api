import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

// GET /printers/discover-candidates (achado 10 do CLAUDE.md) — lista
// candidatos a impressora conhecidos pelo UniFi (via
// unifiClassicService.getPrinterDiscoveryCandidates, mockado na camada de
// serviço) que ainda não estão cadastrados no módulo. Nunca cadastra nada
// sozinho — só leitura.
vi.mock('../../src/services/unifi.service.js', () => ({
  unifiService: {
    listClients: vi.fn(async () => ({ data: [] })),
  },
  UniFiApiError: class UniFiApiError extends Error {},
}));

vi.mock('../../src/services/unifi-classic.service.js', () => ({
  unifiClassicService: {
    isConfigured: vi.fn(() => true),
    getKnownClientsNetworkInfo: vi.fn(async () => new Map()),
    getPrinterDiscoveryCandidates: vi.fn(async () => []),
  },
  UniFiClassicApiError: class UniFiClassicApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
      this.name = 'UniFiClassicApiError';
    }
  },
  ClassicApiNotConfiguredError: class ClassicApiNotConfiguredError extends Error {},
}));

const tmpDir = mkdtempSync(join(tmpdir(), 'printers-discover-candidates-test-'));
process.env.PRINTERS_DB_FILE = join(tmpDir, 'printers.db');

const { buildApp } = await import('../../src/app.js');
const { printersRepository } = await import('../../src/routes/printers.routes.js');
const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');

afterAll(() => {
  printersRepository.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.mocked(unifiClassicService.isConfigured).mockReset().mockReturnValue(true);
  vi.mocked(unifiClassicService.getPrinterDiscoveryCandidates).mockReset().mockResolvedValue([]);
  for (const printer of printersRepository.listAll()) {
    printersRepository.delete(printer.id);
  }
});

function authFor(app: Awaited<ReturnType<typeof buildApp>>) {
  const token = app.jwt.sign({ sub: 'admin' });
  return { authorization: `Bearer ${token}` };
}

describe('GET /printers/discover-candidates', () => {
  it('lista os candidatos devolvidos pelo serviço quando nenhum está cadastrado', async () => {
    vi.mocked(unifiClassicService.getPrinterDiscoveryCandidates).mockResolvedValue([
      { mac: 'b0:22:7a:4f:63:80', hostname: 'COMPRAS', name: 'HPLaserMFP135w', oui: 'HP Inc.', ipAddress: '172.16.0.34' },
    ]);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/printers/discover-candidates',
      headers: authFor(app),
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      data: [{ mac: 'b0:22:7a:4f:63:80', hostname: 'COMPRAS', name: 'HPLaserMFP135w', oui: 'HP Inc.', ipAddress: '172.16.0.34' }],
    });
    await app.close();
  });

  // Achado real (achado 10 do plano): um candidato retornado pelo serviço
  // pode já ter sido cadastrado manualmente entre a última varredura e agora
  // — a rota precisa cruzar contra o cadastro atual, não confiar cegamente
  // no que o serviço devolveu.
  it('remove da lista qualquer candidato cujo MAC já está cadastrado', async () => {
    vi.mocked(unifiClassicService.getPrinterDiscoveryCandidates).mockResolvedValue([
      { mac: 'b0:22:7a:4f:63:80', hostname: 'COMPRAS', name: 'HPLaserMFP135w', oui: 'HP Inc.', ipAddress: '172.16.0.34' },
      { mac: '50:81:40:d8:6c:7e', hostname: 'COMERCIAL', name: 'HPLaserMFP135w', oui: 'HP Inc.', ipAddress: '172.16.0.89' },
    ]);

    const app = await buildApp();
    const auth = authFor(app);

    await app.inject({
      method: 'POST',
      url: '/printers',
      headers: auth,
      payload: {
        name: 'HP Financeiro',
        mac: '50:81:40:d8:6c:7e',
        snmp: { version: 'v2c', community: 'public' },
      },
    });

    const res = await app.inject({
      method: 'GET',
      url: '/printers/discover-candidates',
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json() as { data: Array<{ mac: string }> };
    expect(body.data.map((c) => c.mac)).toEqual(['b0:22:7a:4f:63:80']);
    await app.close();
  });

  it('retorna 503 quando a API clássica não está configurada', async () => {
    vi.mocked(unifiClassicService.isConfigured).mockReturnValue(false);

    const app = await buildApp();
    const res = await app.inject({
      method: 'GET',
      url: '/printers/discover-candidates',
      headers: authFor(app),
    });

    expect(res.statusCode).toBe(503);
    expect(unifiClassicService.getPrinterDiscoveryCandidates).not.toHaveBeenCalled();
    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/printers/discover-candidates' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});
