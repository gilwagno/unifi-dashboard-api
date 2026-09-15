import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Testes de src/services/remote-access.service.ts (Onda 4, subtarefa 3 —
// cliente da API REST do Apache Guacamole). `global.fetch` é mockado, mesmo
// padrão de printer-brother-wbm.service.test.ts.
//
// As env vars GUACAMOLE_* são OPCIONAIS e `src/config/env.ts` lê
// `process.env` no momento do import, então elas precisam ser definidas
// ANTES do import dinâmico do serviço — por isso o módulo é importado em
// `beforeEach` em vez de no topo do arquivo.

const GUACAMOLE_URL = 'http://guacamole.test/guacamole';
const DATA_SOURCE = 'postgresql';
const TOKEN = 'TOKEN-SECRETO-DE-SESSAO';

type Service = typeof import('../../src/services/remote-access.service.js');

let service: Service;

async function loadService(overrides: Record<string, string | undefined> = {}): Promise<Service> {
  vi.resetModules();
  const vars = {
    GUACAMOLE_URL,
    GUACAMOLE_DATA_SOURCE: DATA_SOURCE,
    GUACAMOLE_USERNAME: 'dashboard-backend',
    GUACAMOLE_PASSWORD: 'senha-do-servico',
    ...overrides,
  };
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import('../../src/services/remote-access.service.js');
}

function jsonResponse(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as Response;
}

function emptyResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => null,
    text: async () => '',
  } as Response;
}

/** fetch que responde o login e depois entrega as respostas da fila, na ordem. */
function fetchWith(...responses: Response[]) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const queue = [...responses];
  const mock = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url.endsWith('/api/tokens')) return jsonResponse(200, { authToken: TOKEN });
    const next = queue.shift();
    if (!next) throw new Error(`fetch inesperado: ${url}`);
    return next;
  });
  vi.stubGlobal('fetch', mock);
  return { mock, calls };
}

beforeEach(async () => {
  service = await loadService();
  service.resetSessionForTests();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('feature desligada sem configuração', () => {
  it('isConfigured é false e toda operação lança RemoteAccessNotConfiguredError', async () => {
    const off = await loadService({ GUACAMOLE_USERNAME: undefined, GUACAMOLE_PASSWORD: undefined });
    off.resetSessionForTests();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        throw new Error('nenhuma chamada de rede deveria acontecer');
      }),
    );

    expect(off.remoteAccessService.isConfigured()).toBe(false);
    await expect(off.remoteAccessService.listConnections()).rejects.toBeInstanceOf(
      off.RemoteAccessNotConfiguredError,
    );
    await expect(
      off.remoteAccessService.createRdpConnection({ name: 'PC', hostname: 'pc.test' }),
    ).rejects.toBeInstanceOf(off.RemoteAccessNotConfiguredError);
    await expect(off.remoteAccessService.deleteConnection('1')).rejects.toBeInstanceOf(
      off.RemoteAccessNotConfiguredError,
    );
  });
});

describe('regra 1 — o token nunca vaza', () => {
  // Esta é a garantia central do módulo: o token viaja na QUERY STRING da
  // API do Guacamole, então toda mensagem de erro que carregue a URL carrega
  // o token junto. Sem estes testes, apagar `redactToken` das mensagens não
  // quebraria nada e o token iria parar no log do Fastify.
  it('redactToken substitui o valor mantendo o resto da URL legível', () => {
    const url = `${GUACAMOLE_URL}/api/session/data/postgresql/connections?token=${TOKEN}`;
    const redacted = service.redactToken(url);
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).toContain('token=<token>');
    expect(redacted).toContain('/connections');
  });

  it('redige o token quando ele não é o último parâmetro da query', () => {
    const redacted = service.redactToken(`http://x/y?token=${TOKEN}&outro=1`);
    expect(redacted).not.toContain(TOKEN);
    expect(redacted).toContain('&outro=1');
  });

  it('erro de rede numa chamada autenticada não expõe o token na mensagem', async () => {
    const mock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/tokens')) return jsonResponse(200, { authToken: TOKEN });
      // Reproduz o caso real: o erro do fetch cita a URL completa.
      throw new Error(`request to ${url} failed, reason: ECONNREFUSED`);
    });
    vi.stubGlobal('fetch', mock);

    const error = await service.remoteAccessService.listConnections().catch((e) => e);
    expect(error).toBeInstanceOf(service.RemoteAccessRequestError);
    expect(error.message).not.toContain(TOKEN);
    expect(error.message).toContain('<token>');
  });

  it('corpo de erro do Guacamole que ecoa a requisição também é redigido', async () => {
    const body = { message: `erro ao processar ?token=${TOKEN}` };
    fetchWith({
      ok: false,
      status: 500,
      json: async () => body,
      text: async () => JSON.stringify(body),
    } as Response);

    const error = await service.remoteAccessService.listConnections().catch((e) => e);
    expect(error.message).not.toContain(TOKEN);
  });

  it('nenhum erro tipado carrega o token como propriedade', async () => {
    fetchWith(jsonResponse(500, { message: 'falhou' }));
    const error = await service.remoteAccessService.listConnections().catch((e) => e);
    expect(JSON.stringify(error, Object.getOwnPropertyNames(error))).not.toContain(TOKEN);
  });
});

