import { describe, expect, it, vi } from 'vitest';
import type { AdUser } from '../../src/services/ad.service.js';

// Mock na camada de SERVIÇO (nunca a implementação interna da rota) — mesmo
// padrão do resto do projeto. As classes de erro precisam ser as MESMAS
// instâncias que a rota importa (via `instanceof` no error handler central
// de src/app.ts), então vêm do módulo real por `importOriginal`.
vi.mock('../../src/services/ad.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/ad.service.js')>();
  return {
    ...actual,
    searchUsers: vi.fn(),
    getUser: vi.fn(),
    createUser: vi.fn(),
    updateUser: vi.fn(),
    deleteUser: vi.fn(),
    setUserEnabled: vi.fn(),
    unlockUser: vi.fn(),
    resetPassword: vi.fn(),
    setUserWorkstations: vi.fn(),
    grantNetworkAccess: vi.fn(),
    revokeNetworkAccess: vi.fn(),
  };
});

const { buildApp } = await import('../../src/app.js');
const {
  searchUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  setUserEnabled,
  unlockUser,
  resetPassword,
  setUserWorkstations,
  grantNetworkAccess,
  revokeNetworkAccess,
  AdUserNotFoundError,
  AdNotConfiguredError,
  AdNetworkAccessGroupNotConfiguredError,
  AdPasswordAmbiguousError,
} = await import('../../src/services/ad.service.js');

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token, headers: { authorization: `Bearer ${token}` } };
}

const SAMPLE_USER: AdUser = {
  dn: 'CN=Joao Silva,OU=Funcionarios,DC=test,DC=local',
  sAMAccountName: 'jsilva',
  displayName: 'Joao Silva',
  mail: 'joao.silva@test.local',
  department: 'TI',
  title: 'Analista',
  enabled: true,
  lockedOut: false,
  userWorkstations: [],
};

