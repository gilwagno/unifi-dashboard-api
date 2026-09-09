import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// POST /printers/:id/reboot — reboot REAL da impressora HP via SWS.
//
// NENHUMA CHAMADA DE REDE REAL: o serviço `printer-hp-sws.service.ts` é
// mockado na CAMADA DE SERVIÇO (mesmo padrão de printers-brother-wbm.test.ts
// e printers-consumables.test.ts, nunca a implementação interna da rota),
// então nem o `fetch` chega a ser exercitado aqui. A impressora HP real
// (172.16.0.89) é a do Financeiro, em produção — um reboot acidental durante
// os testes derrubaria o equipamento de verdade; por isso os testes usam um
// IP de laboratório fictício.
//
// Rate limit desta rota reduzido para 3 (default: RATE_LIMIT_CLIENT_ACTION_MAX
// = 10) só para caber o teste de limite sem 10 injeções repetidas. Cada teste
// constrói seu próprio app, e o contador do @fastify/rate-limit é por
// instância + por rota, então isso não interfere nos outros casos.
process.env.RATE_LIMIT_CLIENT_ACTION_MAX = '3';

vi.mock('../../src/services/unifi.service.js', () => ({
  unifiService: {
    listClients: vi.fn(async () => ({ data: [] })),
  },
  UniFiApiError: class UniFiApiError extends Error {},
}));

vi.mock('../../src/services/unifi-classic.service.js', () => ({
  unifiClassicService: {
    isConfigured: vi.fn(() => false),
    getKnownClientsNetworkInfo: vi.fn(async () => new Map()),
    getConnectedMacs: vi.fn(async () => new Set()),
    blockClient: vi.fn(async () => undefined),
    unblockClient: vi.fn(async () => undefined),
  },
  UniFiClassicApiError: class UniFiClassicApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
      this.name = 'UniFiClassicApiError';
    }
  },
  ClassicApiNotConfiguredError: class ClassicApiNotConfiguredError extends Error {},
}));

// As classes de erro precisam ser as MESMAS que a rota usa no `instanceof`,
// então vêm do módulo real via `importOriginal`.
const rebootMock = vi.fn<(ip: string, mac: string, credentials: { username: string; password: string }) => Promise<void>>(
  async () => undefined,
);

vi.mock('../../src/services/printer-hp-sws.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/printer-hp-sws.service.js')>();
  return {
    ...actual,
    rebootHpPrinter: (ip: string, mac: string, credentials: { username: string; password: string }) =>
      rebootMock(ip, mac, credentials),
  };
});

const tmpDir = mkdtempSync(join(tmpdir(), 'printers-reboot-test-'));
process.env.PRINTERS_DB_FILE = join(tmpDir, 'printers.db');

const { buildApp } = await import('../../src/app.js');
const { printersRepository } = await import('../../src/routes/printers.routes.js');
const { PrinterSwsAuthenticationError, PrinterSwsRequestError, PrinterSwsUnreachableError } = await import(
  '../../src/services/printer-hp-sws.service.js'
);
const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
const { unifiService } = await import('../../src/services/unifi.service.js');

const PRINTER_IP = '10.99.99.99';
const PANEL_PASSWORD = 'senha-do-painel-super-secreta';
const SNMP_SECRET = 'community-super-secreta';

afterAll(() => {
  printersRepository.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token, auth: { authorization: `Bearer ${token}` } };
}

