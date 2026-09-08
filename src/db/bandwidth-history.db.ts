import { createRequire } from 'node:module';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';

// Mesma armadilha documentada em src/db/printers.db.ts: `node:sqlite` ainda
// não é reconhecido estaticamente pelo Vite/vitest, então o import precisa
// passar pelo `require` nativo do Node via createRequire — funciona igual em
// produção (tsx/node puro) e nos testes (vitest).
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

// Segundo banco persistido em disco do projeto (o primeiro foi
// src/db/printers.db.ts). Arquivo PRÓPRIO, separado de printers.db — são
// domínios diferentes (cadastro de impressoras vs. série temporal de uso de
// banda de QUALQUER device/cliente do UniFi, nada a ver com impressoras) e
// não há motivo pra acoplar o ciclo de vida dos dois arquivos.
//
// Retenção (decisão aprovada pelo usuário nesta sessão, ver CLAUDE.md):
// - `bandwidth_samples` guarda o grão fino (uma linha por device/cliente a
//   cada ciclo de 5 min do poller) só pelas últimas 48h. Depois disso, cada
//   janela de 1h é resumida (ver `bandwidth_hourly_rollup` abaixo) e as
//   amostras finas daquela janela são apagadas — manter granularidade de 5
//   min para sempre cresceria sem limite (um device/cliente a cada 5 min,
//   indefinidamente).
// - `bandwidth_hourly_rollup` guarda o AGREGADO por hora (delta de uso
//   NAQUELA hora, não o valor cumulativo cru — o cru vira inútil assim que
//   as amostras finas de origem somem) por até 30 dias, depois descartado.
//
// Não há sistema de migração formal (mesma decisão de printers.db.ts) — o
// `CREATE TABLE IF NOT EXISTS` abaixo é idempotente.

export type BandwidthScope = 'device' | 'client';

export interface InsertSampleInput {
  collectedAt: string;
  scope: BandwidthScope;
  mac: string;
  label: string;
  rxBytes: number;
  txBytes: number;
}

export interface BandwidthSampleRow {
  id: number;
  collectedAt: string;
  scope: BandwidthScope;
  mac: string;
  label: string;
  rxBytes: number;
  txBytes: number;
}

export interface InsertHourlyRollupInput {
  hourStart: string;
  scope: BandwidthScope;
  mac: string;
  label: string;
  // `null` explícito quando o contador reiniciou dentro da hora (mesma regra
  // de diffCounter em bandwidth-history.service.ts) — nunca descartamos a
  // linha, só marcamos a hora como "sem dado confiável de uso".
  rxBytesDelta: number | null;
  txBytesDelta: number | null;
}

export interface HourlyRollupRow {
  hourStart: string;
  scope: BandwidthScope;
  mac: string;
  label: string;
  rxBytesDelta: number | null;
  txBytesDelta: number | null;
}

export interface RangeFilter {
  mac?: string;
  from: string;
  to: string;
}

interface SampleRowRaw {
  id: number;
  collected_at: string;
  scope: string;
  mac: string;
  label: string;
  rx_bytes: number;
  tx_bytes: number;
}

interface RollupRowRaw {
  hour_start: string;
  scope: string;
  mac: string;
  label: string;
  rx_bytes_delta: number | null;
  tx_bytes_delta: number | null;
}

function sampleRowToRecord(row: SampleRowRaw): BandwidthSampleRow {
  return {
    id: row.id,
    collectedAt: row.collected_at,
    scope: row.scope as BandwidthScope,
    mac: row.mac,
    label: row.label,
    rxBytes: row.rx_bytes,
    txBytes: row.tx_bytes,
  };
}

function rollupRowToRecord(row: RollupRowRaw): HourlyRollupRow {
  return {
    hourStart: row.hour_start,
    scope: row.scope as BandwidthScope,
    mac: row.mac,
    label: row.label,
    rxBytesDelta: row.rx_bytes_delta,
    txBytesDelta: row.tx_bytes_delta,
  };
}

export class BandwidthHistoryRepository {
  private readonly db: DatabaseSyncType;

