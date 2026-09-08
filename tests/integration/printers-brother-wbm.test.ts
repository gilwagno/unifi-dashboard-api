import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mesmo padrão de printers-reconnect.test.ts: banco real (node:sqlite) num
// arquivo temporário, sem mock do repositório. unifiService/
// unifiClassicService mockados só para o merge de status de rede (usado por
// resolvePrinterIp quando a impressora não tem ipOverride) não fazer
// chamada de rede de verdade.
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

// Mock na camada de SERVIÇO (printer-brother-wbm.service.ts), não na
// implementação interna da rota — mesmo padrão do resto do projeto
// (printers-consumables.test.ts mocka printer-snmp.service.ts do mesmo
// jeito). As classes de erro precisam ser as MESMAS instâncias usadas pela
// rota (via `instanceof`), então vêm do módulo real por `importOriginal`.
const setSleepTimeMock = vi.fn<(ip: string, minutes: number) => Promise<void>>(async () => undefined);
const setAutoPowerOffMock = vi.fn<(ip: string, index: number) => Promise<void>>(async () => undefined);

vi.mock('../../src/services/printer-brother-wbm.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/printer-brother-wbm.service.js')>();
  return {
    setSleepTime: (ip: string, minutes: number) => setSleepTimeMock(ip, minutes),
    setAutoPowerOff: (ip: string, index: number) => setAutoPowerOffMock(ip, index),
    PrinterUnreachableError: actual.PrinterUnreachableError,
    PrinterWbmRequestError: actual.PrinterWbmRequestError,
    AUTO_POWER_OFF_HOURS_TO_INDEX: actual.AUTO_POWER_OFF_HOURS_TO_INDEX,
  };
});

const tmpDir = mkdtempSync(join(tmpdir(), 'printers-brother-wbm-test-'));
process.env.PRINTERS_DB_FILE = join(tmpDir, 'printers.db');

const { buildApp } = await import('../../src/app.js');
const { printersRepository } = await import('../../src/routes/printers.routes.js');
const { PrinterUnreachableError, PrinterWbmRequestError } = await import(
  '../../src/services/printer-brother-wbm.service.js'
);
// Handles dos mocks da API clássica/Integration, para exercitar a ORIGEM do
// IP de destino da escrita (override vs integration vs classic histórico).
const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
const { unifiService } = await import('../../src/services/unifi.service.js');

afterAll(() => {
  printersRepository.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token };
}

async function createPrinter(
  auth: Record<string, string>,
  app: Awaited<ReturnType<typeof buildApp>>,
  mac: string,
  ipOverride?: string,
) {
  const res = await app.inject({
    method: 'POST',
    url: '/printers',
    headers: auth,
    payload: {
      name: 'Brother WBM test',
      mac,
      ipOverride,
      snmp: { version: 'v2c', community: 'segredo-qualquer' },
    },
  });
  return res.json();
}

beforeEach(() => {
  setSleepTimeMock.mockClear();
  setAutoPowerOffMock.mockClear();
  setSleepTimeMock.mockImplementation(async () => undefined);
  setAutoPowerOffMock.mockImplementation(async () => undefined);
  vi.mocked(unifiClassicService.isConfigured).mockReturnValue(false);
  vi.mocked(unifiClassicService.getKnownClientsNetworkInfo).mockResolvedValue(new Map());
  vi.mocked(unifiService.listClients).mockResolvedValue({ data: [] } as never);
});

