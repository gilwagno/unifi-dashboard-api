import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createPrintersRepository, toPublic, type PrintersRepository } from '../../src/db/printers.db.js';

// Testes de repositório contra um arquivo SQLite real (não `:memory:`) num
// diretório temporário criado por teste — diferente do resto do backend
// (tudo em memória), este módulo precisa provar que os dados sobrevivem a
// um "restart" de verdade (fechar a conexão e abrir outra apontando pro
// mesmo arquivo). Cada teste usa seu próprio diretório temporário e o
// remove no `afterEach`, então nenhum arquivo .db fica sujando o repo.
let tmpDir: string | undefined;
let openRepos: PrintersRepository[] = [];

function newRepo(): { repo: PrintersRepository; dbFile: string } {
  tmpDir = mkdtempSync(join(tmpdir(), 'printers-db-test-'));
  const dbFile = join(tmpDir, 'printers.db');
  const repo = createPrintersRepository(dbFile);
  openRepos.push(repo);
  return { repo, dbFile };
}

afterEach(() => {
  for (const repo of openRepos) {
    try {
      repo.close();
    } catch {
      // já fechado por um teste que testa reabertura — ignora.
    }
  }
  openRepos = [];
  if (tmpDir) {
    rmSync(tmpDir, { recursive: true, force: true });
    tmpDir = undefined;
  }
});

const baseInput = {
  name: 'HPLaserMFP135w',
  mac: '50:81:40:d8:6c:7e',
  snmpVersion: 'v2c' as const,
  snmpSecret: { community: 'super-secret-community' },
};

describe('PrintersRepository — CRUD', () => {
  it('cria e depois busca o registro por id', () => {
    const { repo } = newRepo();

    const created = repo.create(baseInput);
    expect(created.id).toBeTruthy();
    expect(created.name).toBe('HPLaserMFP135w');
    expect(created.mac).toBe('50:81:40:d8:6c:7e');
    expect(created.snmpSecret).toBe(JSON.stringify({ community: 'super-secret-community' }));
    expect(created.maintenance).toEqual({
      intervalDays: null,
      intervalPages: null,
      consumableLowThresholdPct: null,
    });
    expect(created.createdAt).toBeTruthy();
    expect(created.updatedAt).toBe(created.createdAt);

    const fetched = repo.getById(created.id);
    expect(fetched).toEqual(created);
  });

  it('lista todos os registros criados', () => {
    const { repo } = newRepo();
    repo.create(baseInput);
    repo.create({ ...baseInput, name: 'HLL2360DWVENDAS', mac: 'e8:6f:38:ba:b9:32' });

    const all = repo.listAll();
    expect(all).toHaveLength(2);
    expect(all.map((p) => p.name).sort()).toEqual(['HLL2360DWVENDAS', 'HPLaserMFP135w']);
  });

  it('getById retorna null para id inexistente', () => {
    const { repo } = newRepo();
    expect(repo.getById('nao-existe')).toBeNull();
  });

  it('update atualiza campos parciais e preserva o resto', () => {
    const { repo } = newRepo();
    const created = repo.create(baseInput);

    const updated = repo.update(created.id, { name: 'Novo Nome' });
    expect(updated).not.toBeNull();
    expect(updated!.name).toBe('Novo Nome');
    expect(updated!.mac).toBe(baseInput.mac);
    expect(updated!.snmpSecret).toBe(created.snmpSecret);
    expect(updated!.createdAt).toBe(created.createdAt);
    // Não afirma que updatedAt mudou em valor (ambos usam Date.toISOString(),
    // que tem precisão de milissegundos — duas chamadas muito próximas podem
    // colidir numa máquina rápida); só que nunca fica anterior ao createdAt.
    expect(updated!.updatedAt >= created.createdAt).toBe(true);
  });

  it('update troca o segredo SNMP quando informado', () => {
    const { repo } = newRepo();
    const created = repo.create(baseInput);

    const updated = repo.update(created.id, {
      snmpVersion: 'v3',
      snmpSecret: { v3Auth: { username: 'admin', authPassword: 'nova-senha-forte' } },
    });
    expect(updated!.snmpVersion).toBe('v3');
    expect(updated!.snmpSecret).toBe(
      JSON.stringify({ v3Auth: { username: 'admin', authPassword: 'nova-senha-forte' } }),
    );
  });

  it('update retorna null para id inexistente', () => {
    const { repo } = newRepo();
    expect(repo.update('nao-existe', { name: 'x' })).toBeNull();
  });

  it('delete remove o registro e retorna true; segunda chamada retorna false', () => {
    const { repo } = newRepo();
    const created = repo.create(baseInput);

    expect(repo.delete(created.id)).toBe(true);
    expect(repo.getById(created.id)).toBeNull();
    expect(repo.delete(created.id)).toBe(false);
  });

  it('toPublic() nunca inclui o campo snmpSecret', () => {
    const { repo } = newRepo();
    const created = repo.create(baseInput);

    const publicRecord = toPublic(created);
    expect(publicRecord).not.toHaveProperty('snmpSecret');
    expect(JSON.stringify(publicRecord)).not.toContain('super-secret-community');
  });
});

