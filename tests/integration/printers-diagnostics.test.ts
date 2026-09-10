import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PrinterSnmpReading } from '../../src/services/printer-snmp.service.js';

// Mesmo padrão de printers-consumables.test.ts: banco real (node:sqlite) num
// arquivo temporário, sem mock do repositório. unifiService/unifiClassicService
// mockados só para GET /printers/:id não fazer chamada de rede de verdade.
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
    }
  },
  ClassicApiNotConfiguredError: class ClassicApiNotConfiguredError extends Error {},
}));

// A ROTA importa `getLastReading` de printer-snmp.service.js — mock na
// camada de serviço (nunca a implementação interna da rota), igual ao resto
// do projeto.
const getLastReadingMock = vi.fn<(printerId: string) => PrinterSnmpReading | undefined>(() => undefined);

// `pageCountValue` (subtarefa 12) é a MESMA função que a rota usa para
// `pageCount` E, desde a subtarefa 19, também para `powerOnCount` — pura
// (não toca rede/banco/timer), então vem do módulo REAL via
// `importOriginal`, nunca reimplementada aqui. Mesmo motivo documentado em
// printers-consumables.test.ts: uma cópia no mock deixaria passar batido um
// sentinela de powerOnCount virando `0` em vez de `null`.
vi.mock('../../src/services/printer-snmp.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/printer-snmp.service.js')>();
  return {
    getLastReading: (printerId: string) => getLastReadingMock(printerId),
    collectAllReadings: vi.fn(async () => undefined),
    pageCountValue: actual.pageCountValue,
  };
});

const tmpDir = mkdtempSync(join(tmpdir(), 'printers-diagnostics-test-'));
process.env.PRINTERS_DB_FILE = join(tmpDir, 'printers.db');

const { buildApp } = await import('../../src/app.js');
const { printersRepository } = await import('../../src/routes/printers.routes.js');

afterAll(() => {
  printersRepository.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token };
}

// Contador (não aleatório) para garantir MAC único por teste desta suíte —
// evitar 409 por colisão entre `createPrinter` chamado várias vezes contra
// o mesmo banco temporário.
let macCounter = 0;