describe('POST /printers/:id/sleep-time', () => {
  it('caminho feliz: chama setSleepTime com o IP resolvido (ipOverride) e o valor de minutes, retorna 200 { ok: true }', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'aa:11:22:33:44:01', '172.16.0.222');

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/sleep-time`,
      headers: auth,
      payload: { minutes: 15 },
    });

    expect(res.statusCode).toBe(200);
    // A resposta devolve o ALVO real da escrita (achado do crítico): sem
    // isso, uma escrita feita num IP histórico da API clássica é
    // indistinguível de uma feita no ipOverride declarado.
    expect(res.json()).toEqual({ ok: true, ipAddress: '172.16.0.222', ipOrigin: 'override' });
    expect(setSleepTimeMock).toHaveBeenCalledWith('172.16.0.222', 15);

    await app.close();
  });

  it('aceita o limite exato de minutes (99) e rejeita 100 — o teto existe de verdade', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'aa:11:22:33:44:11', '172.16.0.222');

    const ok = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/sleep-time`,
      headers: auth,
      payload: { minutes: 99 },
    });
    expect(ok.statusCode).toBe(200);
    expect(setSleepTimeMock).toHaveBeenLastCalledWith('172.16.0.222', 99);

    const tooBig = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/sleep-time`,
      headers: auth,
      payload: { minutes: 100 },
    });
    expect(tooBig.statusCode).toBe(400);
    expect(setSleepTimeMock).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('rejeita minutes fracionário (15.5) — o campo B16 da WBM é inteiro em minutos', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'aa:11:22:33:44:12', '172.16.0.222');

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/sleep-time`,
      headers: auth,
      payload: { minutes: 15.5 },
    });

    expect(res.statusCode).toBe(400);
    expect(setSleepTimeMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('usa o IP AO VIVO da Integration API quando não há ipOverride, marcando ipOrigin=integration', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'aa:11:22:33:44:13');

    vi.mocked(unifiService.listClients).mockResolvedValue({
      data: [{ macAddress: 'AA:11:22:33:44:13', ipAddress: '172.16.0.99', type: 'WIRELESS' }],
    } as never);

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/sleep-time`,
      headers: auth,
      payload: { minutes: 15 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, ipAddress: '172.16.0.99', ipOrigin: 'integration' });
    expect(setSleepTimeMock).toHaveBeenCalledWith('172.16.0.99', 15);

    await app.close();
  });

  it('marca ipOrigin=classic quando o IP vem do last_ip HISTÓRICO da API clássica (risco de escrever na impressora errada)', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'aa:11:22:33:44:14');

    vi.mocked(unifiClassicService.isConfigured).mockReturnValue(true);
    vi.mocked(unifiClassicService.getKnownClientsNetworkInfo).mockResolvedValue(
      new Map([['aa:11:22:33:44:14', { ipAddress: '172.16.0.85', connectionType: 'WIRELESS' as const }]]),
    );

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/sleep-time`,
      headers: auth,
      payload: { minutes: 15 },
    });

    expect(res.statusCode).toBe(200);
    // O alvo da escrita fica EXPLÍCITO na resposta justamente porque este é
    // o caso perigoso: last_ip é histórico (ver unifi-classic.service.ts).
    expect(res.json()).toEqual({ ok: true, ipAddress: '172.16.0.85', ipOrigin: 'classic' });
    expect(setSleepTimeMock).toHaveBeenCalledWith('172.16.0.85', 15);

    await app.close();
  });

  it('propaga erro inesperado do serviço para o handler central (500), sem virar sucesso', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'aa:11:22:33:44:15', '172.16.0.222');

    setSleepTimeMock.mockRejectedValueOnce(new TypeError('algo totalmente inesperado'));

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/sleep-time`,
      headers: auth,
      payload: { minutes: 15 },
    });

    expect(res.statusCode).toBe(500);

    await app.close();
  });

  it('retorna 404 quando o id da impressora não existe', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };

    const res = await app.inject({
      method: 'POST',
      url: '/printers/nao-existe/sleep-time',
      headers: auth,
      payload: { minutes: 15 },
    });

    expect(res.statusCode).toBe(404);
    expect(setSleepTimeMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('retorna 400 quando minutes é inválido (0), sem chamar o serviço', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'aa:11:22:33:44:02', '172.16.0.222');

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/sleep-time`,
      headers: auth,
      payload: { minutes: 0 },
    });

    expect(res.statusCode).toBe(400);
    expect(setSleepTimeMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('retorna 400 quando minutes não é inteiro positivo (negativo)', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'aa:11:22:33:44:03', '172.16.0.222');

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/sleep-time`,
      headers: auth,
      payload: { minutes: -5 },
    });

    expect(res.statusCode).toBe(400);
    expect(setSleepTimeMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('retorna 409 quando a impressora não tem IP conhecido (sem ipOverride e não encontrada pelo controller)', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'aa:11:22:33:44:04');

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/sleep-time`,
      headers: auth,
      payload: { minutes: 15 },
    });

    // 409, não 5xx: nenhuma chamada de rede foi tentada — é estado do
    // cadastro (falta ipOverride / impressora nunca vista), e retry sem
    // mudar nada nunca resolve. Ver a DECISÃO em printers.routes.ts.
    expect(res.statusCode).toBe(409);
    expect(setSleepTimeMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('retorna 504 quando o serviço lança PrinterUnreachableError (timeout/rede)', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'aa:11:22:33:44:05', '172.16.0.222');

    setSleepTimeMock.mockRejectedValueOnce(new PrinterUnreachableError('172.16.0.222', new Error('timeout')));

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/sleep-time`,
      headers: auth,
      payload: { minutes: 15 },
    });

    expect(res.statusCode).toBe(504);

    await app.close();
  });

  it('retorna 502 quando o serviço lança PrinterWbmRequestError (status não-2xx da WBM)', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'aa:11:22:33:44:06', '172.16.0.222');

    setSleepTimeMock.mockRejectedValueOnce(new PrinterWbmRequestError('172.16.0.222', 500));

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/sleep-time`,
      headers: auth,
      payload: { minutes: 15 },
    });

    expect(res.statusCode).toBe(502);

    await app.close();
  });

  it('SEGURANÇA: a resposta nunca contém o segredo SNMP da impressora', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'aa:11:22:33:44:07', '172.16.0.222');

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/sleep-time`,
      headers: auth,
      payload: { minutes: 15 },
    });

    expect(JSON.stringify(res.json())).not.toContain('segredo-qualquer');

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'aa:11:22:33:44:08', '172.16.0.222');

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/sleep-time`,
      payload: { minutes: 15 },
    });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});

