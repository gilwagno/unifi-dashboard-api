import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PrinterSnmpReading } from '../../src/services/printer-snmp.service.js';

// Mesmo padrão de printers.routes.test.ts/printers-reconnect.test.ts: banco
// real (node:sqlite) num arquivo temporário, sem mock do repositório.
// unifiService/unifiClassicService mockados só para GET /printers/:id não
// fazer chamada de rede de verdade (o merge de status não é o que este
// teste cobre — isso é printers-network-status.test.ts).
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
// do projeto. `collectAllReadings` também é exportado pelo módulo real, mas
// nenhuma rota testada aqui o chama; ainda assim é fornecido para não
// quebrar quem importar o módulo mockado por completude de shape.
const getLastReadingMock = vi.fn<(printerId: string) => PrinterSnmpReading | undefined>(() => undefined);

// `pageCountValue` (subtarefa 12) é a MESMA função que a rota passou a
// importar do serviço em vez de ter uma cópia local. Ela é PURA (não toca
// rede/banco/timer), então vem do módulo REAL via `importOriginal` — nunca
// reimplementada aqui. Reimplementá-la no mock quebraria o teste de
// regressão de `pageCount` com sentinela (ver 'pageCount com sentinela/erro
// vira null...' mais abaixo): ele passaria a validar a cópia do teste, e uma
// mudança real do serviço para (por exemplo) `0` em vez de `null` — que
// afirmaria "esta impressora imprimiu 0 páginas" quando na verdade o
// contador não é legível — sairia daqui verde.
vi.mock('../../src/services/printer-snmp.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/printer-snmp.service.js')>();
  return {
    getLastReading: (printerId: string) => getLastReadingMock(printerId),
    collectAllReadings: vi.fn(async () => undefined),
    pageCountValue: actual.pageCountValue,
  };
});

const tmpDir = mkdtempSync(join(tmpdir(), 'printers-consumables-test-'));
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
      mac: `aa:bb:cc:dd:ee:${suffix}`,
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
    sysDescr: 'sysDescr de teste',
    deviceDescr: 'device de teste',
    deviceStatus: { status: 'ok', value: 2 },
    deviceStatusLabel: 'running',
    detectedErrorStates: [],
    pageCount: { status: 'ok', value: 59700 },
    supplies: [],
    partial: false,
    ...overrides,
  };
}

