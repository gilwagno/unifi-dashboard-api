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
// `supplyDisplayName` (subtarefa 19) é a MESMA função que o histórico SNMP
// passou a usar — pura como pageCountValue, então também vem do módulo REAL
// via importOriginal, pelo mesmo motivo já documentado acima para
// pageCountValue: reimplementá-la aqui deixaria de travar uma divergência
// real entre o que a rota faz e o que esta função realmente calcula (ex.:
// o strip do "S/N:..." do nome de exibição).
vi.mock('../../src/services/printer-snmp.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/printer-snmp.service.js')>();
  return {
    getLastReading: (printerId: string) => getLastReadingMock(printerId),
    collectAllReadings: vi.fn(async () => undefined),
    pageCountValue: actual.pageCountValue,
    supplyDisplayName: actual.supplyDisplayName,
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
    powerOnCount: { status: 'ok', value: 24 },
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
      // 'none' = nem memória, nem disco. É o ÚNICO caso em que "nunca
      // coletado" é uma afirmação verdadeira (ver `source` no contrato).
      source: 'none',
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
            serialNumber: null,
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
            serialNumber: null,
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
            serialNumber: null,
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
            serialNumber: null,
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
            serialNumber: null,
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
      { name: 'Tambor', serialNumber: null, levelPercent: 69, status: 'ok' },
      { name: 'Toner Preto', serialNumber: null, levelPercent: 10, status: 'low' },
      { name: 'Toner Ciano', serialNumber: null, levelPercent: null, status: 'partial' },
      { name: 'Toner Magenta', serialNumber: null, levelPercent: null, status: 'unknown' },
      { name: 'fuser', serialNumber: null, levelPercent: null, status: 'unsupported' },
    ]);

    await app.close();
  });

  // Subtarefa 19: as 2 HPs reais embutem o número de série do cartucho na
  // própria description ("Black Toner S/N:CRUM-210729A5BB3"), achado
  // confirmado por SNMP GET real contra elas. Antes desta subtarefa, esse
  // texto ia inteiro para `name`; agora sai como campo próprio, e `name`
  // fica só com o texto antes do "S/N:".
  it('extrai o número de série embutido em description (padrão real das 2 HPs) para um campo próprio, sem deixá-lo no name', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    getLastReadingMock.mockReturnValueOnce(
      buildReading({
        printerId: printer.id,
        supplies: [
          {
            index: '1.1',
            description: 'Black Toner S/N:CRUM-210729A5BB3',
            serialNumber: 'CRUM-210729A5BB3',
            type: 3,
            typeLabel: 'toner',
            unit: 19,
            unitLabel: 'percent',
            maxCapacity: { status: 'ok', value: 100 },
            level: { status: 'ok', value: 55 },
            levelPercent: 55,
          },
        ],
      }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json().supplies).toEqual([
      { name: 'Black Toner', serialNumber: 'CRUM-210729A5BB3', levelPercent: 55, status: 'ok' },
    ]);

    await app.close();
  });

  // As 3 Brother reais não embutem serial na description — precisa
  // continuar funcionando exatamente como antes desta subtarefa (name
  // intacto, serialNumber null), não é ausência de coleta.
  it('description sem "S/N:" (padrão real das 3 Brother): serialNumber null, name inalterado', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    getLastReadingMock.mockReturnValueOnce(
      buildReading({
        printerId: printer.id,
        supplies: [
          {
            index: '1.1',
            description: 'Black Toner Cartridge',
            serialNumber: null,
            type: 3,
            typeLabel: 'toner',
            unit: 13,
            unitLabel: 'tenthsOfGrams',
            maxCapacity: { status: 'unknown' },
            level: { status: 'partial' },
            levelPercent: null,
          },
        ],
      }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json().supplies).toEqual([
      { name: 'Black Toner Cartridge', serialNumber: null, levelPercent: null, status: 'partial' },
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
            serialNumber: null,
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
    expect(res.json().supplies).toEqual([
      { name: 'Toner Preto', serialNumber: null, levelPercent: 1, status: 'ok' },
    ]);
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
            serialNumber: null,
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
    expect(res.json().supplies).toEqual([
      { name: 'Toner Preto', serialNumber: null, levelPercent: 20, status: 'ok' },
    ]);

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
            serialNumber: null,
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
            serialNumber: null,
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
      { name: 'Suprimento 1.1', serialNumber: null, levelPercent: null, status: 'error' },
      { name: 'Toner Amarelo', serialNumber: null, levelPercent: null, status: 'unknown' },
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
            serialNumber: null,
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
    expect(res.json().supplies).toEqual([
      { name: 'Transfer Roller', serialNumber: null, levelPercent: null, status: 'not-measured' },
    ]);

    await app.close();
  });

  // Achado da revisão crítica da PR do toner: a substituição pela MIB privada
  // do fabricante (`levelSource: 'vendor-private'`) tinha teste do lado do
  // POLLER, mas NENHUM do lado da rota — apagar o ramo inteiro de
  // `resolveSupplyStatus` deixava a suíte 563/563 verde (mutante executado e
  // sobrevivente). É justamente o ramo que existe para impedir o sintoma que
  // originou a PR: o medidor mostrando "100%" e o selo, na MESMA tela,
  // dizendo "Desconhecido"/"Sem medição" — porque o percentual vem do valor
  // do fabricante e o status vinha do sentinela da MIB padrão.
  describe('status derivado da MIB privada quando ela substituiu o nível padrão', () => {
    function vendorSupply(overrides: Record<string, unknown> = {}) {
      return {
        index: '1.1',
        description: 'Black Toner',
        serialNumber: 'CRUM-210729A5BB3',
        type: 3,
        typeLabel: 'toner',
        unit: 19,
        unitLabel: 'percent',
        maxCapacity: { status: 'ok', value: 100 },
        // Sentinela na MIB PADRÃO: sozinho, mandaria o selo para 'unknown'.
        level: { status: 'unknown' },
        levelPercent: 100,
        levelSource: 'vendor-private',
        ...overrides,
      };
    }

    it.each([
      ['sentinela unknown na MIB padrão', { level: { status: 'unknown' } }],
      ['sentinela partial na MIB padrão', { level: { status: 'partial' } }],
      ['erro de leitura na MIB padrão', { level: { status: 'error' } }],
      ['OID padrão inexistente', { level: { status: 'unsupported' } }],
    ])('%s não contamina o selo: 100%% no medidor tem que ser "ok" no selo', async (_label, over) => {
      const { app, token } = await authedApp();
      const auth = { authorization: `Bearer ${token}` };
      const printer = await createPrinter(app, auth, { maintenance: { consumableLowThresholdPct: 20 } });

      getLastReadingMock.mockReturnValueOnce(
        buildReading({ printerId: printer.id, supplies: [vendorSupply(over)] as never }),
      );

      const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth });

      expect(res.statusCode).toBe(200);
      expect(res.json().supplies).toEqual([
        { name: 'Black Toner', serialNumber: 'CRUM-210729A5BB3', levelPercent: 100, status: 'ok' },
      ]);

      await app.close();
    });

    it('o threshold continua valendo em cima do valor do fabricante (5% com limite 20 é "low")', async () => {
      const { app, token } = await authedApp();
      const auth = { authorization: `Bearer ${token}` };
      const printer = await createPrinter(app, auth, { maintenance: { consumableLowThresholdPct: 20 } });

      getLastReadingMock.mockReturnValueOnce(
        buildReading({
          printerId: printer.id,
          supplies: [vendorSupply({ levelPercent: 5, level: { status: 'ok', value: 0 } })] as never,
        }),
      );

      const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth });

      expect(res.json().supplies[0].status).toBe('low');

      await app.close();
    });

    // O contrapeso: sem substituição, o sentinela da MIB padrão TEM que
    // continuar mandando. Sem este caso, trocar a condição por um `true`
    // constante também passaria.
    it('sem substituição (levelSource standard) o sentinela padrão continua mandando no selo', async () => {
      const { app, token } = await authedApp();
      const auth = { authorization: `Bearer ${token}` };
      const printer = await createPrinter(app, auth, { maintenance: { consumableLowThresholdPct: 20 } });

      getLastReadingMock.mockReturnValueOnce(
        buildReading({
          printerId: printer.id,
          supplies: [vendorSupply({ levelSource: 'standard', level: { status: 'unknown' } })] as never,
        }),
      );

      const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth });

      expect(res.json().supplies[0].status).toBe('unknown');

      await app.close();
    });
  });
});

