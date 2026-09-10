import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PrinterSnmpReading } from '../../src/services/printer-snmp.service.js';

// Mesmo padrão de printers-consumables.test.ts/printers-diagnostics.test.ts:
// banco real (node:sqlite) num arquivo temporário, sem mock do repositório.
// unifiService/unifiClassicService mockados só para as rotas de /printers
// que consultam status do UniFi não fazerem chamada de rede de verdade.
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

// A ROTA importa `getLastReading`/`pageCountValue` de printer-snmp.service.js
// — mock na camada de serviço (nunca a implementação interna da rota), igual
// ao resto do projeto. GET /printers/:id/history NÃO usa `getLastReading`
// (lê direto do repositório via printersRepository.listSnmpHistory), mas o
// módulo inteiro precisa ser mockado porque a rota o importa.
const getLastReadingMock = vi.fn<(printerId: string) => PrinterSnmpReading | undefined>(() => undefined);

vi.mock('../../src/services/printer-snmp.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/printer-snmp.service.js')>();
  return {
    getLastReading: (printerId: string) => getLastReadingMock(printerId),
    collectAllReadings: vi.fn(async () => undefined),
    // Puras — vêm do módulo real (ver printers-consumables.test.ts).
    // `parseSupplyDescription` (subtarefa 19) é a que a rota usa pra
    // normalizar o `name` de linhas de histórico gravadas ANTES da
    // subtarefa 19 (com "S/N:..." embutido) — reimplementá-la aqui
    // esconderia uma regressão real de "linha antiga não normaliza".
    pageCountValue: actual.pageCountValue,
    parseSupplyDescription: actual.parseSupplyDescription,
  };
});

const tmpDir = mkdtempSync(join(tmpdir(), 'printers-history-test-'));
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