describe('GET /printers/:id/consumables', () => {
  it('retorna 404 para id inexistente', async () => {
    const { app, token } = await authedApp();
    const res = await app.inject({
      method: 'GET',
      url: '/printers/nao-existe/consumables',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();
    const res = await app.inject({ method: 'GET', url: '/printers/qualquer-id/consumables' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('impressora cadastrada mas nunca coletada: collectedAt null, pageCount null, supplies vazio, sem erro', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    getLastReadingMock.mockReturnValueOnce(undefined);

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      printerId: printer.id,
      collectedAt: null,
      pageCount: null,
      lowThresholdPct: null,
      supplies: [],
    });

    await app.close();
  });

  it('leitura completa: nível normal (ok), abaixo do threshold configurado (low), sentinelas (unknown/partial) e OID não suportado (unsupported)', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth, {
      maintenance: { consumableLowThresholdPct: 20 },
    });

    getLastReadingMock.mockReturnValueOnce(
      buildReading({
        printerId: printer.id,
        pageCount: { status: 'ok', value: 52994 },
        supplies: [
          // Nível confortável (69%), acima do threshold de 20% -> 'ok'.
          {
            index: '1.1',
            description: 'Tambor',
            type: 9,
            typeLabel: 'opc',
            unit: 8,
            unitLabel: 'sheets',
            maxCapacity: { status: 'ok', value: 12000 },
            level: { status: 'ok', value: 8280 },
            levelPercent: 69,
          },
          // Nível abaixo do threshold de 20% -> 'low'.
          {
            index: '1.2',
            description: 'Toner Preto',
            type: 3,
            typeLabel: 'toner',
            unit: 19,
            unitLabel: 'percent',
            maxCapacity: { status: 'ok', value: 100 },
            level: { status: 'ok', value: 10 },
            levelPercent: 10,
          },
          // Sentinela partial(-3) no nível — comportamento real das Brother.
          {
            index: '1.3',
            description: 'Toner Ciano',
            type: 3,
            typeLabel: 'toner',
            unit: 19,
            unitLabel: 'percent',
            maxCapacity: { status: 'unknown' },
            level: { status: 'partial' },
            levelPercent: null,
          },
          // Sentinela unknown(-2) no nível.
          {
            index: '1.4',
            description: 'Toner Magenta',
            type: 3,
            typeLabel: 'toner',
            unit: 19,
            unitLabel: 'percent',
            maxCapacity: { status: 'unknown' },
            level: { status: 'unknown' },
            levelPercent: null,
          },
          // OID não suportado neste modelo -> 'unsupported'.
          {
            index: '1.5',
            description: null,
            type: 15,
            typeLabel: 'fuser',
            unit: null,
            unitLabel: null,
            maxCapacity: { status: 'unsupported' },
            level: { status: 'unsupported' },
            levelPercent: null,
          },
        ],
      }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.printerId).toBe(printer.id);
    expect(body.collectedAt).toBe('2026-08-31T12:00:00.000Z');
    expect(body.pageCount).toBe(52994);
    expect(body.supplies).toEqual([
      { name: 'Tambor', levelPercent: 69, status: 'ok' },
      { name: 'Toner Preto', levelPercent: 10, status: 'low' },
      { name: 'Toner Ciano', levelPercent: null, status: 'partial' },
      { name: 'Toner Magenta', levelPercent: null, status: 'unknown' },
      { name: 'fuser', levelPercent: null, status: 'unsupported' },
    ]);

    await app.close();
  });

  it('sem threshold configurado no registro, nível numericamente baixo nunca vira "low" (fica "ok")', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    // Sem `maintenance` no POST -> consumableLowThresholdPct fica null.
    const printer = await createPrinter(app, auth);

    getLastReadingMock.mockReturnValueOnce(
      buildReading({
        printerId: printer.id,
        supplies: [
          {
            index: '1.1',
            description: 'Toner Preto',
            type: 3,
            typeLabel: 'toner',
            unit: 19,
            unitLabel: 'percent',
            maxCapacity: { status: 'ok', value: 100 },
            level: { status: 'ok', value: 1 }, // 1% — seria "low" com qualquer threshold razoável
            levelPercent: 1,
          },
        ],
      }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json().supplies).toEqual([{ name: 'Toner Preto', levelPercent: 1, status: 'ok' }]);
    // …mas a resposta NÃO esconde que a checagem está desligada: sem este
    // campo, esse 'ok' em 1% seria indistinguível de um toner cheio.
    expect(res.json().lowThresholdPct).toBeNull();

    await app.close();
  });

  it('expõe o threshold em vigor quando configurado (consumidor sabe que a checagem de "low" está ligada)', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth, { maintenance: { consumableLowThresholdPct: 15 } });

    getLastReadingMock.mockReturnValueOnce(buildReading({ printerId: printer.id }));

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json().lowThresholdPct).toBe(15);

    await app.close();
  });

  it('nível exatamente igual ao threshold ainda é "ok" (low é estritamente ABAIXO do limite)', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth, { maintenance: { consumableLowThresholdPct: 20 } });

    getLastReadingMock.mockReturnValueOnce(
      buildReading({
        printerId: printer.id,
        supplies: [
          {
            index: '1.1',
            description: 'Toner Preto',
            type: 3,
            typeLabel: 'toner',
            unit: 19,
            unitLabel: 'percent',
            maxCapacity: { status: 'ok', value: 100 },
            level: { status: 'ok', value: 20 },
            levelPercent: 20,
          },
        ],
      }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json().supplies).toEqual([{ name: 'Toner Preto', levelPercent: 20, status: 'ok' }]);

    await app.close();
  });

  // Os 2 status que faltavam para fechar os 7 possíveis: 'error' (falha
  // pontual de leitura daquele varbind) e o sentinela other(-1), cuja
  // DECISÃO documentada é cair em 'unknown' — não em 'error' nem em
  // 'unsupported'. Sem este teste, trocar esse mapeamento passava batido.
  it('sentinela other(-1) vira "unknown" e falha de leitura do nível vira "error"; nome cai no fallback do índice', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth, { maintenance: { consumableLowThresholdPct: 20 } });

    getLastReadingMock.mockReturnValueOnce(
      buildReading({
        printerId: printer.id,
        supplies: [
          // Sem description E sem typeLabel -> fallback `Suprimento <index>`.
          {
            index: '1.1',
            description: null,
            type: null,
            typeLabel: null,
            unit: null,
            unitLabel: null,
            maxCapacity: { status: 'error' },
            level: { status: 'error' },
            levelPercent: null,
          },
          {
            index: '1.2',
            description: 'Toner Amarelo',
            type: 3,
            typeLabel: 'toner',
            unit: 19,
            unitLabel: 'percent',
            maxCapacity: { status: 'other' },
            level: { status: 'other' },
            levelPercent: null,
          },
        ],
      }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json().supplies).toEqual([
      { name: 'Suprimento 1.1', levelPercent: null, status: 'error' },
      { name: 'Toner Amarelo', levelPercent: null, status: 'unknown' },
    ]);

    await app.close();
  });

  // `pageCount` é um SnmpMeasurement como os suprimentos (subtarefa 5), não
  // um número cru: o contador de páginas também pode voltar com sentinela ou
  // erro. O risco aqui é a rota devolver `undefined`/NaN (campo some do
  // JSON) ou o frontend confundir com "nunca coletada".
  it('pageCount com sentinela/erro vira null sem virar NaN, e segue distinguível de "nunca coletada" pelo collectedAt', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    for (const pageCount of [
      { status: 'unknown' },
      { status: 'other' },
      { status: 'partial' },
      { status: 'unsupported' },
      { status: 'error' },
    ] as const) {
      getLastReadingMock.mockReturnValueOnce(buildReading({ printerId: printer.id, pageCount }));

      const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      // Presente e explicitamente null — não ausente do JSON, não NaN.
      expect(Object.hasOwn(body, 'pageCount')).toBe(true);
      expect(body.pageCount).toBeNull();
      // A leitura ACONTECEU: collectedAt preenchido separa este caso do
      // "nunca coletada" (que é collectedAt null).
      expect(body.collectedAt).toBe('2026-08-31T12:00:00.000Z');
    }

    await app.close();
  });

  it('nível ok porém levelPercent não calculável (bug de firmware / unidade incompatível) vira "not-measured"', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth, { maintenance: { consumableLowThresholdPct: 20 } });

    getLastReadingMock.mockReturnValueOnce(
      buildReading({
        printerId: printer.id,
        supplies: [
          {
            index: '1.1',
            description: 'Transfer Roller',
            type: 1,
            typeLabel: 'other',
            unit: 19,
            unitLabel: 'percent',
            // Achado real da HP: level > maxCapacity -> levelPercent null mesmo com level.status 'ok'.
            maxCapacity: { status: 'ok', value: 100 },
            level: { status: 'ok', value: 143066 },
            levelPercent: null,
          },
        ],
      }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json().supplies).toEqual([{ name: 'Transfer Roller', levelPercent: null, status: 'not-measured' }]);

    await app.close();
  });
});