describe('regra 2 — passe-through não persiste credencial', () => {
  // A regra vale desde já mesmo que a abertura de sessão só chegue na
  // subtarefa 5: uma conexão RDP com credencial embutida vira um cofre de
  // senhas de domínio dentro do Postgres do Guacamole. Este teste falha se
  // alguém "ajudar" adicionando username/password ao payload.
  it('o payload de criação não contém username, password nem domain', async () => {
    const { calls } = fetchWith(jsonResponse(200, { identifier: '7', name: 'PC-01', protocol: 'rdp' }));

    await service.remoteAccessService.createRdpConnection({ name: 'PC-01', hostname: 'pc01.test' });

    const create = calls.find((c) => c.init?.method === 'POST' && !c.url.endsWith('/api/tokens'));
    const payload = JSON.parse(String(create?.init?.body));
    expect(Object.keys(payload.parameters)).not.toContain('username');
    expect(Object.keys(payload.parameters)).not.toContain('password');
    expect(Object.keys(payload.parameters)).not.toContain('domain');
  });

  it('a conexão é criada com NLA e porta 3389 por padrão', async () => {
    const { calls } = fetchWith(jsonResponse(200, { identifier: '7', name: 'PC-01', protocol: 'rdp' }));

    await service.remoteAccessService.createRdpConnection({ name: 'PC-01', hostname: 'pc01.test' });

    const create = calls.find((c) => c.init?.method === 'POST' && !c.url.endsWith('/api/tokens'));
    const payload = JSON.parse(String(create?.init?.body));
    expect(payload.protocol).toBe('rdp');
    expect(payload.parameters.security).toBe('nla');
    expect(payload.parameters.port).toBe('3389');
    expect(payload.parameters.hostname).toBe('pc01.test');
  });

  it('respeita uma porta explícita', async () => {
    const { calls } = fetchWith(jsonResponse(200, { identifier: '7' }));
    await service.remoteAccessService.createRdpConnection({
      name: 'PC-01',
      hostname: 'pc01.test',
      port: 13389,
    });
    const create = calls.find((c) => c.init?.method === 'POST' && !c.url.endsWith('/api/tokens'));
    expect(JSON.parse(String(create?.init?.body)).parameters.port).toBe('13389');
  });
});

describe('listConnections', () => {
  it('converte o objeto indexado por identifier em array', async () => {
    fetchWith(
      jsonResponse(200, {
        '1': { name: 'PC-01', protocol: 'rdp', activeConnections: 2 },
        '2': { name: 'PC-02', protocol: 'rdp' },
      }),
    );

    const connections = await service.remoteAccessService.listConnections();

    expect(connections).toEqual([
      { identifier: '1', name: 'PC-01', protocol: 'rdp', hostname: null, activeConnections: 2 },
      { identifier: '2', name: 'PC-02', protocol: 'rdp', hostname: null, activeConnections: 0 },
    ]);
  });

  it('catálogo vazio devolve array vazio, não erro', async () => {
    fetchWith(jsonResponse(200, {}));
    await expect(service.remoteAccessService.listConnections()).resolves.toEqual([]);
  });
});

describe('getConnection', () => {
  it('junta os parâmetros (recurso separado) ao objeto da conexão', async () => {
    fetchWith(
      jsonResponse(200, { identifier: '1', name: 'PC-01', protocol: 'rdp', activeConnections: 1 }),
      jsonResponse(200, { hostname: 'pc01.test', port: '3389', security: 'nla' }),
    );

    await expect(service.remoteAccessService.getConnection('1')).resolves.toEqual({
      identifier: '1',
      name: 'PC-01',
      protocol: 'rdp',
      hostname: 'pc01.test',
      activeConnections: 1,
    });
  });

  it('404 vira RemoteAccessConnectionNotFoundError', async () => {
    fetchWith(emptyResponse(404));
    await expect(service.remoteAccessService.getConnection('999')).rejects.toBeInstanceOf(
      service.RemoteAccessConnectionNotFoundError,
    );
  });
});

