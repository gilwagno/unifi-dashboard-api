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
      { identifier: '1', name: 'PC-01', protocol: 'rdp', hostname: null, activeConnections: 2, adObjectGuid: null },
      { identifier: '2', name: 'PC-02', protocol: 'rdp', hostname: null, activeConnections: 0, adObjectGuid: null },
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
      adObjectGuid: null,
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

describe('âncora de correlação AD ↔ Guacamole', () => {
  // A âncora vai como PARÂMETRO porque o Guacamole aceita atributo custom
  // com HTTP 200 e o DESCARTA EM SILÊNCIO (sondado contra o Guacamole real,
  // tools/guacamole-attr-probe.mjs). Uma âncora que não grava faria o sync
  // duplicar conexão a cada rodada, reportando sucesso todas as vezes.
  it('o objectGUID é gravado como parâmetro, não como atributo', async () => {
    const { calls } = fetchWith(jsonResponse(200, { identifier: '7' }));

    await service.remoteAccessService.createRdpConnection({
      name: 'PC-01',
      hostname: 'pc01.test',
      adObjectGuid: 'c1c04940-1c5b-4cfa-a4f9-d05689e80045',
    });

    const create = calls.find((c) => c.init?.method === 'POST' && !c.url.endsWith('/api/tokens'));
    const payload = JSON.parse(String(create?.init?.body));
    expect(payload.parameters[service.AD_OBJECT_GUID_PARAM]).toBe('c1c04940-1c5b-4cfa-a4f9-d05689e80045');
    expect(payload.attributes).toEqual({});
  });

  it('a conexão lida devolve a âncora em adObjectGuid', async () => {
    fetchWith(
      jsonResponse(200, { identifier: '1', name: 'PC-01', protocol: 'rdp' }),
      jsonResponse(200, { hostname: 'pc01.test', [service.AD_OBJECT_GUID_PARAM]: 'guid-1' }),
    );

    const connection = await service.remoteAccessService.getConnection('1');
    expect(connection.adObjectGuid).toBe('guid-1');
  });

  it('conexão sem a âncora devolve adObjectGuid null (foi criada à mão)', async () => {
    fetchWith(
      jsonResponse(200, { identifier: '1', name: 'Feito-a-mao', protocol: 'rdp' }),
      jsonResponse(200, { hostname: 'x.test' }),
    );

    const connection = await service.remoteAccessService.getConnection('1');
    expect(connection.adObjectGuid).toBeNull();
  });
});

describe('updateRdpConnection — o PUT é full-object', () => {
  // O PUT do Guacamole perde o que não for enviado. O risco concreto é o
  // update "atualizar" o hostname e apagar em silêncio o `security=nla` ou a
  // própria âncora — a conexão continuaria existindo, aparentemente saudável,
  // e o sync a recriaria como duplicata na rodada seguinte.
  it('reenvia TODOS os parâmetros, incluindo NLA e a âncora', async () => {
    const { calls } = fetchWith(emptyResponse(204));

    await service.remoteAccessService.updateRdpConnection('7', {
      name: 'PC-01-RENOMEADO',
      hostname: 'novo.test',
      adObjectGuid: 'guid-1',
    });

    const put = calls.find((c) => c.init?.method === 'PUT');
    const payload = JSON.parse(String(put?.init?.body));
    expect(payload.parameters).toEqual({
      hostname: 'novo.test',
      port: '3389',
      security: 'nla',
      'ignore-cert': 'true',
      'resize-method': 'display-update',
      [service.AD_OBJECT_GUID_PARAM]: 'guid-1',
    });
    expect(payload.name).toBe('PC-01-RENOMEADO');
    expect(payload.identifier).toBe('7');
  });

  it('o update continua sem persistir credencial (regra 2)', async () => {
    const { calls } = fetchWith(emptyResponse(204));
    await service.remoteAccessService.updateRdpConnection('7', { name: 'PC', hostname: 'h.test' });
    const put = calls.find((c) => c.init?.method === 'PUT');
    const parameters = JSON.parse(String(put?.init?.body)).parameters;
    expect(Object.keys(parameters)).not.toContain('username');
    expect(Object.keys(parameters)).not.toContain('password');
  });

  it('atualizar conexão inexistente vira RemoteAccessConnectionNotFoundError', async () => {
    fetchWith(emptyResponse(404));
    await expect(
      service.remoteAccessService.updateRdpConnection('999', { name: 'PC', hostname: 'h.test' }),
    ).rejects.toBeInstanceOf(service.RemoteAccessConnectionNotFoundError);
  });
});

