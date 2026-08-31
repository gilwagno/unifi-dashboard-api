import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// Mesmo padrão de printers.routes.test.ts: banco real (node:sqlite) num
// arquivo temporário — nenhum mock do repositório. Só unifiService/
// unifiClassicService são mockados na camada de serviço (nunca a
// implementação interna), como no resto do projeto.
vi.mock('../../src/services/unifi.service.js', () => ({
  unifiService: {
    listClients: vi.fn(async () => ({ data: [] })),
  },
  UniFiApiError: class UniFiApiError extends Error {},
}));

vi.mock('../../src/services/unifi-classic.service.js', () => {
  // UnknownClientError PRECISA estender UniFiClassicApiError aqui, igual ao
  // serviço real (ver unifi-classic.service.ts) — é assim que o error
  // handler central (src/app.ts) reconhece o erro via `instanceof
  // UniFiClassicApiError` e usa o `status` (404) que o construtor grava.
  class UniFiClassicApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
      this.name = 'UniFiClassicApiError';
    }
  }
  class ClassicApiNotConfiguredError extends Error {
    constructor() {
      super('API clássica não configurada');
      this.name = 'ClassicApiNotConfiguredError';
    }
  }
  class UnknownClientError extends UniFiClassicApiError {
    constructor(mac: string) {
      super(404, `Cliente ${mac} não é conhecido pelo controller`);
      this.name = 'UnknownClientError';
    }
  }
  return {
    unifiClassicService: {
      isConfigured: vi.fn(() => false),
      getKnownClientsNetworkInfo: vi.fn(async () => new Map()),
      blockClient: vi.fn(async () => undefined),
      unblockClient: vi.fn(async () => undefined),
    },
    UniFiClassicApiError,
    ClassicApiNotConfiguredError,
    UnknownClientError,
  };
});

const tmpDir = mkdtempSync(join(tmpdir(), 'printers-reconnect-test-'));
process.env.PRINTERS_DB_FILE = join(tmpDir, 'printers.db');

const { buildApp } = await import('../../src/app.js');
const { printersRepository } = await import('../../src/routes/printers.routes.js');
const { unifiClassicService, ClassicApiNotConfiguredError, UnknownClientError, UniFiClassicApiError } = await import(
  '../../src/services/unifi-classic.service.js'
);

afterAll(() => {
  printersRepository.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token };
}

async function createPrinter(auth: Record<string, string>, app: Awaited<ReturnType<typeof buildApp>>, mac: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/printers',
    headers: auth,
    payload: {
      name: 'Impressora reconnect',
      mac,
      snmp: { version: 'v2c', community: 'segredo-qualquer' },
    },
  });
  return res.json();
}

beforeEach(() => {
  vi.mocked(unifiClassicService.blockClient).mockClear();
  vi.mocked(unifiClassicService.unblockClient).mockClear();
  vi.mocked(unifiClassicService.blockClient).mockImplementation(async () => undefined);
  vi.mocked(unifiClassicService.unblockClient).mockImplementation(async () => undefined);
});

