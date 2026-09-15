import type { FastifyInstance } from 'fastify';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Testes de src/routes/remote-access.routes.ts (Onda 4, subtarefa 4).
// Mock na camada de SERVIÇO, nunca na implementação interna da rota.

const syncComputersToGuacamole = vi.fn();
const listConnectionsWithAnchors = vi.fn();
const openSession = vi.fn();
const searchComputers = vi.fn();

vi.mock('../../src/services/ad.service.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../src/services/ad.service.js')>();
  return { ...original, searchComputers: (...args: unknown[]) => searchComputers(...(args as [])) };
});

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
      openSession: (...args: unknown[]) => openSession(...args),
    },
  };
});

const { buildApp } = await import('../../src/app.js');
const { auditLogService } = await import('../../src/services/audit-log.service.js');

const SAMPLE_COMPUTER = {
  dn: 'CN=EA-PC-TESTE01,OU=EvokAudio,DC=evokaudio,DC=local',
  name: 'EA-PC-TESTE01',
  sAMAccountName: 'EA-PC-TESTE01$',
  dnsHostName: 'ea-pc-teste01.evokaudio.local',
  operatingSystem: 'Windows 11 Pro',
  operatingSystemVersion: '10.0',
  description: null,
  enabled: true,
  isDomainController: false,
  objectGuid: 'guid-1',
};

const SAMPLE_CONNECTION = {
  identifier: '1',
  name: 'EA-PC-TESTE01',
  protocol: 'rdp',
  hostname: 'ea-pc-teste01.evokaudio.local',
  activeConnections: 0,
  adObjectGuid: 'guid-1',
};
const { RemoteAccessNotConfiguredError, RemoteAccessConnectionNotFoundError } = await import(
  '../../src/services/remote-access.service.js'
);

let app: FastifyInstance;
let token: string;

