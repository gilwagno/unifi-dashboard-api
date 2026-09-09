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

  // Regressão: HEAD não é GET/OPTIONS, então caía na trilha de "ação
  // mutável". O Fastify registra HEAD automaticamente pra toda rota GET, e
  // um health check externo batendo HEAD de 10 em 10s enchia o buffer de
  // 500 entradas em ~1h20, expulsando as ações reais da janela visível.
  it('não registra requisições HEAD (é leitura, igual GET)', async () => {
    const { app } = await authedApp();

    const res = await app.inject({ method: 'HEAD', url: '/health' });

    expect(res.statusCode).toBe(200);
    expect(auditLogService.record).not.toHaveBeenCalled();

    await app.close();
  });

  it('não registra requisições OPTIONS', async () => {
    const { app } = await authedApp();

    await app.inject({ method: 'OPTIONS', url: '/clients' });

    expect(auditLogService.record).not.toHaveBeenCalled();

    await app.close();
  });

  // Regressão de vazamento: em 404 o `routeOptions.url` é undefined e o
  // fallback era `request.url` CRU — com query string. Qualquer coisa na
  // query de uma rota inexistente (um cliente mal configurado mandando
  // `?password=`, ou uma varredura de endpoints) ia verbatim pro arquivo
  // append-only, furando a regra de "nunca gravar segredo".
  it('não grava a query string no campo route quando nenhuma rota casa (404)', async () => {
    const { app } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/rota-inexistente?password=supersecreta&token=abc123',
    });

    expect(res.statusCode).toBe(404);
    expect(auditLogService.record).toHaveBeenCalledTimes(1);

    const entry = vi.mocked(auditLogService.record).mock.calls[0]?.[0];
    expect(entry?.route).toBe('/rota-inexistente');
    expect(JSON.stringify(entry)).not.toContain('supersecreta');
    expect(JSON.stringify(entry)).not.toContain('abc123');

    await app.close();
  });

  it('grava o PADRÃO da rota (não a URL preenchida) quando a rota casa, mesmo com query string', async () => {
    const { app, token } = await authedApp();

    await app.inject({
      method: 'POST',
      url: '/clients/aa:bb:cc:dd:ee:ff/block?siteId=default',
      headers: { authorization: `Bearer ${token}` },
    });

    const entry = vi.mocked(auditLogService.record).mock.calls[0]?.[0];
    expect(entry?.route).toBe('/clients/:mac/block');
    expect(entry?.route).not.toContain('?');
    expect(entry?.params).toEqual({ mac: 'aa:bb:cc:dd:ee:ff' });

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
