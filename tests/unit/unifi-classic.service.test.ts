import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

function loginResponse() {
  return jsonResponse(
    { meta: { rc: 'ok' } },
    { headers: { 'set-cookie': 'unifises=abc123; Path=/; HttpOnly', 'x-csrf-token': 'csrf-token-1' } },
  );
}

describe('unifiClassicService', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    process.env.UNIFI_CONTROLLER_USER = 'admin';
    process.env.UNIFI_CONTROLLER_PASSWORD = 'secret';
    process.env.UNIFI_CONTROLLER_SITE = 'default';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it('isConfigured() reflete se as credenciais estão presentes', async () => {
    const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
    expect(unifiClassicService.isConfigured()).toBe(true);
  });

  it('lança ClassicApiNotConfiguredError quando as credenciais não estão configuradas', async () => {
    delete process.env.UNIFI_CONTROLLER_USER;
    delete process.env.UNIFI_CONTROLLER_PASSWORD;
    vi.resetModules();

    const { unifiClassicService, ClassicApiNotConfiguredError } = await import(
      '../../src/services/unifi-classic.service.js'
    );

    await expect(unifiClassicService.blockClient('aa:bb:cc:dd:ee:ff')).rejects.toBeInstanceOf(
      ClassicApiNotConfiguredError,
    );
  });

  it('faz login antes da primeira chamada e reusa a sessão nas seguintes', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/login')) return loginResponse();
      if (url.includes('/rest/user')) {
        return jsonResponse({ meta: { rc: 'ok' }, data: [{ mac: 'aa:bb:cc:dd:ee:ff', blocked: false }] });
      }
      if (url.includes('/cmd/stamgr')) return jsonResponse({ meta: { rc: 'ok' }, data: [{ blocked: true }] });
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');

    await unifiClassicService.blockClient('aa:bb:cc:dd:ee:ff');
    await unifiClassicService.unblockClient('aa:bb:cc:dd:ee:ff');

    const loginCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/login'));
    expect(loginCalls).toHaveLength(1);
  });

  it('refaz login uma vez quando recebe 401 (sessão expirada) e repete a chamada', async () => {
    let restUserCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/login')) return loginResponse();
      if (url.includes('/rest/user')) {
        restUserCalls++;
        if (restUserCalls === 1) return jsonResponse({ meta: { rc: 'error' } }, { status: 401 });
        return jsonResponse({ meta: { rc: 'ok' }, data: [{ mac: 'aa:bb:cc:dd:ee:ff', blocked: false }] });
      }
      if (url.includes('/cmd/stamgr')) return jsonResponse({ meta: { rc: 'ok' }, data: [] });
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');

    await unifiClassicService.blockClient('aa:bb:cc:dd:ee:ff');

    const loginCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/login'));
    expect(loginCalls).toHaveLength(2);
    expect(restUserCalls).toBe(2);
  });

  it('blockClient lança UnknownClientError (404) para um MAC nunca visto, sem chamar cmd/stamgr', async () => {
    const stamgrCalls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/auth/login')) return loginResponse();
      if (url.includes('/rest/user')) {
        return jsonResponse({
          meta: { rc: 'ok' },
          data: [{ mac: 'aa:aa:aa:aa:aa:aa', blocked: false }],
        });
      }
      if (url.includes('/cmd/stamgr')) {
        stamgrCalls.push(String(init?.body));
        return jsonResponse({ meta: { rc: 'ok' }, data: [] });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { unifiClassicService, UnknownClientError } = await import(
      '../../src/services/unifi-classic.service.js'
    );

    await expect(unifiClassicService.blockClient('ff:ff:ff:ff:ff:ff')).rejects.toBeInstanceOf(
      UnknownClientError,
    );
    await expect(unifiClassicService.unblockClient('ff:ff:ff:ff:ff:ff')).rejects.toBeInstanceOf(
      UnknownClientError,
    );

    // Nunca deve mandar block-sta/unblock-sta pra um MAC desconhecido —
    // isso é o que cria o registro fantasma no controller.
    expect(stamgrCalls).toHaveLength(0);
  });

  it('UnknownClientError carrega status 404', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/login')) return loginResponse();
      if (url.includes('/rest/user')) return jsonResponse({ meta: { rc: 'ok' }, data: [] });
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { unifiClassicService, UniFiClassicApiError } = await import(
      '../../src/services/unifi-classic.service.js'
    );

    try {
      await unifiClassicService.blockClient('ff:ff:ff:ff:ff:ff');
      expect.unreachable('deveria ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(UniFiClassicApiError);
      expect((err as InstanceType<typeof UniFiClassicApiError>).status).toBe(404);
    }
  });

  it('getBlockedMacs() retorna só os MACs com blocked: true', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/login')) return loginResponse();
      if (url.includes('/rest/user')) {
        return jsonResponse({
          meta: { rc: 'ok' },
          data: [
            { mac: 'aa:aa:aa:aa:aa:aa', blocked: true },
            { mac: 'bb:bb:bb:bb:bb:bb', blocked: false },
            { mac: 'cc:cc:cc:cc:cc:cc' },
          ],
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
    const blocked = await unifiClassicService.getBlockedMacs();

    expect(blocked).toEqual(new Set(['aa:aa:aa:aa:aa:aa']));
  });
});
