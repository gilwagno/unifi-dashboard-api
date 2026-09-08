import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { PrinterSnmpReading } from '../../src/services/printer-snmp.service.js';

// Mesmo padrão de printers-diagnostics.test.ts/printers-consumables.test.ts:
// banco real (node:sqlite) num arquivo temporário, sem mock do repositório.
// unifiService/unifiClassicService mockados só para GET /printers/:id não
// fazer chamada de rede de verdade (não é usado diretamente pela rota de
// manutenção, mas app.js carrega todas as rotas juntas).
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
    }
  },
  ClassicApiNotConfiguredError: class ClassicApiNotConfiguredError extends Error {},
}));

// A ROTA importa `getLastReading` de printer-snmp.service.js — mock na
// camada de serviço (nunca a implementação interna da rota), igual ao resto
// do projeto. `pageCountValue` (subtarefa 12) também é importado pela rota
// diretamente do serviço — precisa estar no mock com o comportamento real
// (SnmpMeasurement 'ok' -> number, qualquer outro status -> null), senão
// toMaintenanceResponse quebra em runtime chamando algo `undefined`.
const getLastReadingMock = vi.fn<(printerId: string) => PrinterSnmpReading | undefined>(() => undefined);

vi.mock('../../src/services/printer-snmp.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/printer-snmp.service.js')>();
  return {
    getLastReading: (printerId: string) => getLastReadingMock(printerId),
    collectAllReadings: vi.fn(async () => undefined),
    // Função PURA (não toca rede/banco/timer) — vem do módulo REAL, nunca
    // reimplementada aqui. Ver o comentário equivalente em
    // printers-consumables.test.ts: uma cópia no mock faria o teste
    // 'currentPageCount fica null quando o poller retorna um sentinela'
    // validar a cópia em vez da produção, deixando passar verde um
    // `pageCount` sentinela virando `0` — que contaminaria `pagesOverdue`
    // com "imprimiu 0 páginas" em vez de "contador ilegível".
    pageCountValue: actual.pageCountValue,
  };
});

const tmpDir = mkdtempSync(join(tmpdir(), 'printers-maintenance-test-'));
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
      mac: `aa:bb:cc:dd:fe:${suffix}`,
      snmp: { version: 'v2c', community: 'community-de-teste' },
      ...overrides,
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json() as { id: string };
}

function buildReading(overrides: Partial<PrinterSnmpReading> = {}): PrinterSnmpReading {
  return {
    printerId: 'irrelevante-sobrescrito-por-teste',
    printerName: 'Impressora de teste',
    ipAddress: '172.16.0.89',
    collectedAt: '2026-08-31T12:00:00.000Z',
    sysDescr: 'sysDescr de teste',
    deviceDescr: 'modelo de teste',
    deviceStatus: { status: 'ok', value: 2 },
    deviceStatusLabel: 'running',
    detectedErrorStates: [],
    pageCount: { status: 'ok', value: 1000 },
    supplies: [],
    partial: false,
    ...overrides,
  };
}

describe('POST /printers/:id/maintenance', () => {
  it('retorna 404 para id inexistente', async () => {
    const { app, token } = await authedApp();
    const res = await app.inject({
      method: 'POST',
      url: '/printers/nao-existe/maintenance',
      headers: { authorization: `Bearer ${token}` },
      payload: {},
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();
    const res = await app.inject({ method: 'POST', url: '/printers/qualquer-id/maintenance', payload: {} });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('cria evento com todos os campos', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/maintenance`,
      headers: auth,
      payload: {
        performedAt: '2026-01-10T08:00:00.000Z',
        note: 'Troca de toner preto',
        pageCountAtMaintenance: 5000,
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.printerId).toBe(printer.id);
    expect(body.performedAt).toBe('2026-01-10T08:00:00.000Z');
    expect(body.note).toBe('Troca de toner preto');
    expect(body.pageCountAtMaintenance).toBe(5000);
    expect(typeof body.id).toBe('string');
    expect(typeof body.createdAt).toBe('string');

    await app.close();
  });

  it('cria evento só com campos obrigatórios (defaults: performedAt = agora, note/pageCountAtMaintenance null)', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    const before = Date.now();
    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/maintenance`,
      headers: auth,
      payload: {},
    });
    const after = Date.now();

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.note).toBeNull();
    expect(body.pageCountAtMaintenance).toBeNull();
    const performedAtMs = new Date(body.performedAt).getTime();
    expect(performedAtMs).toBeGreaterThanOrEqual(before - 1000);
    expect(performedAtMs).toBeLessThanOrEqual(after + 1000);

    await app.close();
  });
});