// ---------------------------------------------------------------------------
// FALLBACK PARA O HISTÓRICO PERSISTIDO (bug de produção, 2026-09-11)
// ---------------------------------------------------------------------------
// `lastReadings` é memória de processo: nasce vazio a cada restart. Antes
// desta correção a rota respondia `collectedAt: null, supplies: []` nesse
// estado — e a tela dizia "nunca coletado" para uma impressora com 66
// leituras no disco, a mais recente de 16 minutos antes. Observado ao vivo,
// não hipótese.
describe('GET /printers/:id/consumables — fallback para o histórico persistido', () => {
  it('buffer vazio + histórico no disco: responde com a última leitura persistida e marca source=history', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth, { maintenance: { consumableLowThresholdPct: 15 } });

    printersRepository.recordSnmpHistoryEntry(printer.id, {
      collectedAt: '2026-09-11T11:54:06.370Z',
      pageCount: 4821,
      partial: false,
      supplies: [
        { name: 'Black Toner', levelPercent: 8 },
        { name: 'Cyan Toner', levelPercent: 92 },
      ],
    });

    getLastReadingMock.mockReturnValueOnce(undefined);

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.source).toBe('history');
    // O dado APARECE — este é o coração da correção.
    expect(body.collectedAt).toBe('2026-09-11T11:54:06.370Z');
    expect(body.pageCount).toBe(4821);
    expect(body.supplies).toHaveLength(2);
    // O status é derivado com o MESMO threshold do caminho ao vivo: um toner
    // abaixo do limite continua alertando (é o que alimenta o painel
    // "precisa de atenção" da frota).
    expect(body.supplies[0]).toEqual({
      name: 'Black Toner',
      serialNumber: null,
      levelPercent: 8,
      status: 'low',
    });
    expect(body.supplies[1].status).toBe('ok');
  });

  it('pega a leitura MAIS RECENTE do histórico, não a primeira inserida', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    printersRepository.recordSnmpHistoryEntry(printer.id, {
      collectedAt: '2026-09-10T08:00:00.000Z',
      pageCount: 10,
      partial: false,
      supplies: [{ name: 'Black Toner', levelPercent: 90 }],
    });
    printersRepository.recordSnmpHistoryEntry(printer.id, {
      collectedAt: '2026-09-11T08:00:00.000Z',
      pageCount: 99,
      partial: false,
      supplies: [{ name: 'Black Toner', levelPercent: 20 }],
    });

    getLastReadingMock.mockReturnValueOnce(undefined);

    const body = (
      await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth })
    ).json();
    expect(body.collectedAt).toBe('2026-09-11T08:00:00.000Z');
    expect(body.pageCount).toBe(99);
    expect(body.supplies[0].levelPercent).toBe(20);
  });

  it('o histórico NÃO é consultado quando o buffer em memória tem leitura (caminho quente intacto)', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    printersRepository.recordSnmpHistoryEntry(printer.id, {
      collectedAt: '2026-01-01T00:00:00.000Z',
      pageCount: 1,
      partial: false,
      supplies: [{ name: 'Toner Velho', levelPercent: 1 }],
    });

    getLastReadingMock.mockReturnValueOnce({
      printerId: printer.id,
      collectedAt: '2026-09-11T12:00:00.000Z',
      pageCount: { kind: 'value', value: 500 },
      supplies: [
        {
          index: 1,
          description: 'Black Toner',
          typeLabel: 'toner',
          serialNumber: 'CRUM-VIVO',
          level: { kind: 'value', value: 70 },
          maxCapacity: { kind: 'value', value: 100 },
          levelPercent: 70,
          levelSource: 'standard',
        },
      ],
      partial: false,
    } as unknown as PrinterSnmpReading);

    const body = (
      await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth })
    ).json();
    // Se o fallback tivesse precedência, veríamos o dado de janeiro.
    expect(body.source).toBe('live');
    expect(body.collectedAt).toBe('2026-09-11T12:00:00.000Z');
    expect(body.supplies[0].serialNumber).toBe('CRUM-VIVO');
  });

  it('nível nulo no histórico vira status unknown, nunca um percentual inventado', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth, { maintenance: { consumableLowThresholdPct: 15 } });

    printersRepository.recordSnmpHistoryEntry(printer.id, {
      collectedAt: '2026-09-11T11:00:00.000Z',
      pageCount: null,
      partial: true,
      supplies: [{ name: 'Fuser Life', levelPercent: null }],
    });

    getLastReadingMock.mockReturnValueOnce(undefined);

    const body = (
      await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth })
    ).json();
    expect(body.supplies[0]).toEqual({
      name: 'Fuser Life',
      serialNumber: null,
      levelPercent: null,
      status: 'unknown',
    });
    // pageCount ausente continua null com collectedAt preenchido —
    // "coletei, mas o contador não era legível" segue distinguível.
    expect(body.pageCount).toBeNull();
    expect(body.collectedAt).toBe('2026-09-11T11:00:00.000Z');
  });
});

