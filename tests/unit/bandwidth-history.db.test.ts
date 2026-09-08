import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createBandwidthHistoryRepository, type BandwidthHistoryRepository } from '../../src/db/bandwidth-history.db.js';

// Mesmo padrão de tests/unit/printers.db.test.ts: um arquivo SQLite real
// (não `:memory:`) por teste, num diretório temporário próprio, removido no
// afterEach — prova que os dados sobrevivem a um "restart" de verdade.
let tmpDir: string | undefined;
let openRepos: BandwidthHistoryRepository[] = [];

function newRepo(): BandwidthHistoryRepository {
  tmpDir = mkdtempSync(join(tmpdir(), 'bandwidth-history-db-test-'));
  const repo = createBandwidthHistoryRepository(join(tmpDir, 'bandwidth-history.db'));
  openRepos.push(repo);
  return repo;
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

describe('BandwidthHistoryRepository — amostras finas', () => {
  it('grava e lê de volta uma amostra', () => {
    const repo = newRepo();

    repo.insertSample({
      collectedAt: '2026-08-01T10:00:00.000Z',
      scope: 'device',
      mac: 'aa:bb:cc:dd:ee:ff',
      label: 'AP Sala',
      rxBytes: 1000,
      txBytes: 500,
    });

    const rows = repo.listSamples({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-01T23:59:59.999Z' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      collectedAt: '2026-08-01T10:00:00.000Z',
      scope: 'device',
      mac: 'aa:bb:cc:dd:ee:ff',
      label: 'AP Sala',
      rxBytes: 1000,
      txBytes: 500,
    });
  });

  it('listSamples filtra por mac e por janela [from, to]', () => {
    const repo = newRepo();
    repo.insertSample({
      collectedAt: '2026-08-01T10:00:00.000Z',
      scope: 'client',
      mac: '11:22:33:44:55:66',
      label: 'iPhone',
      rxBytes: 100,
      txBytes: 50,
    });
    repo.insertSample({
      collectedAt: '2026-08-01T10:05:00.000Z',
      scope: 'client',
      mac: 'aa:aa:aa:aa:aa:aa',
      label: 'Outro',
      rxBytes: 10,
      txBytes: 5,
    });
    repo.insertSample({
      collectedAt: '2026-08-02T10:00:00.000Z',
      scope: 'client',
      mac: '11:22:33:44:55:66',
      label: 'iPhone',
      rxBytes: 200,
      txBytes: 100,
    });

    const filteredByMac = repo.listSamples({
      mac: '11:22:33:44:55:66',
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-03T00:00:00.000Z',
    });
    expect(filteredByMac).toHaveLength(2);
    expect(filteredByMac.every((r) => r.mac === '11:22:33:44:55:66')).toBe(true);

    const filteredByWindow = repo.listSamples({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-01T23:59:59.999Z',
    });
    expect(filteredByWindow).toHaveLength(2);
  });

  it('listSamplesOlderThan retorna ordenado por (scope, mac, collected_at)', () => {
    const repo = newRepo();
    repo.insertSample({
      collectedAt: '2026-08-01T10:05:00.000Z',
      scope: 'device',
      mac: 'aa:bb',
      label: 'A',
      rxBytes: 200,
      txBytes: 100,
    });
    repo.insertSample({
      collectedAt: '2026-08-01T10:00:00.000Z',
      scope: 'device',
      mac: 'aa:bb',
      label: 'A',
      rxBytes: 100,
      txBytes: 50,
    });
    repo.insertSample({
      collectedAt: '2026-08-01T10:00:00.000Z',
      scope: 'client',
      mac: 'zz:zz',
      label: 'B',
      rxBytes: 5,
      txBytes: 5,
    });

    const rows = repo.listSamplesOlderThan('2026-09-01T00:00:00.000Z');
    expect(rows.map((r) => `${r.scope}|${r.mac}|${r.collectedAt}`)).toEqual([
      'client|zz:zz|2026-08-01T10:00:00.000Z',
      'device|aa:bb|2026-08-01T10:00:00.000Z',
      'device|aa:bb|2026-08-01T10:05:00.000Z',
    ]);
  });

  it('deleteSamplesOlderThan apaga só as amostras mais antigas que o corte', () => {
    const repo = newRepo();
    repo.insertSample({
      collectedAt: '2026-08-01T00:00:00.000Z',
      scope: 'device',
      mac: 'aa:bb',
      label: 'A',
      rxBytes: 1,
      txBytes: 1,
    });
    repo.insertSample({
      collectedAt: '2026-08-05T00:00:00.000Z',
      scope: 'device',
      mac: 'aa:bb',
      label: 'A',
      rxBytes: 2,
      txBytes: 2,
    });

    const deleted = repo.deleteSamplesOlderThan('2026-08-03T00:00:00.000Z');
    expect(deleted).toBe(1);

    const remaining = repo.listSamples({ from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].collectedAt).toBe('2026-08-05T00:00:00.000Z');
  });
});

describe('BandwidthHistoryRepository — rollup horário', () => {
  it('grava e lê de volta um rollup, incluindo delta null (reset de contador)', () => {
    const repo = newRepo();

    repo.insertHourlyRollup({
      hourStart: '2026-08-01T10:00:00.000Z',
      scope: 'device',
      mac: 'aa:bb',
      label: 'AP Sala',
      rxBytesDelta: 500,
      txBytesDelta: null,
    });

    const rows = repo.listHourlyRollups({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      hourStart: '2026-08-01T10:00:00.000Z',
      scope: 'device',
      mac: 'aa:bb',
      label: 'AP Sala',
      rxBytesDelta: 500,
      txBytesDelta: null,
    });
  });

  it('índice único (hour_start, scope, mac): segunda inserção para a mesma chave é ignorada', () => {
    const repo = newRepo();

    repo.insertHourlyRollup({
      hourStart: '2026-08-01T10:00:00.000Z',
      scope: 'device',
      mac: 'aa:bb',
      label: 'AP Sala',
      rxBytesDelta: 500,
      txBytesDelta: 200,
    });
    // Mesma (hour_start, scope, mac) com valores diferentes — deve ser
    // ignorada silenciosamente (INSERT OR IGNORE), não sobrescrever nem
    // lançar.
    repo.insertHourlyRollup({
      hourStart: '2026-08-01T10:00:00.000Z',
      scope: 'device',
      mac: 'aa:bb',
      label: 'AP Sala (renomeada)',
      rxBytesDelta: 999,
      txBytesDelta: 999,
    });

    const rows = repo.listHourlyRollups({ from: '2026-08-01T00:00:00.000Z', to: '2026-08-02T00:00:00.000Z' });
    expect(rows).toHaveLength(1);
    expect(rows[0].rxBytesDelta).toBe(500);
    expect(rows[0].label).toBe('AP Sala');
  });

  it('listHourlyRollups filtra por mac e por janela [from, to]', () => {
    const repo = newRepo();
    repo.insertHourlyRollup({
      hourStart: '2026-08-01T10:00:00.000Z',
      scope: 'device',
      mac: 'aa:bb',
      label: 'A',
      rxBytesDelta: 1,
      txBytesDelta: 1,
    });
    repo.insertHourlyRollup({
      hourStart: '2026-08-01T10:00:00.000Z',
      scope: 'client',
      mac: 'cc:dd',
      label: 'B',
      rxBytesDelta: 2,
      txBytesDelta: 2,
    });
    repo.insertHourlyRollup({
      hourStart: '2026-09-01T10:00:00.000Z',
      scope: 'device',
      mac: 'aa:bb',
      label: 'A',
      rxBytesDelta: 3,
      txBytesDelta: 3,
    });

    const byMac = repo.listHourlyRollups({
      mac: 'aa:bb',
      from: '2026-01-01T00:00:00.000Z',
      to: '2026-12-31T00:00:00.000Z',
    });
    expect(byMac).toHaveLength(2);
    expect(byMac.every((r) => r.mac === 'aa:bb')).toBe(true);

    const byWindow = repo.listHourlyRollups({
      from: '2026-08-01T00:00:00.000Z',
      to: '2026-08-31T00:00:00.000Z',
    });
    expect(byWindow).toHaveLength(2);
  });

  it('deleteHourlyRollupsOlderThan apaga só os rollups mais antigos que o corte', () => {
    const repo = newRepo();
    repo.insertHourlyRollup({
      hourStart: '2026-07-01T00:00:00.000Z',
      scope: 'device',
      mac: 'aa:bb',
      label: 'A',
      rxBytesDelta: 1,
      txBytesDelta: 1,
    });
    repo.insertHourlyRollup({
      hourStart: '2026-08-01T00:00:00.000Z',
      scope: 'device',
      mac: 'aa:bb',
      label: 'A',
      rxBytesDelta: 2,
      txBytesDelta: 2,
    });

    const deleted = repo.deleteHourlyRollupsOlderThan('2026-07-15T00:00:00.000Z');
    expect(deleted).toBe(1);

    const remaining = repo.listHourlyRollups({ from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' });
    expect(remaining).toHaveLength(1);
    expect(remaining[0].hourStart).toBe('2026-08-01T00:00:00.000Z');
  });
});

describe('BandwidthHistoryRepository — persistência entre "restarts"', () => {
  it('sobrevive a fechar a conexão e reabrir outra apontando pro mesmo arquivo', () => {
    const repo = newRepo();
    repo.insertSample({
      collectedAt: '2026-08-01T10:00:00.000Z',
      scope: 'device',
      mac: 'aa:bb',
      label: 'A',
      rxBytes: 1,
      txBytes: 1,
    });
    repo.insertHourlyRollup({
      hourStart: '2026-08-01T00:00:00.000Z',
      scope: 'device',
      mac: 'aa:bb',
      label: 'A',
      rxBytesDelta: 5,
      txBytesDelta: 5,
    });
    repo.close();
    openRepos = [];

    const dbFile = join(tmpDir!, 'bandwidth-history.db');
    const reopened = createBandwidthHistoryRepository(dbFile);
    openRepos.push(reopened);

    expect(reopened.listSamples({ from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' })).toHaveLength(
      1,
    );
    expect(
      reopened.listHourlyRollups({ from: '2026-01-01T00:00:00.000Z', to: '2026-12-31T00:00:00.000Z' }),
    ).toHaveLength(1);
  });
});