describe('POST /printers/:id/auto-power-off', () => {
  it('caminho feliz: traduz hours para o índice ordinal certo e chama setAutoPowerOff, retorna 200 { ok: true }', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'bb:11:22:33:44:01', '172.16.0.222');

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/auto-power-off`,
      headers: auth,
      payload: { hours: 8 },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, ipAddress: '172.16.0.222', ipOrigin: 'override' });
    // hours: 8 -> índice 4 (ver AUTO_POWER_OFF_HOURS_TO_INDEX) — NÃO é 8.
    expect(setAutoPowerOffMock).toHaveBeenCalledWith('172.16.0.222', 4);

    await app.close();
  });

  // ACHADO DO CRÍTICO: os testes de rota só cobriam hours 8 e 0. O par
  // MAIS perigoso do mapeamento é justamente 4 -> 3 e 2 -> 2 (a partir de
  // "2 hours" o índice descola da hora), e nenhum teste de ROTA ancorava
  // isso — só o toEqual da tabela no teste de unidade, que não pega um
  // erro na tradução feita DENTRO da rota.
  it.each([
    [1, 1],
    [2, 2],
    [4, 3],
  ])('traduz hours: %i para o índice %i do select B204', async (hours, expectedIndex) => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, `bb:11:22:33:55:0${hours}`, '172.16.0.222');

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/auto-power-off`,
      headers: auth,
      payload: { hours },
    });

    expect(res.statusCode).toBe(200);
    expect(setAutoPowerOffMock).toHaveBeenCalledWith('172.16.0.222', expectedIndex);

    await app.close();
  });

  it('traduz hours: 0 para índice 0 ("Off")', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'bb:11:22:33:44:02', '172.16.0.222');

    await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/auto-power-off`,
      headers: auth,
      payload: { hours: 0 },
    });

    expect(setAutoPowerOffMock).toHaveBeenCalledWith('172.16.0.222', 0);

    await app.close();
  });

  it('retorna 404 quando o id da impressora não existe', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };

    const res = await app.inject({
      method: 'POST',
      url: '/printers/nao-existe/auto-power-off',
      headers: auth,
      payload: { hours: 1 },
    });

    expect(res.statusCode).toBe(404);
    expect(setAutoPowerOffMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('retorna 400 quando hours está fora do enum permitido (ex.: 3), sem chamar o serviço', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'bb:11:22:33:44:03', '172.16.0.222');

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/auto-power-off`,
      headers: auth,
      payload: { hours: 3 },
    });

    expect(res.statusCode).toBe(400);
    expect(setAutoPowerOffMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('retorna 409 quando a impressora não tem IP conhecido', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'bb:11:22:33:44:04');

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/auto-power-off`,
      headers: auth,
      payload: { hours: 1 },
    });

    expect(res.statusCode).toBe(409);
    expect(setAutoPowerOffMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('retorna 504 quando o serviço lança PrinterUnreachableError', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'bb:11:22:33:44:05', '172.16.0.222');

    setAutoPowerOffMock.mockRejectedValueOnce(new PrinterUnreachableError('172.16.0.222', new Error('timeout')));

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/auto-power-off`,
      headers: auth,
      payload: { hours: 1 },
    });

    expect(res.statusCode).toBe(504);

    await app.close();
  });

  it('retorna 502 quando o serviço lança PrinterWbmRequestError', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'bb:11:22:33:44:06', '172.16.0.222');

    setAutoPowerOffMock.mockRejectedValueOnce(new PrinterWbmRequestError('172.16.0.222', 400));

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/auto-power-off`,
      headers: auth,
      payload: { hours: 1 },
    });

    expect(res.statusCode).toBe(502);

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'bb:11:22:33:44:07', '172.16.0.222');

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/auto-power-off`,
      payload: { hours: 1 },
    });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});
