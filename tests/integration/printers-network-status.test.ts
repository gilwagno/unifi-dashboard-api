import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

// Cobertura dedicada da subtarefa 2 da Onda 2 (ver CLAUDE.md): merge de
// GET /printers e GET /printers/:id com o status ao vivo do UniFi
// (online/offline, IP atual, tipo de conexão), casando pelo MAC. Mock na
// camada de serviço (unifiService/unifiClassicService), nunca na
// implementação interna da rota — mesmo padrão do resto do projeto (ver
// tests/integration/clients.test.ts).
//
// Achado crítico (docs/printers-snmp-research.md): das 3 impressoras reais
// da rede, só UMA aparece na Integration API oficial — as outras 2 só
// aparecem via API clássica (rest/user). Por isso os testes abaixo cobrem
// os 3 caminhos do merge (integration, classic, unknown) e o caso "API
// clássica não configurada", em vez de só o caminho feliz da Integration
// API.
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
    // stat/sta (conectados agora de verdade) — ver a melhoria de online/
    // offline pra impressoras "classic" (sessão de continuação do reboot
    // HP). Default vazio: nenhuma impressora "classic" nos testes existentes
    // é considerada conectada a menos que o teste diga o contrário.
    getConnectedMacs: vi.fn(async () => new Set()),
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

const tmpDir = mkdtempSync(join(tmpdir(), 'printers-network-status-test-'));
process.env.PRINTERS_DB_FILE = join(tmpDir, 'printers.db');

const { buildApp } = await import('../../src/app.js');
const { printersRepository } = await import('../../src/routes/printers.routes.js');
const { unifiService } = await import('../../src/services/unifi.service.js');
const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');

afterAll(() => {
  printersRepository.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  vi.mocked(unifiService.listClients).mockReset().mockResolvedValue({ data: [] });
  vi.mocked(unifiClassicService.isConfigured).mockReset().mockReturnValue(false);
  vi.mocked(unifiClassicService.getKnownClientsNetworkInfo).mockReset().mockResolvedValue(new Map());
  vi.mocked(unifiClassicService.getConnectedMacs).mockReset().mockResolvedValue(new Set());

  // printersRepository é um singleton a nível de módulo (compartilhado por
  // todas as apps criadas via buildApp() neste arquivo, já que todas leem
  // o mesmo PRINTERS_DB_FILE) — os testes abaixo reusam de propósito os
  // MACs das 3 impressoras reais em vários casos, então cada teste limpa o
  // que cadastrou antes do próximo rodar, senão o segundo cadastro do
  // mesmo MAC bateria em 409.
  for (const printer of printersRepository.listAll()) {
    printersRepository.delete(printer.id);
  }
});

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token };
}

// As 3 impressoras reais documentadas em docs/printers-snmp-research.md —
// usadas como MACs de teste (não como chamada de rede real: tudo mockado).
const HP_MAC = '50:81:40:d8:6c:7e';
const BROTHER_VENDAS_MAC = 'e8:6f:38:ba:b9:32';
const BROTHER_BRW_MAC = '84:9e:56:7e:04:45';

