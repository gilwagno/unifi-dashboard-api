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
    getSshInfo: vi.fn(async () => ({
      sshEnabled: true,
      sshUsername: '9KYZHt6',
      passwordAuthEnabled: true,
    })),
    rotateSshCredentials: vi.fn(async (opts: { username?: string; password?: string }) => ({
      sshUsername: opts.username ?? '9KYZHt6',
      sshPassword: opts.password ?? 'generated-strong-password-1234',
    })),
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

const { buildApp } = await import('../../src/app.js');
const { unifiClassicService, ClassicApiNotConfiguredError } = await import(
  '../../src/services/unifi-classic.service.js'
);

beforeEach(() => {
  vi.mocked(unifiClassicService.getSshInfo).mockClear();
  vi.mocked(unifiClassicService.rotateSshCredentials).mockClear();
});

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token };
}

describe('GET /ssh-credentials', () => {
  it('retorna só os campos seguros — sem senha, token ou chave nenhuma', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/ssh-credentials',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toEqual({
      sshEnabled: true,
      sshUsername: '9KYZHt6',
      passwordAuthEnabled: true,
    });

    // Apenas os três campos públicos podem existir na resposta — nenhuma
    // variação de nome de campo sensível (senha, hash, token, chave) pode
    // aparecer aqui. `passwordAuthEnabled` é o único campo esperado que
    // contém a substring "password", por isso comparamos as CHAVES do
    // objeto (allowlist) em vez de buscar a substring no JSON inteiro.
    expect(Object.keys(body).sort()).toEqual(['passwordAuthEnabled', 'sshEnabled', 'sshUsername'].sort());
    const serialized = JSON.stringify(body).toLowerCase();
    expect(serialized).not.toMatch(/sshpassword/);
    expect(serialized).not.toMatch(/x_ssh_password/);
    expect(serialized).not.toMatch(/sha512/);
    expect(serialized).not.toMatch(/token/);
    expect(serialized).not.toMatch(/mgmt_key/);

    await app.close();
  });

  it('retorna 503 quando a API clássica não está configurada', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.getSshInfo).mockRejectedValueOnce(new ClassicApiNotConfiguredError());

    const res = await app.inject({
      method: 'GET',
      url: '/ssh-credentials',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(503);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();

    const res = await app.inject({ method: 'GET', url: '/ssh-credentials' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe('POST /ssh-credentials/rotate', () => {
  it('sem body: gera uma senha nova e retorna ela em texto puro', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/ssh-credentials/rotate',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sshUsername).toBe('9KYZHt6');
    expect(body.sshPassword).toBe('generated-strong-password-1234');
    expect(unifiClassicService.rotateSshCredentials).toHaveBeenCalledWith({ username: undefined, password: undefined });

    await app.close();
  });

  it('com password customizada: usa a senha fornecida em vez de gerar uma', async () => {
    const { app, token } = await authedApp();
    const customPassword = 'minha-senha-forte-123';

    const res = await app.inject({
      method: 'POST',
      url: '/ssh-credentials/rotate',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: customPassword },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.sshPassword).toBe(customPassword);
    expect(unifiClassicService.rotateSshCredentials).toHaveBeenCalledWith({
      username: undefined,
      password: customPassword,
    });

    await app.close();
  });

  it('com username customizado: usa o username fornecido', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/ssh-credentials/rotate',
      headers: { authorization: `Bearer ${token}` },
      payload: { username: 'novo-usuario' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().sshUsername).toBe('novo-usuario');

    await app.close();
  });

  it('rejeita senha manual com menos de 12 caracteres (validação Zod)', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/ssh-credentials/rotate',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: 'curta' },
    });

    expect(res.statusCode).toBe(400);
    expect(unifiClassicService.rotateSshCredentials).not.toHaveBeenCalled();

    await app.close();
  });

  it('retorna 503 quando a API clássica não está configurada', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.rotateSshCredentials).mockRejectedValueOnce(new ClassicApiNotConfiguredError());

    const res = await app.inject({
      method: 'POST',
      url: '/ssh-credentials/rotate',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(503);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();

    const res = await app.inject({ method: 'POST', url: '/ssh-credentials/rotate' });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});
