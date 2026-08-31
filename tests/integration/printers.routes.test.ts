import { rmSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// Diferente do resto das rotas de teste do projeto (que mockam a camada de
// serviço), aqui não há serviço externo nenhum pro CRUD em si — a rota fala
// direto com src/db/printers.db.ts, que é banco de verdade (node:sqlite).
// Por isso o mock certo pro banco é NENHUM: sobrescreve PRINTERS_DB_FILE (o
// setup global usa ':memory:', o que serviria, mas usamos um arquivo real
// num diretório temporário para também validar que a rota funciona contra
// um arquivo em disco de verdade, não só em memória) antes de importar o
// app, e limpa o diretório no final.
//
// GET /printers e GET /printers/:id, porém, desde a subtarefa 2 (merge com
// status do UniFi), TAMBÉM chamam unifiService/unifiClassicService — esses
// dois são mockados aqui (API clássica não configurada, Integration API sem
// clientes) só pra essas rotas não fazerem uma chamada de rede de verdade
// nestes testes de CRUD, que não são sobre o merge de status. A cobertura
// dedicada do merge (integration/classic/unknown) está em
// tests/integration/printers-network-status.test.ts.
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

const tmpDir = mkdtempSync(join(tmpdir(), 'printers-routes-test-'));
process.env.PRINTERS_DB_FILE = join(tmpDir, 'printers.db');

const { buildApp } = await import('../../src/app.js');
const { printersRepository } = await import('../../src/routes/printers.routes.js');

afterAll(() => {
  // Fecha a conexão SQLite antes de apagar o diretório temporário — no
  // Windows, remover um arquivo com um handle ainda aberto falha com EPERM.
  printersRepository.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token };
}

const validBody = {
  name: 'HPLaserMFP135w',
  mac: '50:81:40:d8:6c:7e',
  snmp: { version: 'v2c', community: 'super-secret-community-string' },
};

const SECRET = 'super-secret-community-string';

// Todas as respostas JSON coletadas ao longo dos testes de CRUD feliz, para
// a checagem final de vazamento do segredo em TODAS elas de uma vez (além
// das checagens pontuais já feitas em cada teste).
const allResponseBodies: unknown[] = [];

function assertNoSecretLeak(body: unknown, secret = SECRET) {
  const serialized = JSON.stringify(body);
  expect(serialized).not.toContain(secret);
  expect(serialized.toLowerCase()).not.toContain('snmpsecret');
  allResponseBodies.push(body);
}

describe('POST /printers', () => {
  it('cria um registro e retorna 201 sem o segredo SNMP', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/printers',
      headers: { authorization: `Bearer ${token}` },
      payload: validBody,
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.id).toBeTruthy();
    expect(body.name).toBe('HPLaserMFP135w');
    expect(body.mac).toBe('50:81:40:d8:6c:7e');
    expect(body.snmpVersion).toBe('v2c');
    expect(body).not.toHaveProperty('snmpSecret');
    assertNoSecretLeak(body);

    await app.close();
  });

  it('rejeita MAC inválido (400)', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/printers',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validBody, mac: 'nao-e-um-mac' },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejeita version v1/v2c sem community (400)', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/printers',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validBody, snmp: { version: 'v2c' } },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('rejeita version v3 sem v3Auth (400)', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/printers',
      headers: { authorization: `Bearer ${token}` },
      payload: { ...validBody, snmp: { version: 'v3' } },
    });

    expect(res.statusCode).toBe(400);
    await app.close();
  });

  it('aceita version v3 com v3Auth completo', async () => {
    const { app, token } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: '/printers',
      headers: { authorization: `Bearer ${token}` },
      payload: {
        name: 'BRW849E567E0445',
        mac: '84:9e:56:7e:04:45',
        snmp: {
          version: 'v3',
          v3Auth: { username: 'admin', authProtocol: 'SHA', authPassword: 'senha-de-autenticacao-v3' },
        },
      },
    });

    expect(res.statusCode).toBe(201);
    const body = res.json();
    expect(body.snmpVersion).toBe('v3');
    assertNoSecretLeak(body, 'senha-de-autenticacao-v3');

    await app.close();
  });

  it('retorna 401 sem token', async () => {
    const { app } = await authedApp();
    const res = await app.inject({ method: 'POST', url: '/printers', payload: validBody });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('CRUD completo de /printers', () => {
  it('cria, lista, busca, atualiza e remove um registro — sem vazar o segredo em nenhuma resposta', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };

    // CREATE — MAC próprio deste teste: o cadastro exige MAC único e o
    // `validBody` já foi usado pelo primeiro POST desta suíte (que não
    // remove o registro no fim).
    const createRes = await app.inject({
      method: 'POST',
      url: '/printers',
      headers: auth,
      payload: { ...validBody, mac: 'e8:6f:38:ba:b9:32' },
    });
    expect(createRes.statusCode).toBe(201);
    const created = createRes.json();
    assertNoSecretLeak(created);
    const { id } = created;

    // LIST
    const listRes = await app.inject({ method: 'GET', url: '/printers', headers: auth });
    expect(listRes.statusCode).toBe(200);
    const list = listRes.json();
    expect(Array.isArray(list)).toBe(true);
    expect(list.some((p: { id: string }) => p.id === id)).toBe(true);
    assertNoSecretLeak(list);

    // GET one
    const getRes = await app.inject({ method: 'GET', url: `/printers/${id}`, headers: auth });
    expect(getRes.statusCode).toBe(200);
    const fetched = getRes.json();
    expect(fetched.id).toBe(id);
    assertNoSecretLeak(fetched);

    // PATCH (nome + troca de segredo)
    const newSecret = 'outro-segredo-completamente-diferente';
    const patchRes = await app.inject({
      method: 'PATCH',
      url: `/printers/${id}`,
      headers: auth,
      payload: { name: 'Nome Atualizado', snmp: { version: 'v2c', community: newSecret } },
    });
    expect(patchRes.statusCode).toBe(200);
    const patched = patchRes.json();
    expect(patched.name).toBe('Nome Atualizado');
    assertNoSecretLeak(patched, SECRET);
    assertNoSecretLeak(patched, newSecret);

    // GET one novamente confirma persistência do PATCH e ainda sem vazar o novo segredo
    const getAfterPatch = await app.inject({ method: 'GET', url: `/printers/${id}`, headers: auth });
    expect(getAfterPatch.json().name).toBe('Nome Atualizado');
    assertNoSecretLeak(getAfterPatch.json(), newSecret);

    // DELETE
    const deleteRes = await app.inject({ method: 'DELETE', url: `/printers/${id}`, headers: auth });
    expect(deleteRes.statusCode).toBe(200);
    expect(deleteRes.json()).toEqual({ ok: true });

    // Confirma remoção
    const getAfterDelete = await app.inject({ method: 'GET', url: `/printers/${id}`, headers: auth });
    expect(getAfterDelete.statusCode).toBe(404);

    await app.close();
  });
});