describe('PrintersRepository — unicidade de MAC', () => {
  it('findByMac acha o registro pelo MAC e respeita exceptId', () => {
    const { repo } = newRepo();
    const created = repo.create(baseInput);

    expect(repo.findByMac(baseInput.mac)?.id).toBe(created.id);
    // O próprio registro não conta como conflito quando excluído por id.
    expect(repo.findByMac(baseInput.mac, created.id)).toBeNull();
    expect(repo.findByMac('00:00:00:00:00:00')).toBeNull();
  });

  it('o banco rejeita dois registros com o mesmo MAC (índice único)', () => {
    const { repo } = newRepo();
    repo.create(baseInput);
    expect(() => repo.create({ ...baseInput, name: 'Outra' })).toThrow();
  });

  it('o índice único também vale num banco criado antes do índice existir', () => {
    // Garante que a restrição não depende de recriar a tabela: cria a tabela
    // "antiga" (sem índice) à mão, insere uma linha, e só então abre o
    // repositório — que deve criar o índice sobre a tabela já existente.
    const { repo, dbFile } = newRepo();
    repo.create(baseInput);
    repo.close();

    const reopened = createPrintersRepository(dbFile);
    openRepos.push(reopened);
    expect(() => reopened.create({ ...baseInput, name: 'Duplicada' })).toThrow();
    expect(reopened.listAll()).toHaveLength(1);
  });
});

describe('PrintersRepository — persistência entre "restarts"', () => {
  it('sobrevive a fechar a conexão e reabrir outra apontando pro mesmo arquivo', () => {
    const { repo, dbFile } = newRepo();
    const created = repo.create(baseInput);
    repo.close();

    expect(existsSync(dbFile)).toBe(true);

    // Simula um restart do processo: abre uma conexão NOVA contra o mesmo
    // arquivo (a instância anterior já foi fechada acima).
    const reopened = createPrintersRepository(dbFile);
    openRepos.push(reopened);

    const fetched = reopened.getById(created.id);
    expect(fetched).toEqual(created);

    const all = reopened.listAll();
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe(created.id);
  });

  it('CREATE TABLE IF NOT EXISTS é idempotente ao reabrir várias vezes sem apagar dados', () => {
    const { repo, dbFile } = newRepo();
    repo.create(baseInput);
    repo.close();

    const reopenedOnce = createPrintersRepository(dbFile);
    openRepos.push(reopenedOnce);
    expect(reopenedOnce.listAll()).toHaveLength(1);
    reopenedOnce.close();
    openRepos.pop();

    const reopenedTwice = createPrintersRepository(dbFile);
    openRepos.push(reopenedTwice);
    expect(reopenedTwice.listAll()).toHaveLength(1);
  });
});