describe('GET /ad/users', () => {
  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();
    const res = await app.inject({ method: 'GET', url: '/ad/users' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('lista usuários, repassando a query opcional pro serviço', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(searchUsers).mockResolvedValueOnce([SAMPLE_USER]);

    const res = await app.inject({ method: 'GET', url: '/ad/users?query=joao', headers });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [SAMPLE_USER] });
    expect(searchUsers).toHaveBeenCalledWith('joao');
    await app.close();
  });

  it('retorna 503 quando o AD não está configurado', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(searchUsers).mockRejectedValueOnce(new AdNotConfiguredError());

    const res = await app.inject({ method: 'GET', url: '/ad/users', headers });

    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe('GET /ad/users/:username', () => {
  it('retorna o usuário quando existe', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(getUser).mockResolvedValueOnce(SAMPLE_USER);

    const res = await app.inject({ method: 'GET', url: '/ad/users/jsilva', headers });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SAMPLE_USER);
    await app.close();
  });

  it('retorna 404 quando o usuário não existe', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(getUser).mockRejectedValueOnce(new AdUserNotFoundError('nao-existe'));

    const res = await app.inject({ method: 'GET', url: '/ad/users/nao-existe', headers });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /ad/users', () => {
  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();
    const res = await app.inject({ method: 'POST', url: '/ad/users', payload: {} });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('400 quando sAMAccountName ou displayName faltam', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({ method: 'POST', url: '/ad/users', headers, payload: { displayName: 'Só nome' } });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('400 quando sAMAccountName excede o limite de 20 caracteres do AD', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/ad/users',
      headers,
      payload: { sAMAccountName: 'a'.repeat(21), displayName: 'Nome Longo' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('cria o usuário e devolve a senha em texto puro na resposta (única vez)', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(createUser).mockResolvedValueOnce(SAMPLE_USER);

    const res = await app.inject({
      method: 'POST',
      url: '/ad/users',
      headers,
      payload: { sAMAccountName: 'jsilva', displayName: 'Joao Silva', password: 'SenhaInicial123!' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toMatchObject({ ...SAMPLE_USER, password: 'SenhaInicial123!' });
    expect(createUser).toHaveBeenCalledWith(
      expect.objectContaining({ sAMAccountName: 'jsilva', password: 'SenhaInicial123!' }),
    );
    await app.close();
  });

  it('sem password no corpo, gera uma senha aleatória e a devolve na resposta', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(createUser).mockResolvedValueOnce(SAMPLE_USER);

    const res = await app.inject({
      method: 'POST',
      url: '/ad/users',
      headers,
      payload: { sAMAccountName: 'jsilva', displayName: 'Joao Silva' },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(typeof body.password).toBe('string');
    expect(body.password.length).toBeGreaterThan(0);
    expect(createUser).toHaveBeenCalledWith(expect.objectContaining({ password: body.password }));
    await app.close();
  });

  it('retorna 503 quando o AD não está configurado', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(createUser).mockRejectedValueOnce(new AdNotConfiguredError());

    const res = await app.inject({
      method: 'POST',
      url: '/ad/users',
      headers,
      payload: { sAMAccountName: 'jsilva', displayName: 'Joao Silva', password: 'SenhaInicial123!' },
    });

    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('usa RATE_LIMIT_CLIENT_ACTION_MAX (não o limite global) — regressão do mesmo padrão já corrigido em outras rotas DELETE/POST do projeto', async () => {
    const originalMax = process.env.RATE_LIMIT_CLIENT_ACTION_MAX;
    process.env.RATE_LIMIT_CLIENT_ACTION_MAX = '1';
    vi.resetModules();
    try {
      const { buildApp: freshBuildApp } = await import('../../src/app.js');
      const app = await freshBuildApp();
      const token = app.jwt.sign({ sub: 'admin' });
      const headers = { authorization: `Bearer ${token}` };
      vi.mocked(createUser).mockResolvedValue(SAMPLE_USER);

      const payload = { sAMAccountName: 'jsilva', displayName: 'Joao Silva', password: 'SenhaInicial123!' };
      const first = await app.inject({ method: 'POST', url: '/ad/users', headers, payload });
      const second = await app.inject({ method: 'POST', url: '/ad/users', headers, payload });

      expect(first.statusCode).toBe(201);
      expect(second.statusCode).toBe(429);
      await app.close();
    } finally {
      if (originalMax === undefined) delete process.env.RATE_LIMIT_CLIENT_ACTION_MAX;
      else process.env.RATE_LIMIT_CLIENT_ACTION_MAX = originalMax;
      vi.resetModules();
    }
  });
});

describe('PATCH /ad/users/:username', () => {
  it('400 quando o corpo não tem nenhum campo', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({ method: 'PATCH', url: '/ad/users/jsilva', headers, payload: {} });
    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('atualiza e devolve o usuário', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(updateUser).mockResolvedValueOnce({ ...SAMPLE_USER, department: 'Financeiro' });

    const res = await app.inject({
      method: 'PATCH',
      url: '/ad/users/jsilva',
      headers,
      payload: { department: 'Financeiro' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().department).toBe('Financeiro');
    expect(updateUser).toHaveBeenCalledWith('jsilva', { department: 'Financeiro' });
    await app.close();
  });

  it('retorna 404 quando o usuário não existe', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(updateUser).mockRejectedValueOnce(new AdUserNotFoundError('jsilva'));

    const res = await app.inject({ method: 'PATCH', url: '/ad/users/jsilva', headers, payload: { title: 'X' } });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('DELETE /ad/users/:username', () => {
  it('remove e retorna ok', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(deleteUser).mockResolvedValueOnce(undefined);

    const res = await app.inject({ method: 'DELETE', url: '/ad/users/jsilva', headers });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    await app.close();
  });

  it('retorna 404 quando o usuário não existe', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(deleteUser).mockRejectedValueOnce(new AdUserNotFoundError('jsilva'));

    const res = await app.inject({ method: 'DELETE', url: '/ad/users/jsilva', headers });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /ad/users/:username/enable e /disable', () => {
  it('enable chama o serviço com true e retorna ok', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(setUserEnabled).mockResolvedValueOnce(undefined);

    const res = await app.inject({ method: 'POST', url: '/ad/users/jsilva/enable', headers });

    expect(res.statusCode).toBe(200);
    expect(setUserEnabled).toHaveBeenCalledWith('jsilva', true);
    await app.close();
  });

  it('disable chama o serviço com false e retorna ok', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(setUserEnabled).mockResolvedValueOnce(undefined);

    const res = await app.inject({ method: 'POST', url: '/ad/users/jsilva/disable', headers });

    expect(res.statusCode).toBe(200);
    expect(setUserEnabled).toHaveBeenCalledWith('jsilva', false);
    await app.close();
  });
});

describe('POST /ad/users/:username/unlock', () => {
  it('desbloqueia e retorna ok', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(unlockUser).mockResolvedValueOnce(undefined);

    const res = await app.inject({ method: 'POST', url: '/ad/users/jsilva/unlock', headers });

    expect(res.statusCode).toBe(200);
    expect(unlockUser).toHaveBeenCalledWith('jsilva');
    await app.close();
  });
});

describe('POST /ad/users/:username/reset-password', () => {
  it('sem password no corpo, gera uma senha e a devolve (única vez)', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(resetPassword).mockResolvedValueOnce(undefined);

    const res = await app.inject({ method: 'POST', url: '/ad/users/jsilva/reset-password', headers, payload: {} });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.password).toBe('string');
    expect(resetPassword).toHaveBeenCalledWith('jsilva', body.password, true);
    await app.close();
  });

  it('com password explícito e mustChangePasswordAtNextLogon: false, repassa exatamente pro serviço', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(resetPassword).mockResolvedValueOnce(undefined);

    const res = await app.inject({
      method: 'POST',
      url: '/ad/users/jsilva/reset-password',
      headers,
      payload: { password: 'NovaSenha123!', mustChangePasswordAtNextLogon: false },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().password).toBe('NovaSenha123!');
    expect(resetPassword).toHaveBeenCalledWith('jsilva', 'NovaSenha123!', false);
    await app.close();
  });
});

describe('PATCH /ad/users/:username/workstations', () => {
  it('grava a lista de estações permitidas', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(setUserWorkstations).mockResolvedValueOnce(undefined);

    const res = await app.inject({
      method: 'PATCH',
      url: '/ad/users/jsilva/workstations',
      headers,
      payload: { workstations: ['PC-FINANCEIRO', 'PC-COMPRAS'] },
    });

    expect(res.statusCode).toBe(200);
    expect(setUserWorkstations).toHaveBeenCalledWith('jsilva', ['PC-FINANCEIRO', 'PC-COMPRAS']);
    await app.close();
  });

  it('400 quando workstations não é um array', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/ad/users/jsilva/workstations',
      headers,
      payload: { workstations: 'PC-FINANCEIRO' },
    });
    expect(res.statusCode).toBe(400);
    await app.close();
  });
});

describe('ponte 802.1X — POST/DELETE /ad/users/:username/network-access', () => {
  it('concede acesso à rede', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(grantNetworkAccess).mockResolvedValueOnce(undefined);

    const res = await app.inject({ method: 'POST', url: '/ad/users/jsilva/network-access', headers });

    expect(res.statusCode).toBe(200);
    expect(grantNetworkAccess).toHaveBeenCalledWith('jsilva');
    await app.close();
  });

  it('revoga acesso à rede', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(revokeNetworkAccess).mockResolvedValueOnce(undefined);

    const res = await app.inject({ method: 'DELETE', url: '/ad/users/jsilva/network-access', headers });

    expect(res.statusCode).toBe(200);
    expect(revokeNetworkAccess).toHaveBeenCalledWith('jsilva');
    await app.close();
  });

  it('retorna 503 quando o grupo da ponte não está configurado', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(grantNetworkAccess).mockRejectedValueOnce(new AdNetworkAccessGroupNotConfiguredError());

    const res = await app.inject({ method: 'POST', url: '/ad/users/jsilva/network-access', headers });

    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

// ---------------------------------------------------------------------------
// ACHADO 3 da revisão crítica, no nível da ROTA — a senha tentada não pode
// morrer num 502 genérico
// ---------------------------------------------------------------------------
// O serviço preservar a senha em AdPasswordAmbiguousError não fecha o achado
// sozinho: sem este tratamento na rota, o erro caía no handler central de
// src/app.ts e virava um 502 sem a senha. Numa chamada SEM `password` no
// corpo (gerada por randomBytes na própria rota), essa era a única cópia
// existente do valor que o AD PODE ter passado a exigir — e senha não pode
// ir pro log (regra do projeto). Mesmo precedente de
// PrinterSwsPasswordVerificationError em printers.routes.ts.
describe('rotas de AD — senha em estado ambíguo (502 com o valor tentado)', () => {
  it('POST /ad/users devolve 502 com attemptedPassword (senha informada no corpo)', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(createUser).mockRejectedValueOnce(
      new AdPasswordAmbiguousError('ppereira', 'S3nh4Informada!'),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/ad/users',
      headers,
      payload: { sAMAccountName: 'ppereira', displayName: 'Paulo Pereira', password: 'S3nh4Informada!' },
    });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(body.attemptedPassword).toBe('S3nh4Informada!');
    expect(body.attemptedSAMAccountName).toBe('ppereira');
    // A conta pode ter ficado criada e DESABILITADA — o corpo diz isso em vez
    // de deixar o operador supor que nada aconteceu.
    expect(body.accountEnabled).toBe(false);
    await app.close();
  });

  it('POST /ad/users devolve a senha GERADA quando o corpo não informou uma', async () => {
    const { app, headers } = await authedApp();
    // A rota gera a senha por randomBytes e a repassa ao serviço; o erro
    // carrega esse mesmo valor de volta. Sem o ramo na rota, ele se perderia
    // para sempre — este é o cenário exato do achado.
    vi.mocked(createUser).mockImplementationOnce(async (input) => {
      throw new AdPasswordAmbiguousError(input.sAMAccountName, input.password);
    });

    const res = await app.inject({
      method: 'POST',
      url: '/ad/users',
      headers,
      payload: { sAMAccountName: 'ppereira', displayName: 'Paulo Pereira' },
    });

    expect(res.statusCode).toBe(502);
    const generated = res.json().attemptedPassword;
    expect(typeof generated).toBe('string');
    expect(generated.length).toBeGreaterThanOrEqual(8);
    await app.close();
  });

  it('POST /ad/users/:username/reset-password devolve 502 com a senha tentada', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(resetPassword).mockImplementationOnce(async (username, password) => {
      throw new AdPasswordAmbiguousError(username, password);
    });

    const res = await app.inject({
      method: 'POST',
      url: '/ad/users/jsilva/reset-password',
      headers,
      payload: {},
    });

    expect(res.statusCode).toBe(502);
    const body = res.json();
    expect(typeof body.attemptedPassword).toBe('string');
    expect(body.attemptedPassword.length).toBeGreaterThanOrEqual(8);
    // Nunca relata sucesso: o operador não pode achar que a senha antiga vale.
    expect(body.ok).toBeUndefined();
    await app.close();
  });

  it('erro genérico do serviço continua caindo no handler central (não vira 502 com senha)', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(resetPassword).mockRejectedValueOnce(new Error('falha qualquer'));

    const res = await app.inject({
      method: 'POST',
      url: '/ad/users/jsilva/reset-password',
      headers,
      payload: {},
    });

    // O que importa: o ramo do ambíguo NÃO sequestra qualquer erro — só o
    // tipado. Nenhuma senha vaza num caminho que não é o ambíguo.
    expect(res.json().attemptedPassword).toBeUndefined();
    await app.close();
  });
});
