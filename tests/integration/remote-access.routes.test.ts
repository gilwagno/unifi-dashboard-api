import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Testes de src/routes/remote-access.routes.ts (Onda 4, subtarefa 4).
// Mock na camada de SERVIÇO, nunca na implementação interna da rota.

const syncComputersToGuacamole = vi.fn();
const listConnectionsWithAnchors = vi.fn();

vi.mock('../../src/services/remote-access-sync.service.js', () => ({
  remoteAccessSyncService: {
    syncComputersToGuacamole: (...args: unknown[]) => syncComputersToGuacamole(...args),
  },
}));

vi.mock('../../src/services/remote-access.service.js', async (importOriginal) => {
  // `importOriginal` mantém as CLASSES DE ERRO reais: o error handler central
  // decide o status por `instanceof`, então substituí-las por dublês faria o
  // teste do 503/404 passar por engano (ou falhar por motivo errado).
  const original = await importOriginal<typeof import('../../src/services/remote-access.service.js')>();
  return {
    ...original,
    remoteAccessService: {
      ...original.remoteAccessService,
      listConnectionsWithAnchors: (...args: unknown[]) => listConnectionsWithAnchors(...args),
    },
  };
});

const { buildApp } = await import('../../src/app.js');
const { RemoteAccessNotConfiguredError, RemoteAccessConnectionNotFoundError } = await import(
  '../../src/services/remote-access.service.js'
);

let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  syncComputersToGuacamole.mockReset();
  listConnectionsWithAnchors.mockReset();
  app = await buildApp();
  await app.ready();
  token = app.jwt.sign({ sub: 'admin' });
});

afterEach(async () => {
  await app.close();
});

function auth(url: string, method: 'GET' | 'POST' = 'GET') {
  return { method, url, headers: { authorization: `Bearer ${token}` } } as const;
}

describe('POST /remote-access/sync', () => {
  const resultadoVazio = {
    criadas: [],
    atualizadas: [],
    inalteradas: [],
    removidas: [],
    puladas: [],
    ignoradas: [],
  };

  it('exige autenticação', async () => {
    const res = await app.inject({ method: 'POST', url: '/remote-access/sync' });
    expect(res.statusCode).toBe(401);
    expect(syncComputersToGuacamole).not.toHaveBeenCalled();
  });

  it('devolve o resultado com um resumo contado', async () => {
    syncComputersToGuacamole.mockResolvedValue({
      ...resultadoVazio,
      criadas: [{ computerName: 'PC-01', objectGuid: 'guid-1', connectionIdentifier: '1' }],
      inalteradas: [{ computerName: 'PC-02', objectGuid: 'guid-2', connectionIdentifier: '2' }],
      ignoradas: [{ connectionIdentifier: '9', connectionName: 'feito-a-mao' }],
    });

    const res = await app.inject(auth('/remote-access/sync', 'POST'));

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.resumo).toEqual({
      criadas: 1,
      atualizadas: 0,
      inalteradas: 1,
      removidas: 0,
      puladas: 0,
      ignoradas: 1,
    });
    expect(body.criadas[0].computerName).toBe('PC-01');
  });

  it('sem Guacamole configurado devolve 503, não 500', async () => {
    syncComputersToGuacamole.mockRejectedValue(new RemoteAccessNotConfiguredError());
    const res = await app.inject(auth('/remote-access/sync', 'POST'));
    expect(res.statusCode).toBe(503);
    expect(res.json().error).toBe('Funcionalidade indisponível');
  });

  it('erro do módulo vira 502 pela classe BASE, sem virar 500 genérico', async () => {
    // Uma subclasse futura que ninguém somou a lista nenhuma — é justamente
    // o que a classe base protege (mesmo desenho de AdError na Onda 3).
    class ErroNovoDoModulo extends (await import('../../src/services/remote-access.service.js'))
      .RemoteAccessError {}
    syncComputersToGuacamole.mockRejectedValue(new ErroNovoDoModulo('algo novo falhou'));

    const res = await app.inject(auth('/remote-access/sync', 'POST'));

    expect(res.statusCode).toBe(502);
    expect(res.json().error).toBe('Erro no acesso remoto');
  });
});

describe('GET /remote-access/connections', () => {
  it('exige autenticação', async () => {
    const res = await app.inject({ method: 'GET', url: '/remote-access/connections' });
    expect(res.statusCode).toBe(401);
  });

  it('devolve o catálogo com a âncora de cada conexão', async () => {
    listConnectionsWithAnchors.mockResolvedValue([
      {
        identifier: '1',
        name: 'PC-01',
        protocol: 'rdp',
        hostname: 'pc-01.evokaudio.local',
        activeConnections: 0,
        adObjectGuid: 'guid-1',
      },
    ]);

    const res = await app.inject(auth('/remote-access/connections'));

    expect(res.statusCode).toBe(200);
    expect(res.json().data[0].adObjectGuid).toBe('guid-1');
  });

  it('conexão inexistente vira 404 pelo erro tipado', async () => {
    listConnectionsWithAnchors.mockRejectedValue(new RemoteAccessConnectionNotFoundError('42'));
    const res = await app.inject(auth('/remote-access/connections'));
    expect(res.statusCode).toBe(404);
  });
});