async function createPrinter(app: Awaited<ReturnType<typeof buildApp>>, auth: Record<string, string>) {
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
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

describe('GET /printers/:id/history', () => {
  it('retorna 404 para id inexistente', async () => {
    const { app, token } = await authedApp();
    const res = await app.inject({
      method: 'GET',
      url: '/printers/nao-existe/history',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();
    const res = await app.inject({ method: 'GET', url: '/printers/qualquer-id/history' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('impressora cadastrada mas sem nenhuma leitura histórica: entries vazio, sem erro', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/history`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ printerId: printer.id, entries: [] });

    await app.close();
  });

  it('sem from/to, devolve todas as entradas gravadas, em ordem cronológica', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    printersRepository.recordSnmpHistoryEntry(printer.id, {
      collectedAt: '2026-08-31T14:00:00.000Z',
      pageCount: 300,
      supplies: [{ name: 'Toner Preto', levelPercent: 40 }],
      partial: false,
    });
    printersRepository.recordSnmpHistoryEntry(printer.id, {
      collectedAt: '2026-08-31T12:00:00.000Z',
      pageCount: 100,
      supplies: [{ name: 'Toner Preto', levelPercent: 60 }],
      partial: true,
    });

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/history`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      printerId: printer.id,
      entries: [
        {
          collectedAt: '2026-08-31T12:00:00.000Z',
          pageCount: 100,
          supplies: [{ name: 'Toner Preto', levelPercent: 60 }],
          partial: true,
        },
        {
          collectedAt: '2026-08-31T14:00:00.000Z',
          pageCount: 300,
          supplies: [{ name: 'Toner Preto', levelPercent: 40 }],
          partial: false,
        },
      ],
    });

    await app.close();
  });

  // Achado real da revisão crítica da subtarefa 19: `suppliesForHistory`
  // passou a gravar o nome do suprimento SEM o "S/N:..." embutido (antes
  // dessa mudança, gravava cru). Linhas gravadas ANTES da subtarefa 19
  // continuam no banco (retenção de 90 dias) com o nome antigo — sem
  // normalizar na leitura, o MESMO cartucho físico apareceria como dois
  // suprimentos distintos na série temporal (um que "termina" com o nome
  // antigo, outro que "começa" com o nome novo) na primeira consulta depois
  // do deploy. `parseSupplyDescription` é idempotente, então a normalização
  // na leitura corrige as linhas antigas sem precisar de migração.
  it('normaliza na leitura o nome de linhas gravadas ANTES da subtarefa 19 (com "S/N:" embutido), unificando com o nome novo', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    // Linha "antiga" (pré-subtarefa 19): nome cru com serial embutido.
    printersRepository.recordSnmpHistoryEntry(printer.id, {
      collectedAt: '2026-08-31T10:00:00.000Z',
      pageCount: 100,
      supplies: [{ name: 'Black Toner S/N:CRUM-210729A5BB3', levelPercent: 70 }],
      partial: false,
    });
    // Linha "nova" (pós-subtarefa 19): nome já sem o serial.
    printersRepository.recordSnmpHistoryEntry(printer.id, {
      collectedAt: '2026-08-31T12:00:00.000Z',
      pageCount: 200,
      supplies: [{ name: 'Black Toner', levelPercent: 55 }],
      partial: false,
    });

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/history`, headers: auth });

    expect(res.statusCode).toBe(200);
    const names = res.json().entries.map((entry: { supplies: Array<{ name: string }> }) =>
      entry.supplies.map((s) => s.name),
    );
    // As duas linhas colapsam pro MESMO nome — o mesmo cartucho físico,
    // não dois suprimentos diferentes.
    expect(names).toEqual([['Black Toner'], ['Black Toner']]);

    await app.close();
  });

  it('filtra por from/to em UTC, incluindo os limites', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    for (const [collectedAt, pageCount] of [
      ['2026-08-01T00:00:00.000Z', 1],
      ['2026-08-15T00:00:00.000Z', 2],
      ['2026-08-30T00:00:00.000Z', 3],
    ] as const) {
      printersRepository.recordSnmpHistoryEntry(printer.id, { collectedAt, pageCount, supplies: [], partial: false });
    }

    const res = await app.inject({
      method: 'GET',
      url: `/printers/${printer.id}/history?from=2026-08-15T00:00:00.000Z&to=2026-08-15T00:00:00.000Z`,
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].pageCount).toBe(2);

    await app.close();
  });

  // Regressão (mesma armadilha documentada em bandwidth-history.service.ts):
  // `from`/`to` com offset de fuso (America/São_Paulo, -03:00) precisam ser
  // convertidos para UTC canônico antes de comparar com `collected_at`
  // (sempre gravado em UTC 'Z') — senão a resposta vem vazia sem erro.
  it('aceita from/to com offset de fuso (-03:00), convertendo para UTC antes de comparar', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    // 08:00 em -03:00 == 11:00Z.
    printersRepository.recordSnmpHistoryEntry(printer.id, {
      collectedAt: '2026-03-10T11:00:00.000Z',
      pageCount: 42,
      supplies: [],
      partial: false,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/printers/${printer.id}/history?from=${encodeURIComponent('2026-03-10T07:00:00-03:00')}&to=${encodeURIComponent('2026-03-10T09:00:00-03:00')}`,
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0]).toEqual({ collectedAt: '2026-03-10T11:00:00.000Z', pageCount: 42, supplies: [], partial: false });

    await app.close();
  });

  // Segunda metade da MESMA armadilha (a primeira é o offset de fuso acima):
  // '...T12:00:00Z' é ISO válido, aceito pelo schema, e LEXICOGRAFICAMENTE
  // MAIOR que '...T12:00:00.000Z' porque 'Z' (0x5A) > '.' (0x2E). Sem
  // canonicalizar, um `from` sem milissegundos excluiria a própria entrada
  // daquele instante exato, e um `to` sem milissegundos incluiria coisa
  // demais — nos dois casos sem erro nenhum. Este caso é testado à parte do
  // teste de offset porque uma canonicalização PARCIAL (que só resolvesse o
  // offset, ex.: via regex) passaria pelo outro teste e falharia aqui.
  it('aceita from/to SEM milissegundos, canonicalizando antes de comparar', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    printersRepository.recordSnmpHistoryEntry(printer.id, {
      collectedAt: '2026-07-01T12:00:00.000Z',
      pageCount: 7,
      supplies: [],
      partial: false,
    });

    // `from` == `to` == exatamente o instante da entrada, sem os '.000'.
    const res = await app.inject({
      method: 'GET',
      url: `/printers/${printer.id}/history?from=2026-07-01T12:00:00Z&to=2026-07-01T12:00:00Z`,
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.entries).toHaveLength(1);
    expect(body.entries[0].pageCount).toBe(7);

    await app.close();
  });

  it('from/to fora da janela de dados devolve entries vazio, sem erro', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    printersRepository.recordSnmpHistoryEntry(printer.id, {
      collectedAt: '2026-08-15T00:00:00.000Z',
      pageCount: 1,
      supplies: [],
      partial: false,
    });

    const res = await app.inject({
      method: 'GET',
      url: `/printers/${printer.id}/history?from=2000-01-01T00:00:00.000Z&to=2000-01-02T00:00:00.000Z`,
      headers: auth,
    });

    expect(res.statusCode).toBe(200);
    expect(res.json().entries).toEqual([]);

    await app.close();
  });

  it('rejeita from/to com formato inválido (400)', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    const res = await app.inject({
      method: 'GET',
      url: `/printers/${printer.id}/history?from=ontem`,
      headers: auth,
    });

    expect(res.statusCode).toBe(400);

    await app.close();
  });

  it('SEGURANÇA: a resposta nunca contém o segredo SNMP da impressora', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    printersRepository.recordSnmpHistoryEntry(printer.id, {
      collectedAt: '2026-08-31T12:00:00.000Z',
      pageCount: 1,
      supplies: [{ name: 'Toner Preto', levelPercent: 50 }],
      partial: false,
    });

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/history`, headers: auth });

    expect(res.statusCode).toBe(200);
    const raw = res.body;
    expect(raw).not.toContain('community-de-teste');
    expect(raw).not.toContain('snmpSecret');
    expect(raw).not.toContain('snmp_secret');

    await app.close();
  });
});
