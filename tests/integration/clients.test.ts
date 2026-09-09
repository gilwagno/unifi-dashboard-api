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
    setClientFixedIp: vi.fn(async () => undefined),
    setClientAlias: vi.fn(async () => undefined),
    setClientHostname: vi.fn(async () => undefined),
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
const { unifiService } = await import('../../src/services/unifi.service.js');
const { unifiClassicService, ClassicApiNotConfiguredError, UniFiClassicApiError } = await import(
  '../../src/services/unifi-classic.service.js'
);

beforeEach(() => {
  vi.mocked(unifiClassicService.isConfigured).mockClear();
  vi.mocked(unifiClassicService.getBlockedMacs).mockClear();
  vi.mocked(unifiClassicService.blockClient).mockClear();
  vi.mocked(unifiClassicService.unblockClient).mockClear();
  vi.mocked(unifiClassicService.setClientFixedIp).mockClear();
  vi.mocked(unifiClassicService.setClientAlias).mockClear();
  vi.mocked(unifiClassicService.setClientHostname).mockClear();
});

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token };
}

describe('GET /clients', () => {
  it('usa o site padrão quando siteId não é informado', async () => {
    const { app, token } = await authedApp();

    await app.inject({ method: 'GET', url: '/clients', headers: { authorization: `Bearer ${token}` } });

    expect(unifiService.listClients).toHaveBeenCalledWith(undefined);

    await app.close();
  });

  it('repassa siteId da query string para o serviço', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/clients?siteId=site-2',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiService.listClients).toHaveBeenCalledWith('site-2');

    await app.close();
  });

  it('filtra por blocked e type', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiService.listClients).mockResolvedValueOnce({
      data: [
        { id: '1', macAddress: 'aa:aa:aa:aa:aa:aa', type: 'WIRED', blocked: false },
        { id: '2', macAddress: 'bb:bb:bb:bb:bb:bb', type: 'WIRELESS', blocked: true },
        { id: '3', macAddress: 'cc:cc:cc:cc:cc:cc', type: 'WIRELESS', blocked: false },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/clients?blocked=false&type=WIRELESS',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      { id: '3', macAddress: 'cc:cc:cc:cc:cc:cc', type: 'WIRELESS', blocked: false },
    ]);

    await app.close();
  });

  it('pagina os resultados com page e pageSize', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiService.listClients).mockResolvedValueOnce({
      data: Array.from({ length: 5 }, (_, i) => ({
        id: `${i}`,
        macAddress: `aa:aa:aa:aa:aa:0${i}`,
        type: 'WIRED',
        blocked: false,
      })),
    });

    const res = await app.inject({
      method: 'GET',
      url: '/clients?page=2&pageSize=2',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data).toHaveLength(2);
    expect(body.data[0].id).toBe('2');
    expect(body.pagination).toEqual({ page: 2, pageSize: 2, total: 5, totalPages: 3 });

    await app.close();
  });

  it('rejeita type inválido', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'GET',
      url: '/clients?type=BLUETOOTH',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('cruza o status de bloqueio com a API clássica quando configurada', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.isConfigured).mockReturnValueOnce(true);
    vi.mocked(unifiClassicService.getBlockedMacs).mockResolvedValueOnce(new Set(['bb:bb:bb:bb:bb:bb']));
    vi.mocked(unifiService.listClients).mockResolvedValueOnce({
      data: [
        { id: '1', macAddress: 'aa:aa:aa:aa:aa:aa', type: 'WIRED', blocked: false },
        { id: '2', macAddress: 'bb:bb:bb:bb:bb:bb', type: 'WIRELESS', blocked: false },
      ],
    });

    const res = await app.inject({
      method: 'GET',
      url: '/clients',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const clients = res.json().data;
    expect(clients.find((c: { id: string }) => c.id === '1').blocked).toBe(false);
    expect(clients.find((c: { id: string }) => c.id === '2').blocked).toBe(true);

    await app.close();
  });

  it('não chama a API clássica quando ela não está configurada', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.isConfigured).mockReturnValueOnce(false);

    await app.inject({ method: 'GET', url: '/clients', headers: { authorization: `Bearer ${token}` } });

    expect(unifiClassicService.getBlockedMacs).not.toHaveBeenCalled();

    await app.close();
  });
});