beforeEach(async () => {
  syncComputersToGuacamole.mockReset();
  listConnectionsWithAnchors.mockReset();
  openSession.mockReset();
  searchComputers.mockReset();
  searchComputers.mockResolvedValue([]);
  listConnectionsWithAnchors.mockResolvedValue([]);
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

describe('GET /remote-access/computers', () => {
  it('exige autenticação', async () => {
    const res = await app.inject({ method: 'GET', url: '/remote-access/computers' });
    expect(res.statusCode).toBe(401);
  });

  it('cruza AD e Guacamole e responde se dá para acessar cada PC', async () => {
    searchComputers.mockResolvedValue([
      { ...SAMPLE_COMPUTER, name: 'COM-ACESSO', objectGuid: 'guid-1' },
      { ...SAMPLE_COMPUTER, name: 'SEM-ACESSO', objectGuid: 'guid-2' },
    ]);
    listConnectionsWithAnchors.mockResolvedValue([
      { ...SAMPLE_CONNECTION, identifier: '10', adObjectGuid: 'guid-1', activeConnections: 2 },
    ]);

    const res = await app.inject(auth('/remote-access/computers'));

    expect(res.statusCode).toBe(200);
    const [comAcesso, semAcesso] = res.json().data;
    expect(comAcesso).toMatchObject({
      name: 'COM-ACESSO',
      hasAccess: true,
      connectionIdentifier: '10',
      activeSessions: 2,
    });
    expect(semAcesso).toMatchObject({
      name: 'SEM-ACESSO',
      hasAccess: false,
      connectionIdentifier: null,
    });
  });
});

describe('POST /remote-access/computers/:objectGuid/session', () => {
  const GUID = 'c1c04940-1c5b-4cfa-a4f9-d05689e80045';
  const sessionUrl = `/remote-access/computers/${GUID}/session`;

  beforeEach(() => {
    listConnectionsWithAnchors.mockResolvedValue([
      { ...SAMPLE_CONNECTION, identifier: '10', adObjectGuid: GUID },
    ]);
    openSession.mockResolvedValue({
      connectionIdentifier: '10',
      connectionName: 'EA-PC-TESTE01',
      guacamoleUser: 'dash-admin',
      url: 'http://guacamole.test/guacamole/#/client/MTBjcG9zdGdyZXNxbA==?token=TOKEN-DA-PESSOA',
    });
  });

  it('exige autenticação', async () => {
    const res = await app.inject({ method: 'POST', url: sessionUrl });
    expect(res.statusCode).toBe(401);
    expect(openSession).not.toHaveBeenCalled();
  });

  it('abre a sessão e devolve a URL do Guacamole', async () => {
    const res = await app.inject(auth(sessionUrl, 'POST'));

    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ connectionIdentifier: '10', guacamoleUser: 'dash-admin' });
    expect(res.json().url).toContain('/#/client/');
  });

  it('o ator vem do JWT, NUNCA do corpo da requisição', async () => {
    // Quem abre a sessão não escolhe em nome de quem ela é aberta. Se o
    // handler lesse o corpo, daria para abrir sessão "como" outra pessoa e a
    // auditoria registraria o nome errado — pior que não registrar nada.
    const res = await app.inject({
      method: 'POST',
      url: sessionUrl,
      headers: { authorization: `Bearer ${token}` },
      payload: { sub: 'outra-pessoa', actor: 'outra-pessoa', username: 'outra-pessoa' },
    });

    expect(res.statusCode).toBe(200);
    expect(openSession).toHaveBeenCalledWith('admin', expect.objectContaining({ identifier: '10' }));
  });

  it('AUDITA a abertura: quem, qual PC, quando', async () => {
    // A exigência não é "a sessão abriu", é "a auditoria registrou". Sem
    // este teste o hook global poderia deixar de cobrir esta rota (bastaria
    // alguém transformá-la num GET) e nada apontaria.
    vi.mocked(auditLogService.record).mockClear();

    await app.inject(auth(sessionUrl, 'POST'));

    expect(auditLogService.record).toHaveBeenCalledTimes(1);
    const entrada = vi.mocked(auditLogService.record).mock.calls[0][0];
    expect(entrada.actor).toBe('admin');
    expect(entrada.route).toBe('/remote-access/computers/:objectGuid/session');
    expect(entrada.params.objectGuid).toBe(GUID);
    expect(entrada.statusCode).toBe(200);
    expect(Number.isNaN(Date.parse(entrada.timestamp))).toBe(false);
  });

  it('AUDITA também a tentativa que FALHA — é a que mais importa investigar', async () => {
    listConnectionsWithAnchors.mockResolvedValue([]);
    vi.mocked(auditLogService.record).mockClear();

    const res = await app.inject(auth(sessionUrl, 'POST'));

    expect(res.statusCode).toBe(404);
    expect(auditLogService.record).toHaveBeenCalledTimes(1);
    expect(vi.mocked(auditLogService.record).mock.calls[0][0].statusCode).toBe(404);
  });

  it('a auditoria NÃO grava o corpo da requisição', async () => {
    vi.mocked(auditLogService.record).mockClear();

    await app.inject({
      method: 'POST',
      url: sessionUrl,
      headers: { authorization: `Bearer ${token}` },
      payload: { senhaQueNaoDeveriaExistir: 'segredo-do-dominio' },
    });

    const entrada = vi.mocked(auditLogService.record).mock.calls[0][0];
    expect(JSON.stringify(entrada)).not.toContain('segredo-do-dominio');
  });

  it('computador sem conexão ancorada vira 404', async () => {
    listConnectionsWithAnchors.mockResolvedValue([]);
    const res = await app.inject(auth(sessionUrl, 'POST'));
    expect(res.statusCode).toBe(404);
    expect(openSession).not.toHaveBeenCalled();
  });

  it('objectGuid fora do formato canônico é 400, sem chegar no Guacamole', async () => {
    const res = await app.inject(auth('/remote-access/computers/nao-e-um-guid/session', 'POST'));
    expect(res.statusCode).toBe(400);
    expect(listConnectionsWithAnchors).not.toHaveBeenCalled();
  });
});