describe('POST /printers/:id/reconnect', () => {
  it('caminho feliz: chama blockClient e depois unblockClient com o MAC certo, retorna 200 { ok: true }', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'aa:11:22:33:44:55');

    const callOrder: string[] = [];
    vi.mocked(unifiClassicService.blockClient).mockImplementation(async () => {
      callOrder.push('block');
    });
    vi.mocked(unifiClassicService.unblockClient).mockImplementation(async () => {
      callOrder.push('unblock');
    });

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reconnect`, headers: auth });

    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(true);
    expect(unifiClassicService.blockClient).toHaveBeenCalledWith('aa:11:22:33:44:55');
    expect(unifiClassicService.unblockClient).toHaveBeenCalledWith('aa:11:22:33:44:55');
    expect(callOrder).toEqual(['block', 'unblock']);

    await app.close();
  });

  it('retorna 404 quando o id da impressora não existe no registro', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };

    const res = await app.inject({ method: 'POST', url: '/printers/nao-existe/reconnect', headers: auth });

    expect(res.statusCode).toBe(404);
    expect(unifiClassicService.blockClient).not.toHaveBeenCalled();
    expect(unifiClassicService.unblockClient).not.toHaveBeenCalled();

    await app.close();
  });

  it('retorna 404 quando blockClient rejeita com UnknownClientError (MAC cadastrado aqui mas nunca visto pelo controller)', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'bb:11:22:33:44:66');

    vi.mocked(unifiClassicService.blockClient).mockRejectedValueOnce(new UnknownClientError(printer.mac));

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reconnect`, headers: auth });

    expect(res.statusCode).toBe(404);
    expect(unifiClassicService.unblockClient).not.toHaveBeenCalled();

    await app.close();
  });

  it('retorna 503 quando ClassicApiNotConfiguredError é lançado (sem credenciais clássicas)', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'cc:11:22:33:44:77');

    vi.mocked(unifiClassicService.blockClient).mockRejectedValueOnce(new ClassicApiNotConfiguredError());

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reconnect`, headers: auth });

    expect(res.statusCode).toBe(503);
    expect(unifiClassicService.unblockClient).not.toHaveBeenCalled();

    await app.close();
  });

  // Cenário distinto do UnknownClientError: a impressora sumiu da rede /
  // o controller respondeu com erro de gateway. Não é 404 (o controller
  // conhece o cliente) nem 503 (a API clássica ESTÁ configurada) — tem que
  // sair como o 502 que o serviço reportou, e não degradar para um 500
  // genérico que esconderia a causa. E, como o block falhou, o unblock não
  // pode ser chamado: a impressora nunca chegou a ser bloqueada.
  it('propaga o status de um UniFiClassicApiError genérico (502) do blockClient, sem chamar unblockClient', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'ff:11:22:33:44:aa');

    vi.mocked(unifiClassicService.blockClient).mockRejectedValueOnce(
      new UniFiClassicApiError(502, 'Bad Gateway ao falar com o controller'),
    );

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reconnect`, headers: auth });

    expect(res.statusCode).toBe(502);
    expect(unifiClassicService.unblockClient).not.toHaveBeenCalled();

    await app.close();
  });

  it('falha parcial: blockClient resolve mas unblockClient rejeita — o erro propaga (não é engolido) e um warn é registrado', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };

    // O logger da rota (`request.log`) é um child logger do pino criado
    // pelo próprio Fastify por requisição — reassinar/espionar `app.log.warn`
    // de antemão não é suficiente, pois o Fastify vincula os métodos de
    // nível do child no momento da criação (não faz lookup dinâmico via
    // protótipo a cada chamada). Por isso capturamos o `request.log` de
    // verdade daquela requisição específica via um hook `onRequest` (que
    // roda ANTES do handler da rota, então ainda dá tempo de instalar o spy
    // nele antes do `warn` acontecer dentro do handler). Precisa ser
    // registrado ANTES do primeiro `inject` (que já deixa a instância
    // "listening" e trava novos addHook), então roda também para o POST de
    // criação da impressora abaixo — inofensivo, esse request não chama warn.
    let warnSpy: ReturnType<typeof vi.spyOn> | undefined;
    app.addHook('onRequest', async (request) => {
      warnSpy = vi.spyOn(request.log, 'warn');
    });

    const printer = await createPrinter(auth, app, 'dd:11:22:33:44:88');
    warnSpy = undefined;

    const unblockError = new Error('controller caiu no meio do unblock');
    vi.mocked(unifiClassicService.unblockClient).mockRejectedValueOnce(unblockError);

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reconnect`, headers: auth });

    // O erro genérico não é nenhum dos tipos especiais tratados pelo error
    // handler central, então cai no branch de 500 (erro interno) — o que
    // importa aqui é que NÃO virou 200 { ok: true } silenciosamente.
    expect(res.statusCode).not.toBe(200);
    expect(unifiClassicService.blockClient).toHaveBeenCalledTimes(1);
    expect(unifiClassicService.unblockClient).toHaveBeenCalledTimes(1);
    expect(warnSpy).toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.objectContaining({ err: unblockError, printerId: printer.id, mac: printer.mac }),
      expect.stringContaining('unblockClient falhou'),
    );

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const printer = await createPrinter(auth, app, 'ee:11:22:33:44:99');

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reconnect` });

    expect(res.statusCode).toBe(401);

    await app.close();
  });
});