describe('POST /clients/:mac/block', () => {
  it('chama unifiClassicService.blockClient com o mac', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/clients/aa:bb:cc:dd:ee:ff/block',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiClassicService.blockClient).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff');

    await app.close();
  });

  it('retorna 503 quando a API clássica não está configurada', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.blockClient).mockRejectedValueOnce(new ClassicApiNotConfiguredError());

    const res = await app.inject({
      method: 'POST',
      url: '/clients/aa:bb:cc:dd:ee:ff/block',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(503);

    await app.close();
  });

  it('retorna 404 quando o MAC nunca foi visto pelo controller (evita registro fantasma)', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.blockClient).mockRejectedValueOnce(
      new UniFiClassicApiError(404, 'Cliente ff:ff:ff:ff:ff:ff não é conhecido pelo controller'),
    );

    const res = await app.inject({
      method: 'POST',
      url: '/clients/ff:ff:ff:ff:ff:ff/block',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);

    await app.close();
  });
});

describe('POST /clients/:mac/unblock', () => {
  it('chama unifiClassicService.unblockClient com o mac', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/clients/aa:bb:cc:dd:ee:ff/unblock',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiClassicService.unblockClient).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff');

    await app.close();
  });
});

describe('PATCH /clients/:mac/fixed-ip', () => {
  it('liga o IP fixo com o ip informado', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/fixed-ip',
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: true, ip: '172.16.0.50' },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiClassicService.setClientFixedIp).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff', {
      enabled: true,
      ip: '172.16.0.50',
      networkId: undefined,
    });

    await app.close();
  });

  it('desliga o IP fixo sem exigir ip', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/fixed-ip',
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiClassicService.setClientFixedIp).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff', {
      enabled: false,
      ip: undefined,
      networkId: undefined,
    });

    await app.close();
  });

  it('rejeita enabled=true sem ip', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/fixed-ip',
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: true },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('rejeita ip inválido', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/fixed-ip',
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: true, ip: 'not-an-ip' },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('retorna 404 quando o MAC não é conhecido pelo controller', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.setClientFixedIp).mockRejectedValueOnce(
      new UniFiClassicApiError(404, 'Cliente ff:ff:ff:ff:ff:ff não é conhecido pelo controller'),
    );

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/ff:ff:ff:ff:ff:ff/fixed-ip',
      headers: { authorization: `Bearer ${token}` },
      payload: { enabled: true, ip: '172.16.0.50' },
    });

    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/fixed-ip',
      payload: { enabled: false },
    });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe('PATCH /clients/:mac/alias', () => {
  it('renomeia o apelido do cliente', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/alias',
      headers: { authorization: `Bearer ${token}` },
      payload: { alias: 'Impressora Recepção' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(unifiClassicService.setClientAlias).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff', 'Impressora Recepção');

    await app.close();
  });

  it('retorna 404 quando o MAC não é conhecido pelo controller', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.setClientAlias).mockRejectedValueOnce(
      new UniFiClassicApiError(404, 'Cliente ff:ff:ff:ff:ff:ff não é conhecido pelo controller'),
    );

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/ff:ff:ff:ff:ff:ff/alias',
      headers: { authorization: `Bearer ${token}` },
      payload: { alias: 'Novo apelido' },
    });

    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('retorna 503 quando a API clássica não está configurada', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.setClientAlias).mockRejectedValueOnce(new ClassicApiNotConfiguredError());

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/alias',
      headers: { authorization: `Bearer ${token}` },
      payload: { alias: 'Novo apelido' },
    });

    expect(res.statusCode).toBe(503);

    await app.close();
  });

  it('rejeita alias vazio', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/alias',
      headers: { authorization: `Bearer ${token}` },
      payload: { alias: '' },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('rejeita alias só com espaços (o trim roda antes do min(1))', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/alias',
      headers: { authorization: `Bearer ${token}` },
      payload: { alias: '   ' },
    });

    expect(res.statusCode).toBe(400);
    expect(unifiClassicService.setClientAlias).not.toHaveBeenCalled();

    await app.close();
  });

  it('repassa o alias já sem os espaços das pontas pro controller', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/alias',
      headers: { authorization: `Bearer ${token}` },
      payload: { alias: '  Impressora Recepção  ' },
    });

    expect(res.statusCode).toBe(200);
    // O apelido é exibido no painel do UniFi — espaço nas pontas iria junto
    // se o trim não fosse aplicado ao valor repassado, não só à validação.
    expect(unifiClassicService.setClientAlias).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff', 'Impressora Recepção');

    await app.close();
  });

  it('rejeita alias maior que 128 caracteres', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/alias',
      headers: { authorization: `Bearer ${token}` },
      payload: { alias: 'a'.repeat(129) },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/alias',
      payload: { alias: 'Novo apelido' },
    });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