async function registerPrinter(app: Awaited<ReturnType<typeof buildApp>>, auth: Record<string, string>, mac: string, name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/printers',
    headers: auth,
    payload: { name, mac, snmp: { version: 'v2c', community: 'segredo-qualquer' } },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

describe('GET /printers e /printers/:id — merge com status do UniFi', () => {
  it('impressora encontrada na Integration API: source integration, online, IP e tipo de conexão corretos', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const created = await registerPrinter(app, auth, BROTHER_BRW_MAC, 'BRW849E567E0445');

    vi.mocked(unifiService.listClients).mockResolvedValueOnce({
      data: [
        {
          id: 'client-1',
          macAddress: BROTHER_BRW_MAC,
          ipAddress: '172.16.0.80',
          // Apelido ATUAL no UniFi (subtarefa nova: expor isso no merge —
          // achado real: o editor "Renomear apelido no UniFi" nunca
          // mostrava o valor atual em lugar nenhum).
          name: 'Apelido atual BRW',
          type: 'WIRELESS',
          blocked: false,
        },
      ],
    });

    const res = await app.inject({ method: 'GET', url: `/printers/${created.id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().network).toEqual({
      source: 'integration',
      online: true,
      ipAddress: '172.16.0.80',
      connectionType: 'WIRELESS',
      alias: 'Apelido atual BRW',
    });

    await app.close();
  });

  it('impressora NÃO encontrada na Integration API, mas encontrada na API clássica: source classic, online via stat/sta', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const created = await registerPrinter(app, auth, HP_MAC, 'HPLaserMFP135w');

    // Integration API não conhece essa impressora (achado documentado).
    vi.mocked(unifiService.listClients).mockResolvedValueOnce({ data: [] });
    vi.mocked(unifiClassicService.isConfigured).mockReturnValue(true);
    vi.mocked(unifiClassicService.getKnownClientsNetworkInfo).mockResolvedValueOnce(
      new Map([[HP_MAC, { ipAddress: '172.16.0.89', connectionType: 'WIRELESS', alias: 'Apelido atual HP' }]]),
    );
    // ACHADO/MELHORIA (sessão de continuação do reboot HP): stat/sta é quem
    // decide online/offline de verdade pra impressoras "classic" — rest/user
    // sozinho nunca afirmava isso (era sempre null antes desta melhoria).
    vi.mocked(unifiClassicService.getConnectedMacs).mockResolvedValueOnce(new Set([HP_MAC]));

    const res = await app.inject({ method: 'GET', url: `/printers/${created.id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().network).toEqual({
      source: 'classic',
      online: true,
      ipAddress: '172.16.0.89',
      connectionType: 'WIRELESS',
      alias: 'Apelido atual HP',
    });

    await app.close();
  });

  it('source classic, mas NÃO presente em stat/sta: online false (sabemos que não está conectada agora)', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const created = await registerPrinter(app, auth, HP_MAC, 'HPLaserMFP135w');

    vi.mocked(unifiService.listClients).mockResolvedValueOnce({ data: [] });
    vi.mocked(unifiClassicService.isConfigured).mockReturnValue(true);
    vi.mocked(unifiClassicService.getKnownClientsNetworkInfo).mockResolvedValueOnce(
      new Map([[HP_MAC, { ipAddress: '172.16.0.89', connectionType: 'WIRELESS', alias: null }]]),
    );
    // stat/sta responde com sucesso, mas SEM o MAC desta impressora — ela
    // está desconectada agora, não é um caso de "não sabemos".
    vi.mocked(unifiClassicService.getConnectedMacs).mockResolvedValueOnce(new Set(['aa:aa:aa:aa:aa:aa']));

    const res = await app.inject({ method: 'GET', url: `/printers/${created.id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().network).toEqual({
      source: 'classic',
      online: false,
      ipAddress: '172.16.0.89',
      connectionType: 'WIRELESS',
      // Sem apelido configurado no UniFi pra este cliente (campo `name`
      // vazio/ausente em /rest/user) — `null`, não string vazia.
      alias: null,
    });

    await app.close();
  });

  it('source classic, mas stat/sta falhou: online continua null (degrada pra "não sabemos", nunca false)', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const created = await registerPrinter(app, auth, HP_MAC, 'HPLaserMFP135w');

    vi.mocked(unifiService.listClients).mockResolvedValueOnce({ data: [] });
    vi.mocked(unifiClassicService.isConfigured).mockReturnValue(true);
    vi.mocked(unifiClassicService.getKnownClientsNetworkInfo).mockResolvedValueOnce(
      new Map([[HP_MAC, { ipAddress: '172.16.0.89', connectionType: 'WIRELESS', alias: null }]]),
    );
    vi.mocked(unifiClassicService.getConnectedMacs).mockRejectedValueOnce(new Error('sessão expirada'));

    const res = await app.inject({ method: 'GET', url: `/printers/${created.id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().network).toEqual({
      source: 'classic',
      online: null,
      ipAddress: '172.16.0.89',
      connectionType: 'WIRELESS',
      alias: null,
    });

    await app.close();
  });

  it('impressora não encontrada em nenhuma das duas fontes: source unknown, tudo null, sem erro', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const created = await registerPrinter(app, auth, BROTHER_VENDAS_MAC, 'HLL2360DWVENDAS');

    vi.mocked(unifiService.listClients).mockResolvedValueOnce({ data: [] });
    vi.mocked(unifiClassicService.isConfigured).mockReturnValue(true);
    vi.mocked(unifiClassicService.getKnownClientsNetworkInfo).mockResolvedValueOnce(new Map());

    const res = await app.inject({ method: 'GET', url: `/printers/${created.id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().network).toEqual({
      source: 'unknown',
      online: null,
      ipAddress: null,
      connectionType: null,
      alias: null,
    });

    await app.close();
  });

  it('API clássica não configurada e impressora fora da Integration API: source unknown (nunca 503)', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const created = await registerPrinter(app, auth, HP_MAC, 'HPLaserMFP135w');

    vi.mocked(unifiService.listClients).mockResolvedValueOnce({ data: [] });
    vi.mocked(unifiClassicService.isConfigured).mockReturnValue(false);

    const res = await app.inject({ method: 'GET', url: `/printers/${created.id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().network).toEqual({
      source: 'unknown',
      online: null,
      ipAddress: null,
      connectionType: null,
      alias: null,
    });
    // Não deveria nem tentar a API clássica quando ela não está configurada.
    expect(unifiClassicService.getKnownClientsNetworkInfo).not.toHaveBeenCalled();
    expect(unifiClassicService.getConnectedMacs).not.toHaveBeenCalled();

    await app.close();
  });

  it('cruzamento por MAC funciona independente de caixa (controller devolve MAC em minúsculas)', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    // Cadastro normaliza pra minúsculas (subtarefa 1) — envia em maiúsculas
    // pra confirmar que a normalização de entrada continua valendo.
    const created = await registerPrinter(app, auth, BROTHER_BRW_MAC.toUpperCase(), 'BRW849E567E0445');
    expect(created.mac).toBe(BROTHER_BRW_MAC);

    vi.mocked(unifiService.listClients).mockResolvedValueOnce({
      data: [
        {
          id: 'client-1',
          // O controller devolve minúsculas na prática, mas aqui a resposta
          // é simulada em MAIÚSCULAS de propósito: o cruzamento tem que vir
          // da normalização explícita dos dois lados (cadastro e resposta do
          // UniFi), nunca de coincidência de caixa. Com o mock em
          // minúsculas o teste passaria mesmo se a rota deixasse de
          // normalizar o MAC vindo da Integration API.
          macAddress: BROTHER_BRW_MAC.toUpperCase(),
          ipAddress: '172.16.0.80',
          type: 'WIRELESS',
          blocked: false,
        },
      ],
    });

    const res = await app.inject({ method: 'GET', url: `/printers/${created.id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().network.source).toBe('integration');
    expect(res.json().network.ipAddress).toBe('172.16.0.80');

    await app.close();
  });

  it('GET /printers (lista) faz o merge corretamente para cada uma das 3 impressoras, não só a primeira', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };

    const hp = await registerPrinter(app, auth, HP_MAC, 'HPLaserMFP135w');
    const brVendas = await registerPrinter(app, auth, BROTHER_VENDAS_MAC, 'HLL2360DWVENDAS');
    const brw = await registerPrinter(app, auth, BROTHER_BRW_MAC, 'BRW849E567E0445');

    // Só a BRW aparece na Integration API (achado real documentado).
    vi.mocked(unifiService.listClients).mockResolvedValueOnce({
      data: [
        {
          id: 'client-brw',
          macAddress: BROTHER_BRW_MAC,
          ipAddress: '172.16.0.80',
          name: 'Apelido atual BRW',
          type: 'WIRELESS',
          blocked: false,
        },
      ],
    });
    // Só a HP aparece na API clássica (a HLL2360DWVENDAS fica sem nenhuma
    // das duas fontes de propósito, pra testar o "unknown" dentro da
    // mesma listagem).
    vi.mocked(unifiClassicService.isConfigured).mockReturnValue(true);
    vi.mocked(unifiClassicService.getKnownClientsNetworkInfo).mockResolvedValueOnce(
      new Map([[HP_MAC, { ipAddress: '172.16.0.89', connectionType: 'WIRELESS', alias: 'Apelido atual HP' }]]),
    );
    // A HP está conectada agora (stat/sta) — deve aparecer online: true,
    // mesmo vindo pela API clássica.
    vi.mocked(unifiClassicService.getConnectedMacs).mockResolvedValueOnce(new Set([HP_MAC]));

    const res = await app.inject({ method: 'GET', url: '/printers', headers: auth });
    expect(res.statusCode).toBe(200);
    const list: Array<{ id: string; network: unknown }> = res.json();

    const byId = new Map(list.map((p) => [p.id, p.network]));
    expect(byId.get(brw.id)).toEqual({
      source: 'integration',
      online: true,
      ipAddress: '172.16.0.80',
      connectionType: 'WIRELESS',
      alias: 'Apelido atual BRW',
    });
    expect(byId.get(hp.id)).toEqual({
      source: 'classic',
      online: true,
      ipAddress: '172.16.0.89',
      connectionType: 'WIRELESS',
      alias: 'Apelido atual HP',
    });
    expect(byId.get(brVendas.id)).toEqual({
      source: 'unknown',
      online: null,
      ipAddress: null,
      connectionType: null,
      alias: null,
    });

    // A Integration API e as duas chamadas da API clássica só foram feitas
    // UMA vez cada, mesmo com 3 impressoras na listagem — nada de N chamadas
    // redundantes.
    expect(unifiService.listClients).toHaveBeenCalledTimes(1);
    expect(unifiClassicService.getKnownClientsNetworkInfo).toHaveBeenCalledTimes(1);
    expect(unifiClassicService.getConnectedMacs).toHaveBeenCalledTimes(1);

    await app.close();
  });

  it('Integration API rejeitando (controller fora do ar) não derruba GET /printers — degrada pra unknown', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const created = await registerPrinter(app, auth, HP_MAC, 'HPLaserMFP135w');

    vi.mocked(unifiService.listClients).mockRejectedValueOnce(new Error('controller fora do ar'));

    const res = await app.inject({ method: 'GET', url: `/printers/${created.id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().network).toEqual({ source: 'unknown', online: null, ipAddress: null, connectionType: null, alias: null });

    await app.close();
  });

  it('API clássica configurada mas rejeitando não derruba GET /printers — degrada pra unknown', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const created = await registerPrinter(app, auth, HP_MAC, 'HPLaserMFP135w');

    vi.mocked(unifiService.listClients).mockResolvedValueOnce({ data: [] });
    vi.mocked(unifiClassicService.isConfigured).mockReturnValue(true);
    vi.mocked(unifiClassicService.getKnownClientsNetworkInfo).mockRejectedValueOnce(new Error('sessão expirada'));

    const res = await app.inject({ method: 'GET', url: `/printers/${created.id}`, headers: auth });
    expect(res.statusCode).toBe(200);
    expect(res.json().network).toEqual({ source: 'unknown', online: null, ipAddress: null, connectionType: null, alias: null });

    await app.close();
  });
});
