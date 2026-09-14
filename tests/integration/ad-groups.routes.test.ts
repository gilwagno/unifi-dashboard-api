import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdGroup } from '../../src/services/ad.service.js';

// Onda 3, subtarefa 3 (grupos/privilégios). Mesmo padrão de
// tests/integration/ad.routes.test.ts: mock na camada de SERVIÇO (nunca a
// implementação interna da rota), classes de erro vêm do módulo real via
// `importOriginal` porque o error handler central (src/app.ts) faz
// `instanceof` contra elas.
vi.mock('../../src/services/ad.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/ad.service.js')>();
  return {
    ...actual,
    searchGroups: vi.fn(),
    getGroup: vi.fn(),
    createGroup: vi.fn(),
    addGroupMember: vi.fn(),
    removeGroupMember: vi.fn(),
  };
});

const { buildApp } = await import('../../src/app.js');
const {
  searchGroups,
  getGroup,
  createGroup,
  addGroupMember,
  removeGroupMember,
  AdGroupNotFoundError,
  AdGroupsOuNotConfiguredError,
  AdNotConfiguredError,
  AdUserNotFoundError,
} = await import('../../src/services/ad.service.js');

// mockReset() (não mockClear()) — mesmo achado documentado no CLAUDE.md
// ("Troca de senha de admin da HP: reaberta..."): mockClear() não limpa uma
// rejeição/resolução enfileirada com *Once que ficou sem ser consumida (ex.:
// um teste anterior chamando a rota 2x mas só consumindo 1 *Once), o que
// vazaria pro PRÓXIMO teste que de fato invoca o mock.
beforeEach(() => {
  vi.mocked(searchGroups).mockReset();
  vi.mocked(getGroup).mockReset();
  vi.mocked(createGroup).mockReset();
  vi.mocked(addGroupMember).mockReset();
  vi.mocked(removeGroupMember).mockReset();
});

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token, headers: { authorization: `Bearer ${token}` } };
}

const SAMPLE_GROUP: AdGroup = {
  dn: 'CN=Financeiro,CN=Users,DC=test,DC=local',
  cn: 'Financeiro',
  description: 'Equipe do financeiro',
  members: ['CN=jsilva,OU=Funcionarios,DC=test,DC=local'],
};

describe('GET /ad/groups', () => {
  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();
    const res = await app.inject({ method: 'GET', url: '/ad/groups' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('lista grupos, repassando a query opcional pro serviço', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(searchGroups).mockResolvedValueOnce([SAMPLE_GROUP]);

    const res = await app.inject({ method: 'GET', url: '/ad/groups?query=financ', headers });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [SAMPLE_GROUP] });
    expect(searchGroups).toHaveBeenCalledWith('financ');
    await app.close();
  });

  it('retorna 503 quando o AD não está configurado', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(searchGroups).mockRejectedValueOnce(new AdNotConfiguredError());

    const res = await app.inject({ method: 'GET', url: '/ad/groups', headers });

    expect(res.statusCode).toBe(503);
    await app.close();
  });
});

describe('GET /ad/groups/:groupName', () => {
  it('devolve o grupo', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(getGroup).mockResolvedValueOnce(SAMPLE_GROUP);

    const res = await app.inject({ method: 'GET', url: '/ad/groups/Financeiro', headers });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual(SAMPLE_GROUP);
    expect(getGroup).toHaveBeenCalledWith('Financeiro');
    await app.close();
  });

  it('retorna 404 quando o grupo não existe', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(getGroup).mockRejectedValueOnce(new AdGroupNotFoundError('NaoExiste'));

    const res = await app.inject({ method: 'GET', url: '/ad/groups/NaoExiste', headers });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /ad/groups', () => {
  it('cria o grupo e devolve 201', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(createGroup).mockResolvedValueOnce(SAMPLE_GROUP);

    const res = await app.inject({
      method: 'POST',
      url: '/ad/groups',
      headers,
      payload: { name: 'Financeiro', description: 'Equipe do financeiro' },
    });

    expect(res.statusCode).toBe(201);
    expect(res.json()).toEqual(SAMPLE_GROUP);
    expect(createGroup).toHaveBeenCalledWith({ name: 'Financeiro', description: 'Equipe do financeiro' });
    await app.close();
  });

  it('retorna 400 quando `name` tem caractere não permitido pelo AD (vírgula) — defesa em profundidade sobre o escape de DN do serviço', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({ method: 'POST', url: '/ad/groups', headers, payload: { name: 'x,OU=Servidores' } });

    expect(res.statusCode).toBe(400);
    expect(createGroup).not.toHaveBeenCalled();
    await app.close();
  });

  it('retorna 400 quando `name` excede 64 caracteres (limite real do atributo cn do AD)', async () => {
    const { app, headers } = await authedApp();
    const res = await app.inject({ method: 'POST', url: '/ad/groups', headers, payload: { name: 'x'.repeat(65) } });

    expect(res.statusCode).toBe(400);
    expect(createGroup).not.toHaveBeenCalled();
    await app.close();
  });

  it('retorna 503 quando AD_GROUPS_OU não está configurado', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(createGroup).mockRejectedValueOnce(new AdGroupsOuNotConfiguredError());

    const res = await app.inject({ method: 'POST', url: '/ad/groups', headers, payload: { name: 'Financeiro' } });

    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('está sob rate limit restrito (RATE_LIMIT_CLIENT_ACTION_MAX) — mesma disciplina das demais mutações do módulo', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(createGroup).mockResolvedValue(SAMPLE_GROUP);

    const { env } = await import('../../src/config/env.js');
    let last;
    for (let i = 0; i < env.RATE_LIMIT_CLIENT_ACTION_MAX + 1; i += 1) {
      last = await app.inject({ method: 'POST', url: '/ad/groups', headers, payload: { name: `Grupo${i}` } });
    }
    expect(last?.statusCode).toBe(429);
    await app.close();
  });
});