describe('unicidade e normalização de MAC', () => {
  it('rejeita com 409 um segundo cadastro com o mesmo MAC, inclusive em outra caixa', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };
    const mac = 'aa:bb:cc:00:11:22';

    const first = await app.inject({
      method: 'POST',
      url: '/printers',
      headers: auth,
      payload: { ...validBody, name: 'Primeira', mac },
    });
    expect(first.statusCode).toBe(201);
    // O MAC é normalizado para minúsculas na entrada — o controller UniFi
    // devolve minúsculas, então o cadastro precisa casar com ele.
    expect(first.json().mac).toBe(mac);

    const duplicate = await app.inject({
      method: 'POST',
      url: '/printers',
      headers: auth,
      payload: { ...validBody, name: 'Duplicada', mac: mac.toUpperCase() },
    });
    expect(duplicate.statusCode).toBe(409);

    // E o cadastro duplicado não entrou na listagem.
    const list = await app.inject({ method: 'GET', url: '/printers', headers: auth });
    expect(list.json().filter((p: { mac: string }) => p.mac === mac)).toHaveLength(1);
    assertNoSecretLeak(list.json());

    await app.close();
  });

  it('PATCH para um MAC já usado por outra impressora retorna 409, mas reenviar o próprio MAC é aceito', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };

    const a = (
      await app.inject({
        method: 'POST',
        url: '/printers',
        headers: auth,
        payload: { ...validBody, name: 'A', mac: 'aa:bb:cc:00:33:44' },
      })
    ).json();
    const b = (
      await app.inject({
        method: 'POST',
        url: '/printers',
        headers: auth,
        payload: { ...validBody, name: 'B', mac: 'aa:bb:cc:00:55:66' },
      })
    ).json();

    const conflict = await app.inject({
      method: 'PATCH',
      url: `/printers/${b.id}`,
      headers: auth,
      payload: { mac: a.mac },
    });
    expect(conflict.statusCode).toBe(409);

    // Reenviar o MAC que o próprio registro já tem não é conflito.
    const same = await app.inject({
      method: 'PATCH',
      url: `/printers/${b.id}`,
      headers: auth,
      payload: { mac: b.mac, name: 'B renomeada' },
    });
    expect(same.statusCode).toBe(200);
    expect(same.json().name).toBe('B renomeada');

    await app.close();
  });
});