async function createPrinter(
  app: Awaited<ReturnType<typeof buildApp>>,
  auth: Record<string, string>,
  overrides: Record<string, unknown> = {},
) {
  macCounter += 1;
  const suffix = macCounter.toString(16).padStart(2, '0');
  const res = await app.inject({
    method: 'POST',
    url: '/printers',
    headers: auth,
    payload: {
      name: 'Impressora de teste',
      mac: `aa:bb:cc:dd:ff:${suffix}`,
      snmp: { version: 'v2c', community: 'community-de-teste' },
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

// Constrói uma PrinterSnmpReading mínima e válida, sobrescrevendo só o que
// cada teste precisa — mesmo shape que printer-snmp.service.ts produz de
// verdade (subtarefa 5), sem reimplementar a lógica interna dele aqui.
function buildReading(overrides: Partial<PrinterSnmpReading> = {}): PrinterSnmpReading {
  return {
    printerId: 'irrelevante-sobrescrito-por-teste',
    printerName: 'Impressora de teste',
    ipAddress: '172.16.0.89',
    collectedAt: '2026-08-31T12:00:00.000Z',
    sysDescr: 'HP Laser MFP 131 133 135-138; V3.82.01.10 DEC-09-2019; Engine V1.00.11; NIC 31.03.60_0.1; S/N BRBSQ2G13Q',
    deviceDescr: 'HP Laser MFP 131 133 135-138',
    deviceStatus: { status: 'ok', value: 2 },
    deviceStatusLabel: 'running',
    detectedErrorStates: [],
    pageCount: { status: 'ok', value: 59700 },
    powerOnCount: { status: 'ok', value: 24 },
    supplies: [],
    partial: false,
    ...overrides,
  };
}

describe('GET /printers/:id/diagnostics', () => {
  it('retorna 404 para id inexistente', async () => {
    const { app, token } = await authedApp();
    const res = await app.inject({
      method: 'GET',
      url: '/printers/nao-existe/diagnostics',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();
    const res = await app.inject({ method: 'GET', url: '/printers/qualquer-id/diagnostics' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('impressora cadastrada mas nunca coletada: collectedAt/model/systemInfo null, deviceStatus not-measured, activeErrors null, partial false', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    getLastReadingMock.mockReturnValueOnce(undefined);

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/diagnostics`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      printerId: printer.id,
      collectedAt: null,
      model: null,
      systemInfo: null,
      deviceStatus: 'not-measured',
      activeErrors: null,
      partial: false,
      powerOnCount: null,
    });

    await app.close();
  });

  it('leitura completa: expõe model (hrDeviceDescr), systemInfo (sysDescr cru com firmware embutido), deviceStatus e erros ativos', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    getLastReadingMock.mockReturnValueOnce(
      buildReading({
        printerId: printer.id,
        detectedErrorStates: ['lowToner', 'doorOpen'],
      }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/diagnostics`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      printerId: printer.id,
      collectedAt: '2026-08-31T12:00:00.000Z',
      model: 'HP Laser MFP 131 133 135-138',
      systemInfo:
        'HP Laser MFP 131 133 135-138; V3.82.01.10 DEC-09-2019; Engine V1.00.11; NIC 31.03.60_0.1; S/N BRBSQ2G13Q',
      deviceStatus: 'running',
      activeErrors: ['lowToner', 'doorOpen'],
      partial: false,
      powerOnCount: 24,
    });

    await app.close();
  });

  it('sem erro ativo: activeErrors é lista vazia, não null (distinto de OID não suportado)', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    getLastReadingMock.mockReturnValueOnce(buildReading({ printerId: printer.id, detectedErrorStates: [] }));

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/diagnostics`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json().activeErrors).toEqual([]);

    await app.close();
  });

  it('hrPrinterDetectedErrorState não suportado/falhou: activeErrors vira null (distinto de "sem erro")', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    getLastReadingMock.mockReturnValueOnce(
      buildReading({ printerId: printer.id, detectedErrorStates: null, partial: true }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/diagnostics`, headers: auth });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.activeErrors).toBeNull();
    expect(body.partial).toBe(true);

    await app.close();
  });

  // Os 5 rótulos possíveis de deviceStatus quando a leitura do hrDeviceStatus
  // deu certo (SnmpMeasurement.status === 'ok').
  for (const [value, label] of [
    [1, 'unknown'],
    [2, 'running'],
    [3, 'warning'],
    [4, 'testing'],
    [5, 'down'],
  ] as const) {
    it(`hrDeviceStatus = ${value} vira deviceStatus '${label}'`, async () => {
      const { app, token } = await authedApp();
      const auth = { authorization: `Bearer ${token}` };
      const printer = await createPrinter(app, auth);

      getLastReadingMock.mockReturnValueOnce(
        buildReading({
          printerId: printer.id,
          deviceStatus: { status: 'ok', value },
          deviceStatusLabel: label,
        }),
      );

      const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/diagnostics`, headers: auth });

      expect(res.statusCode).toBe(200);
      expect(res.json().deviceStatus).toBe(label);

      await app.close();
    });
  }

  // Qualquer sentinela/erro/OID não suportado no hrDeviceStatus não pode
  // virar um rótulo RFC 2790 "inventado" — cai em 'not-measured'. Cobre os 5
  // status não-'ok' de SnmpMeasurement de uma vez, por mutação.
  for (const deviceStatus of [
    { status: 'other' },
    { status: 'unknown' },
    { status: 'partial' },
    { status: 'unsupported' },
    { status: 'error' },
  ] as const) {
    it(`hrDeviceStatus com SnmpMeasurement.status '${deviceStatus.status}' vira deviceStatus 'not-measured'`, async () => {
      const { app, token } = await authedApp();
      const auth = { authorization: `Bearer ${token}` };
      const printer = await createPrinter(app, auth);

      getLastReadingMock.mockReturnValueOnce(
        buildReading({ printerId: printer.id, deviceStatus, deviceStatusLabel: null }),
      );

      const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/diagnostics`, headers: auth });

      expect(res.statusCode).toBe(200);
      expect(res.json().deviceStatus).toBe('not-measured');

      await app.close();
    });
  }

  // hrDeviceStatus fora de 1..5 (firmware que não segue a RFC 2790): a
  // medida é 'ok' (número de verdade, não sentinela), mas o serviço não tem
  // rótulo pra ele e devolve `deviceStatusLabel: null`. A resposta precisa
  // cair em 'not-measured' — nunca `null`, que quebraria o tipo
  // DiagnosticsDeviceStatus prometido ao frontend.
  it("hrDeviceStatus com valor fora de 1..5 (sem rótulo RFC) vira 'not-measured', nunca null", async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    getLastReadingMock.mockReturnValueOnce(
      buildReading({ printerId: printer.id, deviceStatus: { status: 'ok', value: 9 }, deviceStatusLabel: null }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/diagnostics`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json().deviceStatus).toBe('not-measured');
    expect(res.json().deviceStatus).not.toBeNull();

    await app.close();
  });

  // Rótulo desconhecido vindo do serviço (ex.: DEVICE_STATUS_LABELS ganhar uma
  // 6ª entrada numa evolução futura do poller): a rota só pode devolver um dos
  // rótulos que ela mesma documenta em DiagnosticsDeviceStatus — qualquer outro
  // degrada para 'not-measured' em vez de vazar pro frontend um valor que ele
  // não sabe tratar.
  it("rótulo desconhecido vindo do serviço não vaza na resposta — degrada para 'not-measured'", async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    getLastReadingMock.mockReturnValueOnce(
      buildReading({ printerId: printer.id, deviceStatus: { status: 'ok', value: 6 }, deviceStatusLabel: 'busy' }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/diagnostics`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json().deviceStatus).toBe('not-measured');

    await app.close();
  });

  // Leitura internamente inconsistente (medida não-'ok' MAS com rótulo
  // preenchido): não acontece no serviço de hoje, que zera o rótulo junto —
  // mas é exatamente por isso que a rota checa `deviceStatus.status` antes de
  // olhar o rótulo. Sem este teste, remover essa checagem passaria despercebido
  // (mutação sobrevivente), e uma divergência futura entre as duas fontes viraria
  // um 'running' afirmado em cima de uma medida que a impressora não reportou.
  it("medida não-'ok' com rótulo preenchido ainda vira 'not-measured' (o status manda, não o rótulo)", async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    getLastReadingMock.mockReturnValueOnce(
      buildReading({ printerId: printer.id, deviceStatus: { status: 'unknown' }, deviceStatusLabel: 'running' }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/diagnostics`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json().deviceStatus).toBe('not-measured');

    await app.close();
  });

  // Achado real (docs/printers-snmp-research.md): sysDescr embute a versão
  // de firmware num texto livre e diferente por fabricante (aqui, Brother) —
  // o backend não tenta parsear, só repassa o texto inteiro como systemInfo.
  it('sysDescr da Brother (formato diferente da HP) também é repassado cru, sem parsing', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    getLastReadingMock.mockReturnValueOnce(
      buildReading({
        printerId: printer.id,
        sysDescr: 'Brother NC-9200w, Firmware Ver.1.46 ,MID 8CE-922FID 2',
        deviceDescr: 'Brother DCP-L3560CDW series',
      }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/diagnostics`, headers: auth });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.model).toBe('Brother DCP-L3560CDW series');
    expect(body.systemInfo).toBe('Brother NC-9200w, Firmware Ver.1.46 ,MID 8CE-922FID 2');

    await app.close();
  });

  // sysDescr/deviceDescr também podem falhar individualmente (OID não
  // suportado/erro pontual) sem derrubar o resto da leitura — o serviço já
  // devolve `null` nesse caso (ver readPrinter em printer-snmp.service.ts).
  it('sysDescr/deviceDescr ausentes na leitura viram null, sem quebrar o restante da resposta', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    getLastReadingMock.mockReturnValueOnce(
      buildReading({ printerId: printer.id, sysDescr: null, deviceDescr: null }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/diagnostics`, headers: auth });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.model).toBeNull();
    expect(body.systemInfo).toBeNull();
    expect(body.collectedAt).toBe('2026-08-31T12:00:00.000Z');

    await app.close();
  });

  // Subtarefa 19: prtMarkerPowerOnCount é um SnmpMeasurement como pageCount
  // (subtarefa 5) — sentinela/OID não suportado/erro pontual não podem virar
  // um número inventado.
  it('powerOnCount com sentinela/erro/não suportado vira null, nunca um número inventado', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    for (const powerOnCount of [
      { status: 'unknown' },
      { status: 'other' },
      { status: 'partial' },
      { status: 'unsupported' },
      { status: 'error' },
    ] as const) {
      getLastReadingMock.mockReturnValueOnce(buildReading({ printerId: printer.id, powerOnCount }));

      const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/diagnostics`, headers: auth });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(Object.hasOwn(body, 'powerOnCount')).toBe(true);
      expect(body.powerOnCount).toBeNull();
    }

    await app.close();
  });

  it('powerOnCount com leitura ok expõe o número real de ligamentos', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    getLastReadingMock.mockReturnValueOnce(
      buildReading({ printerId: printer.id, powerOnCount: { status: 'ok', value: 226 } }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/diagnostics`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json().powerOnCount).toBe(226);

    await app.close();
  });

  it('nunca vaza snmpSecret na resposta', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    getLastReadingMock.mockReturnValueOnce(buildReading({ printerId: printer.id }));

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/diagnostics`, headers: auth });

    expect(res.statusCode).toBe(200);
    const body = JSON.stringify(res.json());
    expect(body).not.toContain('community-de-teste');
    expect(body).not.toContain('snmpSecret');

    await app.close();
  });
});
