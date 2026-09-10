import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/services/unifi.service.js', () => ({
  unifiService: {
    listClients: vi.fn(async () => ({ data: [] })),
  },
  UniFiApiError: class UniFiApiError extends Error {},
}));

vi.mock('../../src/services/unifi-classic.service.js', () => ({
  unifiClassicService: {
    isConfigured: vi.fn(() => false),
    getBlockedMacs: vi.fn(async () => new Set<string>()),
    blockClient: vi.fn(async () => undefined),
    unblockClient: vi.fn(async () => undefined),
  },
  UniFiClassicApiError: class UniFiClassicApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
    }
  },
  ClassicApiNotConfiguredError: class ClassicApiNotConfiguredError extends Error {},
}));

// tests/setup.ts já mocka auditLogService globalmente (evita gravar em
// disco em todo teste de integração) — aqui é justamente esse hook
// (registrado em src/app.ts) que está sendo testado, então só precisamos
// espionar as chamadas a record().
const { buildApp } = await import('../../src/app.js');
const { auditLogService } = await import('../../src/services/audit-log.service.js');

beforeEach(() => {
  vi.mocked(auditLogService.record).mockClear();
});

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token };
}

describe('hook de auditoria (onResponse em src/app.ts)', () => {
  it('registra uma ação mutável (POST) com o ator, rota e status', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/clients/aa:bb:cc:dd:ee:ff/block',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(auditLogService.record).toHaveBeenCalledTimes(1);
    expect(auditLogService.record).toHaveBeenCalledWith(
      expect.objectContaining({
        actor: 'admin',
        method: 'POST',
        route: '/clients/:mac/block',
        params: { mac: 'aa:bb:cc:dd:ee:ff' },
        statusCode: 200,
      }),
    );

    await app.close();
  });

  it('não registra requisições GET', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/clients',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(auditLogService.record).not.toHaveBeenCalled();

    await app.close();
  });

  it('não registra rotas de /auth/*', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { username: 'admin', password: 'senha-errada' },
    });

    expect(res.statusCode).toBe(401);
    expect(auditLogService.record).not.toHaveBeenCalled();

    await app.close();
  });

  it('registra mesmo quando a ação falha (ator + status de erro)', async () => {
    const { app, token } = await authedApp();
    const { unifiClassicService, ClassicApiNotConfiguredError } = await import(
      '../../src/services/unifi-classic.service.js'
    );
    vi.mocked(unifiClassicService.blockClient).mockRejectedValueOnce(new ClassicApiNotConfiguredError());

    const res = await app.inject({
      method: 'POST',
      url: '/clients/aa:bb:cc:dd:ee:ff/block',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(503);
    expect(auditLogService.record).toHaveBeenCalledWith(expect.objectContaining({ statusCode: 503 }));

    await app.close();
  });

  it('usa "anônimo" como ator quando não há token válido', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'POST',
      url: '/clients/aa:bb:cc:dd:ee:ff/block',
    });

    expect(res.statusCode).toBe(401);
    // Sem preHandler de auth bem-sucedido, request.user nunca é setado.
    expect(auditLogService.record).toHaveBeenCalledWith(expect.objectContaining({ actor: 'anônimo' }));

    await app.close();
  });
});