// ACHADO AO VIVO (sessão de continuação do reboot HP, 2026-09-09): o
// `hostname` bruto exibido no UniFi fica cacheado no controller e, pra
// clientes com IP estático, nunca é reaprendido sozinho — mesmo com o
// próprio dispositivo já anunciando um valor novo em toda fonte que ele
// expõe (SNMP, TCP/IPv4, mDNS) e mesmo depois de reboot, forçar reconexão e
// "esquecer" o cliente no controller. Sobrescrever direto via PUT em
// /rest/user/{id} (mesmo endpoint que /alias já usa) foi o único mecanismo
// que corrigiu de verdade — ver a DECISÃO em
// unifi-classic.service.ts#setHostname. Suíte espelha exatamente
// PATCH /clients/:mac/alias (mesmo formato de rota/validação), corrigindo
// só o nome do campo.
describe('PATCH /clients/:mac/hostname', () => {
  it('sobrescreve o hostname bruto exibido no UniFi', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/hostname',
      headers: { authorization: `Bearer ${token}` },
      payload: { hostname: 'Financeiro' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true });
    expect(unifiClassicService.setClientHostname).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff', 'Financeiro');

    await app.close();
  });

  it('retorna 404 quando o MAC não é conhecido pelo controller', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.setClientHostname).mockRejectedValueOnce(
      new UniFiClassicApiError(404, 'Cliente ff:ff:ff:ff:ff:ff não é conhecido pelo controller'),
    );

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/ff:ff:ff:ff:ff:ff/hostname',
      headers: { authorization: `Bearer ${token}` },
      payload: { hostname: 'Novo hostname' },
    });

    expect(res.statusCode).toBe(404);

    await app.close();
  });

  it('retorna 503 quando a API clássica não está configurada', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.setClientHostname).mockRejectedValueOnce(new ClassicApiNotConfiguredError());

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/hostname',
      headers: { authorization: `Bearer ${token}` },
      payload: { hostname: 'Novo hostname' },
    });

    expect(res.statusCode).toBe(503);

    await app.close();
  });

  // ACHADO DO CRÍTICO (2026-09-09): `LocalDnsRecordRequiresFixedIpError`
  // (unifi-classic.service.ts) existe especificamente pra esta rota, mas
  // nenhum teste confirmava que o 409 chegava até o cliente HTTP — mudar o
  // `super(409, ...)` pra qualquer outro status passaria com a suíte
  // inteira verde (o erro handler central cairia no fallback 502 sem
  // ninguém notar).
  it('retorna 409 quando o cliente não tem IP fixo habilitado (LocalDnsRecordRequiresFixedIpError)', async () => {
    const { app, token } = await authedApp();
    vi.mocked(unifiClassicService.setClientHostname).mockRejectedValueOnce(
      new UniFiClassicApiError(409, 'Cliente aa:bb:cc:dd:ee:ff precisa ter IP fixo habilitado'),
    );

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/hostname',
      headers: { authorization: `Bearer ${token}` },
      payload: { hostname: 'Novo hostname' },
    });

    expect(res.statusCode).toBe(409);
    expect(res.json().details).toContain('IP fixo');

    await app.close();
  });

  it('rejeita hostname vazio', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/hostname',
      headers: { authorization: `Bearer ${token}` },
      payload: { hostname: '' },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('rejeita hostname só com espaços (o trim roda antes do min(1))', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/hostname',
      headers: { authorization: `Bearer ${token}` },
      payload: { hostname: '   ' },
    });

    expect(res.statusCode).toBe(400);
    expect(unifiClassicService.setClientHostname).not.toHaveBeenCalled();

    await app.close();
  });

  it('repassa o hostname já sem os espaços das pontas pro controller', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/hostname',
      headers: { authorization: `Bearer ${token}` },
      payload: { hostname: '  Financeiro  ' },
    });

    expect(res.statusCode).toBe(200);
    expect(unifiClassicService.setClientHostname).toHaveBeenCalledWith('aa:bb:cc:dd:ee:ff', 'Financeiro');

    await app.close();
  });

  it('rejeita hostname maior que 128 caracteres', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/hostname',
      headers: { authorization: `Bearer ${token}` },
      payload: { hostname: 'a'.repeat(129) },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const app = await buildApp();

    const res = await app.inject({
      method: 'PATCH',
      url: '/clients/aa:bb:cc:dd:ee:ff/hostname',
      payload: { hostname: 'Novo hostname' },
    });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe('POST /clients/:mac/block validação', () => {
  it('mac inválido retorna 400 pelo error handler central', async () => {
    const { app, token } = await authedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/clients/not-a-mac/block',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json().error).toBe('Dados inválidos');

    await app.close();
  });
});