async function createPrinter(
  app: Awaited<ReturnType<typeof buildApp>>,
  auth: Record<string, string>,
  options: { mac: string; ipOverride?: string; withCredentials?: boolean; password?: string },
) {
  const res = await app.inject({
    method: 'POST',
    url: '/printers',
    headers: auth,
    payload: {
      name: 'HP SWS test',
      mac: options.mac,
      ipOverride: options.ipOverride,
      snmp: { version: 'v2c', community: SNMP_SECRET },
      wbmCredentials:
        options.withCredentials === false
          ? undefined
          : { username: 'admin', password: options.password ?? PANEL_PASSWORD },
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

beforeEach(() => {
  rebootMock.mockClear();
  rebootMock.mockImplementation(async () => undefined);
  vi.mocked(unifiClassicService.isConfigured).mockReturnValue(false);
  vi.mocked(unifiClassicService.getKnownClientsNetworkInfo).mockResolvedValue(new Map());
  vi.mocked(unifiService.listClients).mockResolvedValue({ data: [] } as never);
});

describe('POST /printers/:id/reboot', () => {
  it('caminho feliz: chama rebootHpPrinter com IP resolvido, MAC e credencial, e devolve o alvo real', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:00:00:01', ipOverride: PRINTER_IP });

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, ipAddress: PRINTER_IP, ipOrigin: 'override' });
    expect(rebootMock).toHaveBeenCalledWith(PRINTER_IP, 'aa:bb:cc:00:00:01', {
      username: 'admin',
      password: PANEL_PASSWORD,
    });

    await app.close();
  });

  it('retorna 404 quando o id não existe, sem chamar o serviço', async () => {
    const { app, auth } = await authedApp();

    const res = await app.inject({ method: 'POST', url: '/printers/nao-existe/reboot', headers: auth });

    expect(res.statusCode).toBe(404);
    expect(rebootMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('retorna 409 quando a impressora não tem credencial do painel web cadastrada', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, {
      mac: 'aa:bb:cc:00:00:02',
      ipOverride: PRINTER_IP,
      withCredentials: false,
    });

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });

    // 409, não 5xx: nenhuma chamada de rede foi tentada, é estado do cadastro
    // e retry sem configurar a credencial nunca resolve.
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/credencial/i);
    expect(rebootMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('checa a credencial ANTES de resolver o IP (nem consulta o controller sem credencial)', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:00:00:03', withCredentials: false });

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/credencial/i);
    // Sem credencial não faz sentido gastar chamadas no controller UniFi.
    expect(unifiService.listClients).not.toHaveBeenCalled();
    expect(unifiClassicService.getKnownClientsNetworkInfo).not.toHaveBeenCalled();

    await app.close();
  });

  it('retorna 409 quando a impressora tem credencial mas nenhum IP conhecido', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:00:00:04' });

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/IP/);
    expect(rebootMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('usa o IP AO VIVO da Integration API quando não há ipOverride (ipOrigin=integration)', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:00:00:05' });

    vi.mocked(unifiService.listClients).mockResolvedValue({
      data: [{ macAddress: 'AA:BB:CC:00:00:05', ipAddress: '10.99.99.50', type: 'WIRELESS' }],
    } as never);

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, ipAddress: '10.99.99.50', ipOrigin: 'integration' });
    expect(rebootMock).toHaveBeenCalledWith('10.99.99.50', 'aa:bb:cc:00:00:05', expect.anything());

    await app.close();
  });

  it('marca ipOrigin=classic quando o IP vem do last_ip HISTÓRICO (risco de reiniciar o equipamento errado)', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:00:00:06' });

    vi.mocked(unifiClassicService.isConfigured).mockReturnValue(true);
    vi.mocked(unifiClassicService.getKnownClientsNetworkInfo).mockResolvedValue(
      new Map([['aa:bb:cc:00:00:06', { ipAddress: '10.99.99.85', connectionType: 'WIRELESS' as const }]]),
    );

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });

    expect(res.statusCode).toBe(200);
    // O alvo real da ação fica EXPLÍCITO na resposta: aqui o efeito colateral
    // de acertar o dispositivo errado é reiniciar um equipamento que ninguém
    // pediu.
    expect(res.json()).toEqual({ ok: true, ipAddress: '10.99.99.85', ipOrigin: 'classic' });

    await app.close();
  });

  it('retorna 403 (não 401) quando a SWS recusa a credencial', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:00:00:07', ipOverride: PRINTER_IP });

    rebootMock.mockRejectedValueOnce(new PrinterSwsAuthenticationError(PRINTER_IP, 'admin'));

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });

    // 403 e NÃO 401 de propósito: o cliente do frontend trata 401 como
    // "token expirado", chama /auth/refresh e REEXECUTA a requisição
    // original (ver `request()` em frontend/src/lib/api.ts) — numa rota de
    // reboot isso significaria disparar o comando duas vezes por causa de
    // uma senha de painel errada.
    expect(res.statusCode).toBe(403);

    await app.close();
  });

  it('retorna 504 quando a impressora não responde (timeout/rede)', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:00:00:08', ipOverride: PRINTER_IP });

    rebootMock.mockRejectedValueOnce(new PrinterSwsUnreachableError(PRINTER_IP, 'AbortError'));

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });

    expect(res.statusCode).toBe(504);

    await app.close();
  });

  it('retorna 502 quando o painel responde de forma inutilizável (não-2xx, não é uma SWS)', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:00:00:09', ipOverride: PRINTER_IP });

    rebootMock.mockRejectedValueOnce(new PrinterSwsRequestError(PRINTER_IP, 'status 404', 404));

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });

    expect(res.statusCode).toBe(502);

    await app.close();
  });

  it('propaga erro inesperado para o handler central (500), sem virar sucesso', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:00:00:0a', ipOverride: PRINTER_IP });

    rebootMock.mockRejectedValueOnce(new TypeError('algo totalmente inesperado'));

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });

    expect(res.statusCode).toBe(500);

    await app.close();
  });

  it('retorna 401 sem token, sem chamar o serviço', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:00:00:0b', ipOverride: PRINTER_IP });

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot` });

    expect(res.statusCode).toBe(401);
    expect(rebootMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('está sob o rate limit de ação de cliente (RATE_LIMIT_CLIENT_ACTION_MAX)', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:00:00:0c', ipOverride: PRINTER_IP });

    // Limite = 3 neste arquivo. Uma rota que REINICIA equipamento físico não
    // pode ficar de fora do rate limit: sem ele, um loop acidental no
    // frontend manteria a impressora reiniciando indefinidamente.
    for (let i = 0; i < 3; i += 1) {
      const ok = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });
      expect(ok.statusCode).toBe(200);
    }
    const limited = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });

    expect(limited.statusCode).toBe(429);
    expect(rebootMock).toHaveBeenCalledTimes(3);

    await app.close();
  });
});

describe('credencial do painel web no cadastro (POST/PATCH /printers)', () => {
  it('SEGURANÇA: nem a senha nem o usuário do painel voltam em POST, GET (lista/individual) ou PATCH', async () => {
    const { app, auth } = await authedApp();
    const created = await createPrinter(app, auth, { mac: 'aa:bb:cc:00:01:01', ipOverride: PRINTER_IP });

    // POST (resposta de criação)
    expect(JSON.stringify(created)).not.toContain(PANEL_PASSWORD);
    expect(created).not.toHaveProperty('wbmCredentials');
    // O segredo SNMP segue igualmente fora (regressão da subtarefa 1).
    expect(JSON.stringify(created)).not.toContain(SNMP_SECRET);

    const individual = await app.inject({ method: 'GET', url: `/printers/${created.id}`, headers: auth });
    expect(individual.statusCode).toBe(200);
    expect(individual.body).not.toContain(PANEL_PASSWORD);
    expect(individual.json()).not.toHaveProperty('wbmCredentials');

    const list = await app.inject({ method: 'GET', url: '/printers', headers: auth });
    expect(list.statusCode).toBe(200);
    expect(list.body).not.toContain(PANEL_PASSWORD);
    for (const printer of list.json()) expect(printer).not.toHaveProperty('wbmCredentials');

    const patched = await app.inject({
      method: 'PATCH',
      url: `/printers/${created.id}`,
      headers: auth,
      payload: { wbmCredentials: { username: 'admin', password: 'outra-senha-secreta' } },
    });
    expect(patched.statusCode).toBe(200);
    expect(patched.body).not.toContain('outra-senha-secreta');
    expect(patched.json()).not.toHaveProperty('wbmCredentials');

    await app.close();
  });

  it('SEGURANÇA: a senha do painel não aparece nem nas mensagens de erro da rota de reboot', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:00:01:02', ipOverride: PRINTER_IP });

    // Erro cuja mensagem carrega a senha (cenário de um serviço/lib
    // descuidado): a rota ecoa `error.message` no `details`, então este é o
    // caminho por onde um vazamento chegaria ao cliente. A defesa real está
    // no serviço (redact) — este teste ancora que a rota não inventa uma
    // segunda fonte de vazamento além dele.
    rebootMock.mockRejectedValueOnce(new PrinterSwsAuthenticationError(PRINTER_IP, 'admin'));
    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });

    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(PANEL_PASSWORD);

    await app.close();
  });

  it('PATCH sem o campo MANTÉM a credencial (o reboot continua funcionando depois de renomear)', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:00:01:03', ipOverride: PRINTER_IP });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/printers/${printer.id}`,
      headers: auth,
      payload: { name: 'HP renomeada' },
    });
    expect(patched.statusCode).toBe(200);

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(rebootMock).toHaveBeenCalledWith(PRINTER_IP, 'aa:bb:cc:00:01:03', {
      username: 'admin',
      password: PANEL_PASSWORD,
    });

    await app.close();
  });

  it('PATCH com wbmCredentials: null APAGA a credencial (reboot volta a 409)', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:00:01:04', ipOverride: PRINTER_IP });

    const patched = await app.inject({
      method: 'PATCH',
      url: `/printers/${printer.id}`,
      headers: auth,
      payload: { wbmCredentials: null },
    });
    expect(patched.statusCode).toBe(200);

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });
    expect(res.statusCode).toBe(409);
    expect(rebootMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('PATCH pode CONFIGURAR a credencial numa impressora cadastrada sem ela', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, {
      mac: 'aa:bb:cc:00:01:05',
      ipOverride: PRINTER_IP,
      withCredentials: false,
    });

    const antes = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });
    expect(antes.statusCode).toBe(409);

    const patched = await app.inject({
      method: 'PATCH',
      url: `/printers/${printer.id}`,
      headers: auth,
      payload: { wbmCredentials: { username: 'operador', password: 'nova-senha' } },
    });
    expect(patched.statusCode).toBe(200);

    const depois = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });
    expect(depois.statusCode).toBe(200);
    expect(rebootMock).toHaveBeenCalledWith(PRINTER_IP, 'aa:bb:cc:00:01:05', {
      username: 'operador',
      password: 'nova-senha',
    });

    await app.close();
  });

  it('aceita senha VAZIA (a HP real está com a senha de fábrica em branco)', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, {
      mac: 'aa:bb:cc:00:01:06',
      ipOverride: PRINTER_IP,
      password: '',
    });

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(rebootMock).toHaveBeenCalledWith(PRINTER_IP, 'aa:bb:cc:00:01:06', { username: 'admin', password: '' });

    await app.close();
  });

  it('rejeita 400 quando wbmCredentials vem sem username', async () => {
    const { app, auth } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/printers',
      headers: auth,
      payload: {
        name: 'HP inválida',
        mac: 'aa:bb:cc:00:01:07',
        snmp: { version: 'v2c', community: SNMP_SECRET },
        wbmCredentials: { password: 'só-senha' },
      },
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });
});