describe('GET /printers/:id/maintenance', () => {
  it('retorna 404 para id inexistente', async () => {
    const { app, token } = await authedApp();
    const res = await app.inject({
      method: 'GET',
      url: '/printers/nao-existe/maintenance',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();
    const res = await app.inject({ method: 'GET', url: '/printers/qualquer-id/maintenance' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });

  it('lista eventos mais recente primeiro', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/maintenance`,
      headers: auth,
      payload: { performedAt: '2026-01-01T00:00:00.000Z', note: 'mais antigo' },
    });
    await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/maintenance`,
      headers: auth,
      payload: { performedAt: '2026-03-01T00:00:00.000Z', note: 'mais recente' },
    });
    await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/maintenance`,
      headers: auth,
      payload: { performedAt: '2026-02-01T00:00:00.000Z', note: 'meio' },
    });

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/maintenance`, headers: auth });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events.map((e: { note: string }) => e.note)).toEqual(['mais recente', 'meio', 'mais antigo']);

    await app.close();
  });

  it('next com 0 eventos: tudo null/false mesmo com política configurada', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth, {
      maintenance: { intervalDays: 30, intervalPages: 5000 },
    });

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/maintenance`, headers: auth });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.policy).toEqual({ intervalDays: 30, intervalPages: 5000 });
    expect(body.events).toEqual([]);
    expect(body.next).toEqual({
      dueAt: null,
      duePages: null,
      currentPageCount: null,
      dateOverdue: false,
      pagesOverdue: false,
    });

    await app.close();
  });

  it('next com intervalDays configurado: dueAt calculado e dateOverdue true quando no passado', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth, { maintenance: { intervalDays: 30 } });

    await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/maintenance`,
      headers: auth,
      payload: { performedAt: '2020-01-01T00:00:00.000Z' },
    });

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/maintenance`, headers: auth });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.next.dueAt).toBe('2020-01-31T00:00:00.000Z');
    expect(body.next.dateOverdue).toBe(true);

    await app.close();
  });

  it('next com intervalDays configurado mas dueAt no futuro: dateOverdue false', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth, { maintenance: { intervalDays: 30 } });

    const farFuture = new Date(Date.now() + 10_000).toISOString();
    await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/maintenance`,
      headers: auth,
      payload: { performedAt: farFuture },
    });

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/maintenance`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json().next.dateOverdue).toBe(false);

    await app.close();
  });

  it('next com intervalPages + pageCountAtMaintenance do evento + pageCount atual do poller: pagesOverdue true quando atingido/ultrapassado', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth, { maintenance: { intervalPages: 1000 } });

    await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/maintenance`,
      headers: auth,
      payload: { pageCountAtMaintenance: 5000 },
    });

    getLastReadingMock.mockReturnValueOnce(
      buildReading({ printerId: printer.id, pageCount: { status: 'ok', value: 6000 } }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/maintenance`, headers: auth });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.next.duePages).toBe(6000);
    expect(body.next.currentPageCount).toBe(6000);
    expect(body.next.pagesOverdue).toBe(true);

    await app.close();
  });

  it('next com intervalPages: pagesOverdue false quando o contador atual ainda não chegou no limite', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth, { maintenance: { intervalPages: 1000 } });

    await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/maintenance`,
      headers: auth,
      payload: { pageCountAtMaintenance: 5000 },
    });

    getLastReadingMock.mockReturnValueOnce(
      buildReading({ printerId: printer.id, pageCount: { status: 'ok', value: 5999 } }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/maintenance`, headers: auth });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.next.duePages).toBe(6000);
    expect(body.next.pagesOverdue).toBe(false);

    await app.close();
  });

  it('next quando a política não está configurada: dueAt/duePages ficam null mesmo com eventos', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/maintenance`,
      headers: auth,
      payload: { performedAt: '2020-01-01T00:00:00.000Z', pageCountAtMaintenance: 5000 },
    });

    getLastReadingMock.mockReturnValueOnce(
      buildReading({ printerId: printer.id, pageCount: { status: 'ok', value: 9000 } }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/maintenance`, headers: auth });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.policy).toEqual({ intervalDays: null, intervalPages: null });
    expect(body.next.dueAt).toBeNull();
    expect(body.next.duePages).toBeNull();
    expect(body.next.dateOverdue).toBe(false);
    expect(body.next.pagesOverdue).toBe(false);

    await app.close();
  });

  it('currentPageCount fica null quando o poller nunca coletou', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth, { maintenance: { intervalPages: 1000 } });

    await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/maintenance`,
      headers: auth,
      payload: { pageCountAtMaintenance: 5000 },
    });

    getLastReadingMock.mockReturnValueOnce(undefined);

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/maintenance`, headers: auth });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.next.currentPageCount).toBeNull();
    expect(body.next.pagesOverdue).toBe(false);

    await app.close();
  });

  it('currentPageCount fica null quando o poller retorna um sentinela SNMP (não "ok") no pageCount', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth, { maintenance: { intervalPages: 1000 } });

    await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/maintenance`,
      headers: auth,
      payload: { pageCountAtMaintenance: 5000 },
    });

    getLastReadingMock.mockReturnValueOnce(
      buildReading({ printerId: printer.id, pageCount: { status: 'unsupported' } }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/maintenance`, headers: auth });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.next.currentPageCount).toBeNull();
    expect(body.next.pagesOverdue).toBe(false);

    await app.close();
  });

  // REGRESSÃO — a rota aceita `performedAt` com QUALQUER offset de fuso
  // (`z.string().datetime({ offset: true })`) e guarda a string exatamente
  // como recebida. Ordenar isso por comparação de texto no SQL
  // (`ORDER BY performed_at DESC`) está errado: '2026-03-10T23:00:00.000-03:00'
  // (= 02:00Z do dia 11, o mais RECENTE) ordena depois de
  // '2026-03-11T01:00:00.000Z' lexicograficamente. Como computeNextMaintenance
  // usa events[0] como "última manutenção", o erro não fica só na listagem:
  // contamina dueAt/duePages/overdue. O fuso -03:00 é justamente o do projeto
  // (America/Sao_Paulo), então não é um caso hipotético.
  it('ordena por instante real, não por texto, quando performedAt vem com offset de fuso', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth, {
      maintenance: { intervalDays: 30, intervalPages: 1000 },
    });

    // Mais antigo em tempo real (01:00Z do dia 11)...
    await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/maintenance`,
      headers: auth,
      payload: { performedAt: '2026-03-11T01:00:00.000Z', note: 'mais antigo', pageCountAtMaintenance: 100 },
    });
    // ...e o mais RECENTE (02:00Z do dia 11), escrito em horário de Brasília —
    // a string começa com '2026-03-10', menor lexicograficamente.
    await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/maintenance`,
      headers: auth,
      payload: { performedAt: '2026-03-10T23:00:00.000-03:00', note: 'mais recente', pageCountAtMaintenance: 200 },
    });

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/maintenance`, headers: auth });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.events.map((e: { note: string }) => e.note)).toEqual(['mais recente', 'mais antigo']);
    // dueAt/duePages têm de sair do evento mais recente de verdade
    // (02:00Z + 30 dias; 200 + 1000), não do que "parece" maior em texto.
    expect(body.next.dueAt).toBe('2026-04-10T02:00:00.000Z');
    expect(body.next.duePages).toBe(1200);

    await app.close();
  });

  // Lacuna revelada por mutação: sem esta checagem, `null + intervalPages`
  // vira `intervalPages` em JS (null coage para 0) e a impressora passa a
  // reportar um duePages inventado — com alerta de atraso falso assim que o
  // contador atual passar do intervalo.
  it('duePages fica null quando o último evento não informou pageCountAtMaintenance, mesmo com intervalPages', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth, { maintenance: { intervalPages: 1000 } });

    await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/maintenance`,
      headers: auth,
      payload: { note: 'sem contador registrado' },
    });

    getLastReadingMock.mockReturnValueOnce(
      buildReading({ printerId: printer.id, pageCount: { status: 'ok', value: 50_000 } }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/maintenance`, headers: auth });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.next.duePages).toBeNull();
    expect(body.next.currentPageCount).toBe(50_000);
    expect(body.next.pagesOverdue).toBe(false);

    await app.close();
  });

  // Contador zerado é um valor legítimo (impressora nova, ou contador
  // resetado): 0 precisa ser aceito na escrita e servir de base para
  // duePages, não ser rejeitado como se fosse "não informado".
  it('aceita pageCountAtMaintenance = 0 e usa como base de duePages', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth, { maintenance: { intervalPages: 1000 } });

    const created = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/maintenance`,
      headers: auth,
      payload: { pageCountAtMaintenance: 0 },
    });
    expect(created.statusCode).toBe(201);
    expect(created.json().pageCountAtMaintenance).toBe(0);

    getLastReadingMock.mockReturnValueOnce(
      buildReading({ printerId: printer.id, pageCount: { status: 'ok', value: 999 } }),
    );

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/maintenance`, headers: auth });

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.next.duePages).toBe(1000);
    expect(body.next.pagesOverdue).toBe(false);

    await app.close();
  });

  it('nunca vaza snmpSecret na resposta', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(app, auth);

    await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/maintenance`,
      headers: auth,
      payload: { note: 'teste' },
    });

    const res = await app.inject({ method: 'GET', url: `/printers/${printer.id}/maintenance`, headers: auth });

    expect(res.statusCode).toBe(200);
    const body = JSON.stringify(res.json());
    expect(body).not.toContain('community-de-teste');
    expect(body).not.toContain('snmpSecret');

    await app.close();
  });
});