describe('deleteConnection é idempotente', () => {
  // Mesmo raciocínio que a revogação de grupo do AD custou duas rodadas de
  // revisão na Onda 3: o que importa é o ESTADO FINAL. Um 404 no delete
  // significa "não existe", que é o estado desejado de quem chamou delete.
  it('remoção bem-sucedida devolve removed: true', async () => {
    fetchWith(emptyResponse(204));
    await expect(service.remoteAccessService.deleteConnection('1')).resolves.toEqual({ removed: true });
  });

  it('remover algo que já não existe é sucesso silencioso, não erro', async () => {
    fetchWith(emptyResponse(404));
    await expect(service.remoteAccessService.deleteConnection('1')).resolves.toEqual({ removed: false });
  });

  it('erro de verdade (500) continua sendo erro — a idempotência não engole falha', async () => {
    fetchWith(jsonResponse(500, { message: 'boom' }));
    await expect(service.remoteAccessService.deleteConnection('1')).rejects.toBeInstanceOf(
      service.RemoteAccessRequestError,
    );
  });
});

describe('sessão e renovação de token', () => {
  it('reaproveita o token entre chamadas (um único login)', async () => {
    const { mock } = fetchWith(jsonResponse(200, {}), jsonResponse(200, {}));

    await service.remoteAccessService.listConnections();
    await service.remoteAccessService.listConnections();

    const logins = mock.mock.calls.filter(([url]) => String(url).endsWith('/api/tokens'));
    expect(logins).toHaveLength(1);
  });

  it('token expirado (401) é renovado e a chamada refeita uma vez', async () => {
    const { mock } = fetchWith(emptyResponse(401), jsonResponse(200, { '1': { name: 'PC-01' } }));

    const connections = await service.remoteAccessService.listConnections();

    expect(connections).toHaveLength(1);
    const logins = mock.mock.calls.filter(([url]) => String(url).endsWith('/api/tokens'));
    expect(logins).toHaveLength(2);
  });

  it('401 persistente não vira laço: falha depois de uma única renovação', async () => {
    const { mock } = fetchWith(emptyResponse(401), emptyResponse(401));

    await expect(service.remoteAccessService.listConnections()).rejects.toBeInstanceOf(
      service.RemoteAccessRequestError,
    );
    const logins = mock.mock.calls.filter(([url]) => String(url).endsWith('/api/tokens'));
    expect(logins).toHaveLength(2);
  });

  it('credencial de serviço recusada vira RemoteAccessAuthError sem ecoar a senha', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => emptyResponse(403)),
    );

    const error = await service.remoteAccessService.listConnections().catch((e) => e);
    expect(error).toBeInstanceOf(service.RemoteAccessAuthError);
    expect(error.message).not.toContain('senha-do-servico');
  });

  it('Guacamole fora do ar vira RemoteAccessRequestError com a URL base', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    const error = await service.remoteAccessService.listConnections().catch((e) => e);
    expect(error).toBeInstanceOf(service.RemoteAccessRequestError);
    expect(error.message).toContain(GUACAMOLE_URL);
  });

  it('login que responde 200 sem authToken não é tratado como sucesso', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => jsonResponse(200, { semToken: true })),
    );
    await expect(service.remoteAccessService.listConnections()).rejects.toThrow(/authToken/);
  });
});

describe('montagem de URL', () => {
  it('usa o data source configurado no path', async () => {
    const { calls } = fetchWith(jsonResponse(200, {}));
    await service.remoteAccessService.listConnections();
    const call = calls.find((c) => !c.url.endsWith('/api/tokens'));
    expect(call?.url).toContain(`/api/session/data/${DATA_SOURCE}/connections`);
  });

  it('barra sobrando no fim de GUACAMOLE_URL não produz // no path', async () => {
    const trailing = await loadService({ GUACAMOLE_URL: `${GUACAMOLE_URL}/` });
    trailing.resetSessionForTests();
    const { calls } = fetchWith(jsonResponse(200, {}));
    await trailing.remoteAccessService.listConnections();
    expect(calls.every((c) => !c.url.replace('http://', '').includes('//'))).toBe(true);
  });

  it('identifier com caractere especial é escapado no path', async () => {
    const { calls } = fetchWith(emptyResponse(204));
    await service.remoteAccessService.deleteConnection('a/b');
    const call = calls.find((c) => c.init?.method === 'DELETE');
    expect(call?.url).toContain('a%2Fb');
  });
});