describe('listConnectionsWithAnchors', () => {
  it('busca os parâmetros de cada conexão para preencher a âncora', async () => {
    fetchWith(
      jsonResponse(200, { '1': { name: 'PC-01', protocol: 'rdp' } }),
      jsonResponse(200, { identifier: '1', name: 'PC-01', protocol: 'rdp' }),
      jsonResponse(200, { hostname: 'pc01.test', [service.AD_OBJECT_GUID_PARAM]: 'guid-1' }),
    );

    const connections = await service.remoteAccessService.listConnectionsWithAnchors();
    expect(connections).toEqual([
      {
        identifier: '1',
        name: 'PC-01',
        protocol: 'rdp',
        hostname: 'pc01.test',
        activeConnections: 0,
        adObjectGuid: 'guid-1',
      },
    ]);
  });
});

describe('sessão — uma conta Guacamole por pessoa', () => {
  // O desenho existe porque a alternativa "óbvia" foi MEDIDA e descartada:
  // o token do Guacamole carrega as permissões de quem autenticou, então
  // entregar o token do usuário de serviço ao navegador daria ao cliente o
  // CREATE_CONNECTION dele — escalação de privilégio.
  const PESSOA = 'fulano.silva';
  const TOKEN_DA_PESSOA = 'TOKEN-DA-PESSOA';

  const conexao = {
    identifier: '10',
    name: 'EA-PC-TESTE01',
    protocol: 'rdp',
    hostname: 'ea-pc-teste01.evokaudio.local',
    activeConnections: 0,
    adObjectGuid: 'guid-1',
  };

  /** fetch que distingue o login do SERVIÇO do login da PESSOA. */
  function fetchSessao({ usuarioExiste }: { usuarioExiste: boolean }) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const mock = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });

      if (url.endsWith('/api/tokens')) {
        const corpo = String(init?.body ?? '');
        // O login da pessoa usa o usuário `dash-...`; o do serviço, não.
        const ehPessoa = corpo.includes('dash-');
        return jsonResponse(200, { authToken: ehPessoa ? TOKEN_DA_PESSOA : TOKEN });
      }
      if (url.includes('/users/dash-') && init?.method === undefined) {
        return usuarioExiste ? jsonResponse(200, { username: 'dash-fulano.silva' }) : emptyResponse(404);
      }
      return emptyResponse(204);
    });
    vi.stubGlobal('fetch', mock);
    return { mock, calls };
  }

  it('o nome da conta é determinístico a partir do usuário do dashboard', () => {
    expect(service.sessionUserNameFor('admin')).toBe('dash-admin');
    expect(service.sessionUserNameFor('admin')).toBe(service.sessionUserNameFor('admin'));
  });

  it('o nome da conta é sanitizado, mas continua estável', () => {
    // Chave estável é o ponto: sem determinismo, cada abertura de sessão
    // criaria uma conta nova e o Guacamole acumularia órfãos — o mesmo
    // problema que o objectGUID resolveu para computador↔conexão.
    const primeiro = service.sessionUserNameFor('EVOKAUDIO\\Fulano Silva');
    const segundo = service.sessionUserNameFor('EVOKAUDIO\\Fulano Silva');
    expect(primeiro).toBe(segundo);
    expect(primeiro).toMatch(/^dash-[a-z0-9._-]+$/);
  });

  it('pessoa NOVA: cria a conta (POST /users)', async () => {
    const { calls } = fetchSessao({ usuarioExiste: false });

    await service.remoteAccessService.openSession(PESSOA, conexao);

    const criacao = calls.find((c) => c.url.includes('/users?') && c.init?.method === 'POST');
    expect(criacao).toBeDefined();
    expect(JSON.parse(String(criacao?.init?.body)).username).toBe('dash-fulano.silva');
  });

  it('pessoa CONHECIDA: reusa a conta (PUT), não cria outra', async () => {
    const { calls } = fetchSessao({ usuarioExiste: true });

    await service.remoteAccessService.openSession(PESSOA, conexao);

    expect(calls.some((c) => c.url.includes('/users?') && c.init?.method === 'POST')).toBe(false);
    expect(calls.some((c) => c.url.includes('/users/dash-') && c.init?.method === 'PUT')).toBe(true);
  });

  it('concede READ apenas na conexão pedida — nunca ADMINISTER', async () => {
    const { calls } = fetchSessao({ usuarioExiste: true });

    await service.remoteAccessService.openSession(PESSOA, conexao);

    const permissao = calls.find((c) => c.init?.method === 'PATCH');
    const patch = JSON.parse(String(permissao?.init?.body));
    expect(patch).toEqual([
      { op: 'add', path: '/connectionPermissions/10', value: 'READ' },
    ]);
    expect(JSON.stringify(patch)).not.toContain('ADMINISTER');
    expect(JSON.stringify(patch)).not.toContain('systemPermissions');
  });

  it('a URL devolvida carrega o token DA PESSOA, nunca o do serviço', async () => {
    // Se esta asserção cair, voltou o buraco de escalação de privilégio que
    // a sonda matou: o token do serviço no navegador permite criar conexões.
    fetchSessao({ usuarioExiste: true });

    const sessao = await service.remoteAccessService.openSession(PESSOA, conexao);

    expect(sessao.url).toContain(`token=${TOKEN_DA_PESSOA}`);
    expect(sessao.url).not.toContain(TOKEN);
    expect(sessao.guacamoleUser).toBe('dash-fulano.silva');
  });

  it('nenhuma credencial de domínio transita: ela nem existe na API', async () => {
    // Garantia por CAMINHO, não por disciplina: a conexão não tem
    // username/password, então o Guacamole pede a credencial no navegador e
    // ela vai direto ao guacd. `openSession` sequer aceita um parâmetro onde
    // uma credencial de domínio caberia.
    const { calls } = fetchSessao({ usuarioExiste: true });

    await service.remoteAccessService.openSession(PESSOA, conexao);

    const corpos = calls.map((c) => String(c.init?.body ?? '')).join('|');
    expect(corpos).not.toContain('domain');
    expect(service.remoteAccessService.openSession).toHaveLength(2);
  });

  it('a senha da conta é rotacionada a cada sessão (não fica guardada)', async () => {
    const primeira = fetchSessao({ usuarioExiste: true });
    await service.remoteAccessService.openSession(PESSOA, conexao);
    const senha1 = JSON.parse(
      String(primeira.calls.find((c) => c.init?.method === 'PUT')?.init?.body),
    ).password;

    service.resetSessionForTests();
    const segunda = fetchSessao({ usuarioExiste: true });
    await service.remoteAccessService.openSession(PESSOA, conexao);
    const senha2 = JSON.parse(
      String(segunda.calls.find((c) => c.init?.method === 'PUT')?.init?.body),
    ).password;

    expect(senha1).not.toBe(senha2);
    expect(senha1.length).toBeGreaterThanOrEqual(24);
  });

  it('buildClientId usa o formato NUL-separado que a UI do Guacamole espera', () => {
    const id = service.buildClientId('10', 'postgresql');
    expect(Buffer.from(id, 'base64').toString('utf8')).toBe('10\u0000c\u0000postgresql');
  });
});