describe('POST /ad/groups/:groupName/members/:username', () => {
  it('adiciona o membro e devolve { ok: true }', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(addGroupMember).mockResolvedValueOnce(undefined);

    const res = await app.inject({ method: 'POST', url: '/ad/groups/Financeiro/members/jsilva', headers });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(addGroupMember).toHaveBeenCalledWith('Financeiro', 'jsilva');
    await app.close();
  });

  it('retorna 404 quando o grupo não existe', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(addGroupMember).mockRejectedValueOnce(new AdGroupNotFoundError('Financeiro'));

    const res = await app.inject({ method: 'POST', url: '/ad/groups/Financeiro/members/jsilva', headers });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('retorna 404 quando o usuário não existe', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(addGroupMember).mockRejectedValueOnce(new AdUserNotFoundError('ninguem'));

    const res = await app.inject({ method: 'POST', url: '/ad/groups/Financeiro/members/ninguem', headers });

    expect(res.statusCode).toBe(404);
    await app.close();
  });

  // ACHADO DA VERIFICAÇÃO (mutante executado: remover `mutationConfig` das
  // DUAS rotas de membership deixava a suíte inteira verde — 49/49 — apesar
  // de POST /ad/groups já ter o teste equivalente). São justamente as rotas
  // que CONCEDEM/REVOGAM privilégio no AD: sem limite restrito, elas caíam
  // no limite global (100/min) em vez do de ação (10/min) — exatamente a
  // mesma classe do achado 0.2 da revisão externa (3 rotas DELETE sem
  // RATE_LIMIT_CLIENT_ACTION_MAX), agora na superfície mais sensível do
  // módulo.
  it('está sob rate limit restrito (RATE_LIMIT_CLIENT_ACTION_MAX)', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(addGroupMember).mockResolvedValue(undefined);

    const { env } = await import('../../src/config/env.js');
    let last;
    for (let i = 0; i < env.RATE_LIMIT_CLIENT_ACTION_MAX + 1; i += 1) {
      last = await app.inject({ method: 'POST', url: '/ad/groups/Financeiro/members/jsilva', headers });
    }
    expect(last?.statusCode).toBe(429);
    await app.close();
  });
});

describe('DELETE /ad/groups/:groupName/members/:username', () => {
  it('remove o membro e devolve { ok: true } — idempotente do lado do serviço, a rota só repassa', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(removeGroupMember).mockResolvedValueOnce(undefined);

    const res = await app.inject({ method: 'DELETE', url: '/ad/groups/Financeiro/members/jsilva', headers });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(removeGroupMember).toHaveBeenCalledWith('Financeiro', 'jsilva');
    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();
    const res = await app.inject({ method: 'DELETE', url: '/ad/groups/Financeiro/members/jsilva' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
  it('está sob rate limit restrito (RATE_LIMIT_CLIENT_ACTION_MAX) — revogar privilégio é mutação como qualquer outra', async () => {
    const { app, headers } = await authedApp();
    vi.mocked(removeGroupMember).mockResolvedValue(undefined);

    const { env } = await import('../../src/config/env.js');
    let last;
    for (let i = 0; i < env.RATE_LIMIT_CLIENT_ACTION_MAX + 1; i += 1) {
      last = await app.inject({ method: 'DELETE', url: '/ad/groups/Financeiro/members/jsilva', headers });
    }
    expect(last?.statusCode).toBe(429);
    await app.close();
  });
});