  constructor(dbFile: string) {
    this.db = new DatabaseSync(dbFile);

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bandwidth_samples (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        collected_at TEXT NOT NULL,
        scope TEXT NOT NULL,
        mac TEXT NOT NULL,
        label TEXT NOT NULL,
        rx_bytes INTEGER NOT NULL,
        tx_bytes INTEGER NOT NULL
      )
    `);
    // Índice de limpeza por idade (o job de rollup varre/apaga por
    // collected_at) e índice de consulta por device/cliente específico
    // (usado tanto pelo rollup — agrupar por mac dentro de uma janela de
    // hora — quanto pelo endpoint de longo prazo, quando filtrado por mac).
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_bandwidth_samples_collected_at ON bandwidth_samples(collected_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_bandwidth_samples_mac ON bandwidth_samples(mac, collected_at)');

    this.db.exec(`
      CREATE TABLE IF NOT EXISTS bandwidth_hourly_rollup (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        hour_start TEXT NOT NULL,
        scope TEXT NOT NULL,
        mac TEXT NOT NULL,
        label TEXT NOT NULL,
        rx_bytes_delta INTEGER,
        tx_bytes_delta INTEGER
      )
    `);
    // Unicidade por (hour_start, scope, mac): o job de rollup roda 1x/dia,
    // mas pode reprocessar a mesma janela de hora se uma execução anterior
    // tiver conseguido inserir o rollup mas falhado antes de apagar as
    // amostras finas de origem (ver comentário em runRollupAndCleanup). O
    // índice único + `INSERT OR IGNORE` (ver insertHourlyRollup) tornam essa
    // reexecução idempotente, sem linha duplicada para a mesma hora/mac.
    this.db.exec(
      'CREATE UNIQUE INDEX IF NOT EXISTS idx_bandwidth_rollup_hour_scope_mac ON bandwidth_hourly_rollup(hour_start, scope, mac)',
    );
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_bandwidth_rollup_hour_start ON bandwidth_hourly_rollup(hour_start)');
  }

  insertSample(input: InsertSampleInput): void {
    this.db
      .prepare(
        `INSERT INTO bandwidth_samples (collected_at, scope, mac, label, rx_bytes, tx_bytes)
         VALUES ($collected_at, $scope, $mac, $label, $rx_bytes, $tx_bytes)`,
      )
      .run({
        collected_at: input.collectedAt,
        scope: input.scope,
        mac: input.mac,
        label: input.label,
        rx_bytes: input.rxBytes,
        tx_bytes: input.txBytes,
      });
  }

  // Ordenado por (scope, mac, collected_at) — essa ordem é o que permite ao
  // job de rollup (bandwidth-history.service.ts) varrer o resultado uma
  // única vez e agrupar por device/cliente/hora sem precisar reordenar em
  // memória: amostras do mesmo scope+mac ficam contíguas, e dentro delas em
  // ordem cronológica.
  listSamplesOlderThan(cutoffIso: string): BandwidthSampleRow[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM bandwidth_samples WHERE collected_at < $cutoff
         ORDER BY scope ASC, mac ASC, collected_at ASC`,
      )
      .all({ cutoff: cutoffIso }) as unknown as SampleRowRaw[];
    return rows.map(sampleRowToRecord);
  }

  deleteSamplesOlderThan(cutoffIso: string): number {
    const result = this.db.prepare('DELETE FROM bandwidth_samples WHERE collected_at < $cutoff').run({
      cutoff: cutoffIso,
    });
    return Number(result.changes);
  }

  // `INSERT OR IGNORE`: se já existe uma linha para (hour_start, scope, mac)
  // — ver índice único no construtor —, a inserção é silenciosamente
  // ignorada em vez de lançar (idempotência do job diário, ver comentário no
  // construtor).
  insertHourlyRollup(input: InsertHourlyRollupInput): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO bandwidth_hourly_rollup
          (hour_start, scope, mac, label, rx_bytes_delta, tx_bytes_delta)
         VALUES ($hour_start, $scope, $mac, $label, $rx_bytes_delta, $tx_bytes_delta)`,
      )
      .run({
        hour_start: input.hourStart,
        scope: input.scope,
        mac: input.mac,
        label: input.label,
        rx_bytes_delta: input.rxBytesDelta,
        tx_bytes_delta: input.txBytesDelta,
      } as Record<string, SQLInputValue>);
  }

  deleteHourlyRollupsOlderThan(cutoffIso: string): number {
    const result = this.db.prepare('DELETE FROM bandwidth_hourly_rollup WHERE hour_start < $cutoff').run({
      cutoff: cutoffIso,
    });
    return Number(result.changes);
  }

  // Usado pelo endpoint de longo prazo para o trecho recente (até 48h) —
  // filtro opcional por mac, sempre limitado por uma janela [from, to].
  listSamples(filter: RangeFilter): BandwidthSampleRow[] {
    const rows = filter.mac
      ? (this.db
          .prepare(
            `SELECT * FROM bandwidth_samples
             WHERE collected_at >= $from AND collected_at <= $to AND mac = $mac
             ORDER BY collected_at ASC`,
          )
          .all({ from: filter.from, to: filter.to, mac: filter.mac }) as unknown as SampleRowRaw[])
      : (this.db
          .prepare(
            `SELECT * FROM bandwidth_samples
             WHERE collected_at >= $from AND collected_at <= $to
             ORDER BY collected_at ASC`,
          )
          .all({ from: filter.from, to: filter.to }) as unknown as SampleRowRaw[]);
    return rows.map(sampleRowToRecord);
  }

  // Usado pelo endpoint de longo prazo para o trecho mais antigo (>48h, já
  // resumido por hora).
  listHourlyRollups(filter: RangeFilter): HourlyRollupRow[] {
    const rows = filter.mac
      ? (this.db
          .prepare(
            `SELECT * FROM bandwidth_hourly_rollup
             WHERE hour_start >= $from AND hour_start <= $to AND mac = $mac
             ORDER BY hour_start ASC`,
          )
          .all({ from: filter.from, to: filter.to, mac: filter.mac }) as unknown as RollupRowRaw[])
      : (this.db
          .prepare(
            `SELECT * FROM bandwidth_hourly_rollup
             WHERE hour_start >= $from AND hour_start <= $to
             ORDER BY hour_start ASC`,
          )
          .all({ from: filter.from, to: filter.to }) as unknown as RollupRowRaw[]);
    return rows.map(rollupRowToRecord);
  }

  close(): void {
    this.db.close();
  }
}

export function createBandwidthHistoryRepository(dbFile: string): BandwidthHistoryRepository {
  return new BandwidthHistoryRepository(dbFile);
}