// ---------------------------------------------------------------------------
// REVISÃO CRÍTICA (verificador, 2026-09-11) — lacunas confirmadas por MUTAÇÃO
// EXECUTADA sobre o código desta PR, não por leitura.
// ---------------------------------------------------------------------------
describe('GET /printers/:id/consumables — fallback: proteções que faltavam', () => {
  // MUTANTE QUE SOBREVIVEU antes deste teste:
  //   `const persisted = reading ? null : printersRepository.getLatestSnmpHistory(id)`
  //   -> `const persisted = printersRepository.getLatestSnmpHistory(id)`
  // Suíte inteira (661/661) continuava VERDE. O teste vizinho que se chama
  // "o histórico NÃO é consultado quando o buffer tem leitura (caminho quente
  // intacto)" só afirmava `source === 'live'`, e `source` é decidido por
  // `if (!reading)` — ou seja, ele passa igual com a guarda deletada. O NOME
  // do teste prometia a garantia; o CORPO não verificava nada dela.
  //
  // Consequência real: a PR afirma no código ("Só toca o disco quando a
  // memória não tem nada — o caminho quente continua sem nenhuma consulta ao
  // SQLite") uma propriedade do caminho quente desta rota, que o frontend
  // chama para TODA impressora a cada ciclo de polling de 60s. Sem esta
  // asserção, alguém remove a guarda num refactor e passa a fazer uma query
  // SQLite por impressora por ciclo, para sempre, sem um teste vermelho.
  it('não faz NENHUMA consulta ao histórico em disco quando o buffer em memória tem leitura', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    getLastReadingMock.mockReturnValueOnce({
      printerId: printer.id,
      collectedAt: '2026-09-11T12:00:00.000Z',
      pageCount: { kind: 'value', value: 500 },
      supplies: [],
      partial: false,
    } as unknown as PrinterSnmpReading);

    const spy = vi.spyOn(printersRepository, 'getLatestSnmpHistory');
    try {
      const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth });
      expect(res.statusCode).toBe(200);
      expect(res.json().source).toBe('live');
      // A garantia de verdade: o disco não foi tocado nenhuma vez.
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // O contrário do anterior: prova que a chamada acontece (uma vez só) quando
  // a memória está vazia. Sem este par, "não chamou" também passaria verde
  // numa implementação que nunca chama o fallback em situação nenhuma.
  it('consulta o histórico em disco exatamente uma vez quando o buffer está vazio', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    getLastReadingMock.mockReturnValueOnce(undefined);

    const spy = vi.spyOn(printersRepository, 'getLatestSnmpHistory');
    try {
      await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth });
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith(printer.id);
    } finally {
      spy.mockRestore();
    }
  });

  // DIVERGÊNCIA SEMÂNTICA REAL entre o caminho ao vivo e o degradado, para o
  // MESMO suprimento físico. `printer_snmp_history` persiste só
  // `{name, levelPercent}` (ver RecordSnmpHistoryInput) — o
  // `SnmpMeasurement.status` do nível é DESCARTADO na escrita. Então:
  //
  //   ao vivo  : level.status === 'ok' + levelPercent === null -> 'not-measured'
  //              ("Sem medição / Valor lido, mas não foi possível calcular um
  //               percentual confiável" — SUPPLY_STATUS_INFO no frontend)
  //   histórico: levelPercent === null                          -> 'unknown'
  //              ("Desconhecido / O valor não pôde ser determinado via SNMP
  //               NESTE MODELO")
  //
  // Não é hipótese: é exatamente o caso das 2 HPs reais deste projeto, cujos
  // Transfer Roller / Fuser Life / Pick-up Roller reportam level=143065 com
  // maxCapacity=100 PERMANENTEMENTE (bug de firmware, CLAUDE.md subtarefa
  // 19(b)) — o teste 'nível ok porém levelPercent não calculável ... vira
  // "not-measured"' acima usa esse mesmo "Transfer Roller". Depois de todo
  // restart, esses 3 suprimentos trocam de rótulo na tela, e o rótulo novo
  // afirma uma limitação DO MODELO que não existe (o valor foi lido; o que
  // não dá pra calcular é o percentual). Numa PR cujo motivo de existir é
  // parar de afirmar coisa falsa na tela, é a mesma classe de defeito um
  // nível abaixo.
  //
  // A informação foi destruída na ESCRITA do histórico, então não dá pra
  // recuperar sem migrar o schema — fora do escopo de um hotfix. Fica
  // TRAVADO aqui: o comportamento é conhecido e deliberado, e qualquer
  // mudança (nos dois lados) quebra este teste em vez de passar despercebida.
  it('LIMITAÇÃO CONHECIDA: o mesmo suprimento sem percentual sai "not-measured" ao vivo e "unknown" pelo histórico', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    // Caminho ao vivo: a HP real, com o bug de firmware level > maxCapacity.
    getLastReadingMock.mockReturnValueOnce({
      printerId: printer.id,
      collectedAt: '2026-09-11T12:00:00.000Z',
      pageCount: { kind: 'value', value: 10 },
      supplies: [
        {
          index: 1,
          description: 'Transfer Roller',
          typeLabel: 'other',
          serialNumber: null,
          level: { kind: 'value', value: 143065 },
          maxCapacity: { kind: 'value', value: 100 },
          levelPercent: null,
          levelSource: 'standard',
        },
      ],
      partial: false,
    } as unknown as PrinterSnmpReading);

    const live = (
      await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth })
    ).json();
    expect(live.source).toBe('live');
    expect(live.supplies[0].status).toBe('not-measured');

    // Mesmo suprimento, mesma impressora, vindo do disco depois de um restart.
    printersRepository.recordSnmpHistoryEntry(printer.id, {
      collectedAt: '2026-09-11T12:00:00.000Z',
      pageCount: 10,
      partial: false,
      supplies: [{ name: 'Transfer Roller', levelPercent: null }],
    });
    getLastReadingMock.mockReturnValueOnce(undefined);

    const fromHistory = (
      await app.inject({ method: 'GET', url: `/printers/${printer.id}/consumables`, headers: auth })
    ).json();
    expect(fromHistory.source).toBe('history');
    // A divergência, explícita. Se um dia o schema do histórico passar a
    // guardar o status do nível, é AQUI que a mudança precisa ser encarada.
    expect(fromHistory.supplies[0].status).toBe('unknown');
    expect(fromHistory.supplies[0].status).not.toBe(live.supplies[0].status);
  });
});