describe('PATCH parcial', () => {
  it('preserva os campos não enviados e realmente troca o segredo no banco', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };

    const created = (
      await app.inject({
        method: 'POST',
        url: '/printers',
        headers: auth,
        payload: {
          name: 'Preserva',
          mac: 'aa:bb:cc:00:77:88',
          ipOverride: '172.16.0.89',
          snmp: { version: 'v2c', community: SECRET },
          maintenance: { intervalDays: 30, intervalPages: 5000, consumableLowThresholdPct: 15 },
        },
      })
    ).json();

    const patched = (
      await app.inject({ method: 'PATCH', url: `/printers/${created.id}`, headers: auth, payload: { name: 'Só o nome' } })
    ).json();

    expect(patched.name).toBe('Só o nome');
    expect(patched.mac).toBe(created.mac);
    expect(patched.ipOverride).toBe('172.16.0.89');
    expect(patched.snmpVersion).toBe('v2c');
    expect(patched.maintenance).toEqual({ intervalDays: 30, intervalPages: 5000, consumableLowThresholdPct: 15 });
    expect(patched.createdAt).toBe(created.createdAt);
    assertNoSecretLeak(patched);

    // O segredo não foi tocado por um PATCH que não mandou `snmp`. A API
    // nunca devolve o segredo, então a checagem é direto no repositório.
    expect(printersRepository.getById(created.id)!.snmpSecret).toBe(JSON.stringify({ community: SECRET }));

    // E um PATCH que manda `snmp` realmente grava o novo segredo.
    const novo = 'segredo-trocado-via-patch';
    const res = await app.inject({
      method: 'PATCH',
      url: `/printers/${created.id}`,
      headers: auth,
      payload: { snmp: { version: 'v2c', community: novo } },
    });
    expect(res.statusCode).toBe(200);
    assertNoSecretLeak(res.json(), novo);
    expect(printersRepository.getById(created.id)!.snmpSecret).toBe(JSON.stringify({ community: novo }));

    await app.close();
  });

  it('rejeita trocar a versão para v3 sem enviar v3Auth (mesma regra do POST)', async () => {
    const { app, token } = await authedApp();
    const auth = { authorization: `Bearer ${token}` };

    const created = (
      await app.inject({
        method: 'POST',
        url: '/printers',
        headers: auth,
        payload: { ...validBody, name: 'v1 para v3', mac: 'aa:bb:cc:00:99:aa' },
      })
    ).json();

    const res = await app.inject({
      method: 'PATCH',
      url: `/printers/${created.id}`,
      headers: auth,
      payload: { snmp: { version: 'v3' } },
    });
    expect(res.statusCode).toBe(400);

    // E o registro seguiu intacto (versão e segredo antigos preservados).
    expect(printersRepository.getById(created.id)!.snmpVersion).toBe('v2c');
    expect(printersRepository.getById(created.id)!.snmpSecret).toBe(JSON.stringify({ community: SECRET }));

    await app.close();
  });
});

describe('404s', () => {
  it('GET /printers/:id inexistente retorna 404', async () => {
    const { app, token } = await authedApp();
    const res = await app.inject({
      method: 'GET',
      url: '/printers/nao-existe',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('PATCH /printers/:id inexistente retorna 404', async () => {
    const { app, token } = await authedApp();
    const res = await app.inject({
      method: 'PATCH',
      url: '/printers/nao-existe',
      headers: { authorization: `Bearer ${token}` },
      payload: { name: 'x' },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });

  it('DELETE /printers/:id inexistente retorna 404', async () => {
    const { app, token } = await authedApp();
    const res = await app.inject({
      method: 'DELETE',
      url: '/printers/nao-existe',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('vazamento do segredo SNMP — checagem agregada final', () => {
  it('nenhuma das respostas coletadas ao longo da suíte contém qualquer segredo fornecido', () => {
    // Reforça (contra o corpo bruto serializado, não contra o schema) que
    // em NENHUMA resposta acumulada (POST, GET lista, GET individual,
    // PATCH) apareceu algum dos segredos usados nos testes acima.
    expect(allResponseBodies.length).toBeGreaterThan(0);
    const secrets = [SECRET, 'senha-de-autenticacao-v3', 'outro-segredo-completamente-diferente'];
    for (const body of allResponseBodies) {
      const serialized = JSON.stringify(body);
      for (const secret of secrets) {
        expect(serialized).not.toContain(secret);
      }
    }
  });
});
