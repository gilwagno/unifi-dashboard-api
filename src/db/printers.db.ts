import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import type { DatabaseSync as DatabaseSyncType, SQLInputValue } from 'node:sqlite';

// `node:sqlite` ainda não está na lista de built-ins que o Vite/vitest
// (usado pela suíte de testes) reconhece como módulo nativo do Node — um
// `import { DatabaseSync } from 'node:sqlite'` estático faz o vite-node
// tentar resolvê-lo como pacote npm e falhar ("Failed to load url sqlite").
// Usar `createRequire` busca o módulo via o `require` nativo do Node, que
// não passa pela transformação/resolução do Vite — funciona igual em
// produção (tsx/node puro) e nos testes (vitest). O import acima
// (`type DatabaseSync as DatabaseSyncType`) é só de tipos, apagado na
// compilação, então não sofre esse problema.
const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite') as { DatabaseSync: typeof DatabaseSyncType };

// Primeira tabela persistida em disco do projeto — o resto do backend
// (bandwidth-history.service.ts, unifi-events.hub.ts) é tudo estado em
// memória que se perde a cada restart, mas o cadastro de impressoras
// (nome, MAC, segredo SNMP, política de manutenção) precisa sobreviver a
// restarts do processo. Usa `node:sqlite` (módulo nativo do Node, estável
// a partir do Node 22.5 — ver bump de `engines.node` em package.json) em
// vez de trazer uma dependência externa (better-sqlite3 etc.) só pra isso.
//
// Não há sistema de migração formal ainda (é a primeira tabela) — o
// `CREATE TABLE IF NOT EXISTS` abaixo é idempotente e roda toda vez que o
// módulo é carregado, o que é suficiente enquanto o schema não precisar
// evoluir. Se/quando isso mudar, vale introduzir migrações versionadas.

export type SnmpVersion = 'v1' | 'v2c' | 'v3';

// Segredo SNMPv3 (auth/priv) — shape próprio deste módulo, não um padrão
// externo. Serializado como JSON dentro da coluna `snmp_secret` quando
// `snmp_version === 'v3'`.
export interface SnmpV3Auth {
  username: string;
  authProtocol?: 'MD5' | 'SHA';
  authPassword?: string;
  privProtocol?: 'DES' | 'AES';
  privPassword?: string;
}

// O "segredo" SNMP tal como aceito na escrita (POST/PATCH): para v1/v2c é
// a community string; para v3 é o bloco de credenciais auth/priv acima.
// Nunca é devolvido em nenhuma resposta de leitura (GET/POST/PATCH) — ver
// src/routes/printers.routes.ts.
export type SnmpSecretInput = { community: string } | { v3Auth: SnmpV3Auth };

export interface PrinterMaintenancePolicy {
  intervalDays: number | null;
  intervalPages: number | null;
  consumableLowThresholdPct: number | null;
}

// Registro completo, incluindo o segredo — uso interno do repositório e do
// futuro poller SNMP (subtarefas seguintes da Onda 2). Rotas HTTP nunca
// devem serializar este tipo diretamente: usar PrinterPublic (sem
// `snmpSecret`) nas respostas.
export interface PrinterRecord {
  id: string;
  name: string;
  mac: string;
  ipOverride: string | null;
  snmpVersion: SnmpVersion;
  // JSON serializado de SnmpSecretInput — nunca exposto via API.
  snmpSecret: string;
  maintenance: PrinterMaintenancePolicy;
  createdAt: string;
  updatedAt: string;
}

export type PrinterPublic = Omit<PrinterRecord, 'snmpSecret'>;

export interface CreatePrinterInput {
  name: string;
  mac: string;
  ipOverride?: string | null;
  snmpVersion: SnmpVersion;
  snmpSecret: SnmpSecretInput;
  maintenance?: Partial<PrinterMaintenancePolicy>;
}

export interface UpdatePrinterInput {
  name?: string;
  mac?: string;
  ipOverride?: string | null;
  snmpVersion?: SnmpVersion;
  snmpSecret?: SnmpSecretInput;
  maintenance?: Partial<PrinterMaintenancePolicy>;
}

interface PrinterRow {
  id: string;
  name: string;
  mac: string;
  ip_override: string | null;
  snmp_version: string;
  snmp_secret: string;
  maintenance_interval_days: number | null;
  maintenance_interval_pages: number | null;
  consumable_low_threshold_pct: number | null;
  created_at: string;
  updated_at: string;
}

function rowToRecord(row: PrinterRow): PrinterRecord {
  return {
    id: row.id,
    name: row.name,
    mac: row.mac,
    ipOverride: row.ip_override,
    snmpVersion: row.snmp_version as SnmpVersion,
    snmpSecret: row.snmp_secret,
    maintenance: {
      intervalDays: row.maintenance_interval_days,
      intervalPages: row.maintenance_interval_pages,
      consumableLowThresholdPct: row.consumable_low_threshold_pct,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function toPublic(record: PrinterRecord): PrinterPublic {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { snmpSecret, ...publicFields } = record;
  return publicFields;
}

// --- Histórico de manutenção realizada (Onda 2, subtarefa 8) ---
//
// Um evento = uma manutenção que foi feita de verdade (troca de toner,
// limpeza, etc.), registrada manualmente por quem administra o dashboard —
// não confundir com `PrinterMaintenancePolicy` acima, que é a CONFIGURAÇÃO
// de intervalo (a cada quantos dias/páginas a manutenção deveria acontecer).
// O histórico é o que permite calcular "a próxima manutenção está devida",
// somando a política à data/contador do último evento.
export interface PrinterMaintenanceEvent {
  id: string;
  printerId: string;
  performedAt: string;
  note: string | null;
  pageCountAtMaintenance: number | null;
  createdAt: string;
}

export interface CreateMaintenanceEventInput {
  performedAt?: string;
  note?: string | null;
  pageCountAtMaintenance?: number | null;
}

interface MaintenanceEventRow {
  id: string;
  printer_id: string;
  performed_at: string;
  note: string | null;
  page_count_at_maintenance: number | null;
  created_at: string;
}

function maintenanceRowToRecord(row: MaintenanceEventRow): PrinterMaintenanceEvent {
  return {
    id: row.id,
    printerId: row.printer_id,
    performedAt: row.performed_at,
    note: row.note,
    pageCountAtMaintenance: row.page_count_at_maintenance,
    createdAt: row.created_at,
  };
}

// --- Histórico de leituras SNMP (Onda 2, subtarefa 12) ---
//
// Diferente do buffer em memória `lastReadings` de printer-snmp.service.ts
// (que guarda só a ÚLTIMA leitura de cada impressora, para /consumables e
// /diagnostics), esta tabela guarda UMA LINHA POR LEITURA SNMP bem-sucedida
// do poller — a série temporal que permite ver tendência (ex.: quanto o
// toner caiu na última semana, ritmo de impressão). Tabela irmã de
// `printer_maintenance_events`, mesmo padrão (sem FK formal, existência da
// impressora validada na rota antes de qualquer escrita/leitura por
// printer_id).
//
// `id` é INTEGER PRIMARY KEY AUTOINCREMENT (não UUID): esta tabela só cresce
// (uma linha a cada ciclo de 15 min do poller, por impressora) e é podada
// por idade (ver `deleteSnmpHistoryOlderThan`) — mesmo raciocínio de
// custo/volume de `bandwidth_samples` em bandwidth-history.db.ts, onde um
// identificador sequencial e mais barato que um UUID já é suficiente (nunca
// é referenciado por fora deste módulo).
export interface PrinterSnmpHistorySupply {
  name: string;
  levelPercent: number | null;
}

export interface RecordSnmpHistoryInput {
  // Mesmo timestamp que já está em PrinterSnmpReading.collectedAt (o
  // chamador não deve gerar um `new Date()` novo aqui — ver
  // printer-snmp.service.ts).
  collectedAt: string;
  pageCount: number | null;
  supplies: PrinterSnmpHistorySupply[];
  partial: boolean;
}

export interface PrinterSnmpHistoryEntry {
  id: number;
  printerId: string;
  collectedAt: string;
  pageCount: number | null;
  supplies: PrinterSnmpHistorySupply[];
  partial: boolean;
}

export interface SnmpHistoryRangeFilter {
  from?: string;
  to?: string;
}

interface SnmpHistoryRow {
  id: number;
  printer_id: string;
  collected_at: string;
  page_count: number | null;
  supplies_json: string;
  partial: number;
}

function snmpHistoryRowToRecord(row: SnmpHistoryRow): PrinterSnmpHistoryEntry {
  return {
    id: row.id,
    printerId: row.printer_id,
    collectedAt: row.collected_at,
    pageCount: row.page_count,
    // `supplies_json` é sempre escrito por `recordSnmpHistoryEntry` (nunca
    // por fora deste módulo), então o parse não deveria falhar em uso
    // normal — mas uma linha corrompida/editada manualmente não pode
    // derrubar a listagem inteira, então degrada para lista vazia em vez de
    // propagar a exceção do JSON.parse.
    supplies: (() => {
      try {
        return JSON.parse(row.supplies_json) as PrinterSnmpHistorySupply[];
      } catch {
        return [];
      }
    })(),
    partial: row.partial === 1,
  };
}

export class PrintersRepository {
  private readonly db: DatabaseSyncType;

  constructor(dbFile: string) {
    this.db = new DatabaseSync(dbFile);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS printers (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        mac TEXT NOT NULL,
        ip_override TEXT,
        snmp_version TEXT NOT NULL,
        snmp_secret TEXT NOT NULL,
        maintenance_interval_days INTEGER,
        maintenance_interval_pages INTEGER,
        consumable_low_threshold_pct REAL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      )
    `);

    // O MAC é a chave de negócio real da impressora: a subtarefa 2 da Onda 2
    // (merge com o status do UniFi) casa o cadastro com o cliente do
    // controller pelo MAC. Dois registros com o mesmo MAC tornariam esse
    // merge ambíguo (e duplicariam alertas de manutenção), então o banco
    // garante unicidade. Índice separado (em vez de `UNIQUE` na coluna) para
    // que a restrição também valha em bancos criados antes desta versão —
    // `CREATE TABLE IF NOT EXISTS` não altera uma tabela já existente, mas
    // `CREATE UNIQUE INDEX IF NOT EXISTS` sim. Os MACs são normalizados para
    // minúsculas na camada de rota, então a comparação binária basta.
    this.db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_printers_mac ON printers(mac)');

    // Tabela do histórico de manutenção (subtarefa 8) — mesma conexão/mesmo
    // arquivo da tabela `printers` (é a primeira "tabela irmã" do projeto;
    // não há necessidade de uma classe/repositório separado só por isso,
    // dado que hoje é um único arquivo SQLite sem múltiplos repositórios).
    // Sem `FOREIGN KEY` formal (mesmo estilo do resto do schema, sem
    // migração formal ainda) — a existência da impressora é validada na
    // camada de aplicação (rota) antes de inserir um evento.
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS printer_maintenance_events (
        id TEXT PRIMARY KEY,
        printer_id TEXT NOT NULL,
        performed_at TEXT NOT NULL,
        note TEXT,
        page_count_at_maintenance INTEGER,
        created_at TEXT NOT NULL
      )
    `);

    // Listado por impressora o tempo todo (GET /printers/:id/maintenance) —
    // sem índice, cada listagem faria table scan na tabela inteira.
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_maintenance_events_printer_id ON printer_maintenance_events(printer_id)',
    );

    // Tabela do histórico de leituras SNMP (subtarefa 12) — mesmo arquivo,
    // mesma conexão `this.db` (ver comentário acima de PrinterSnmpHistoryEntry:
    // é dado da mesma entidade "impressora", ao contrário do histórico de
    // banda, que é de domínio próprio e vive em bandwidth-history.db.ts).
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS printer_snmp_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        printer_id TEXT NOT NULL,
        collected_at TEXT NOT NULL,
        page_count INTEGER,
        supplies_json TEXT NOT NULL,
        partial INTEGER NOT NULL
      )
    `);
    // Consultado sempre por impressora + janela de tempo (GET
    // /printers/:id/history) e apagado sempre por idade (job de retenção
    // diário) — o mesmo índice composto serve os dois padrões de acesso,
    // igual a idx_bandwidth_samples_mac em bandwidth-history.db.ts.
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_snmp_history_printer_collected ON printer_snmp_history(printer_id, collected_at)',
    );

    // Índice de limpeza por idade — a rotina de retenção (90 dias, ver
    // printer-snmp.service.ts) apaga por collected_at sem filtrar por
    // impressora nenhuma; sem este índice seria table scan na tabela
    // inteira a cada execução diária.
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_snmp_history_collected_at ON printer_snmp_history(collected_at)');
  }

  // Usada pelas rotas para devolver 409 com mensagem própria em vez de
  // deixar o erro de constraint do SQLite virar 500. `exceptId` permite que
  // um PATCH reenvie o MAC que o próprio registro já tem.
  findByMac(mac: string, exceptId?: string): PrinterRecord | null {
    const row = this.db.prepare('SELECT * FROM printers WHERE mac = $mac AND id != $exceptId').get({
      mac,
      exceptId: exceptId ?? '',
    }) as PrinterRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  create(input: CreatePrinterInput): PrinterRecord {
    const now = new Date().toISOString();
    const row: PrinterRow = {
      id: randomUUID(),
      name: input.name,
      mac: input.mac,
      ip_override: input.ipOverride ?? null,
      snmp_version: input.snmpVersion,
      snmp_secret: JSON.stringify(input.snmpSecret),
      maintenance_interval_days: input.maintenance?.intervalDays ?? null,
      maintenance_interval_pages: input.maintenance?.intervalPages ?? null,
      consumable_low_threshold_pct: input.maintenance?.consumableLowThresholdPct ?? null,
      created_at: now,
      updated_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO printers (
          id, name, mac, ip_override, snmp_version, snmp_secret,
          maintenance_interval_days, maintenance_interval_pages, consumable_low_threshold_pct,
          created_at, updated_at
        ) VALUES (
          $id, $name, $mac, $ip_override, $snmp_version, $snmp_secret,
          $maintenance_interval_days, $maintenance_interval_pages, $consumable_low_threshold_pct,
          $created_at, $updated_at
        )`,
      )
      .run(row as unknown as Record<string, SQLInputValue>);

    return rowToRecord(row);
  }

  listAll(): PrinterRecord[] {
    const rows = this.db.prepare('SELECT * FROM printers ORDER BY created_at ASC').all() as unknown as PrinterRow[];
    return rows.map(rowToRecord);
  }

  getById(id: string): PrinterRecord | null {
    const row = this.db.prepare('SELECT * FROM printers WHERE id = $id').get({ id }) as PrinterRow | undefined;
    return row ? rowToRecord(row) : null;
  }

  update(id: string, patch: UpdatePrinterInput): PrinterRecord | null {
    const existing = this.getById(id);
    if (!existing) return null;

    const updated: PrinterRow = {
      id: existing.id,
      name: patch.name ?? existing.name,
      mac: patch.mac ?? existing.mac,
      ip_override: patch.ipOverride !== undefined ? patch.ipOverride : existing.ipOverride,
      snmp_version: patch.snmpVersion ?? existing.snmpVersion,
      snmp_secret: patch.snmpSecret ? JSON.stringify(patch.snmpSecret) : existing.snmpSecret,
      maintenance_interval_days:
        patch.maintenance?.intervalDays !== undefined
          ? patch.maintenance.intervalDays
          : existing.maintenance.intervalDays,
      maintenance_interval_pages:
        patch.maintenance?.intervalPages !== undefined
          ? patch.maintenance.intervalPages
          : existing.maintenance.intervalPages,
      consumable_low_threshold_pct:
        patch.maintenance?.consumableLowThresholdPct !== undefined
          ? patch.maintenance.consumableLowThresholdPct
          : existing.maintenance.consumableLowThresholdPct,
      created_at: existing.createdAt,
      updated_at: new Date().toISOString(),
    };

    // Só os campos referenciados por placeholders na query abaixo — passar
    // `updated` inteiro (que também tem `id`/`created_at`) faz o node:sqlite
    // rejeitar com "Unknown named parameter" (allowUnknownNamedParameters é
    // false por padrão), já que `id` é usado só na cláusula WHERE (mapeado
    // separadamente) e `created_at` nunca é atualizado.
    this.db
      .prepare(
        `UPDATE printers SET
          name = $name, mac = $mac, ip_override = $ip_override,
          snmp_version = $snmp_version, snmp_secret = $snmp_secret,
          maintenance_interval_days = $maintenance_interval_days,
          maintenance_interval_pages = $maintenance_interval_pages,
          consumable_low_threshold_pct = $consumable_low_threshold_pct,
          updated_at = $updated_at
        WHERE id = $id`,
      )
      .run({
        id: updated.id,
        name: updated.name,
        mac: updated.mac,
        ip_override: updated.ip_override,
        snmp_version: updated.snmp_version,
        snmp_secret: updated.snmp_secret,
        maintenance_interval_days: updated.maintenance_interval_days,
        maintenance_interval_pages: updated.maintenance_interval_pages,
        consumable_low_threshold_pct: updated.consumable_low_threshold_pct,
        updated_at: updated.updated_at,
      } as Record<string, SQLInputValue>);

    return rowToRecord(updated);
  }

  delete(id: string): boolean {
    const result = this.db.prepare('DELETE FROM printers WHERE id = $id').run({ id });
    return result.changes > 0;
  }

  // --- Histórico de manutenção (subtarefa 8) ---

  // Não valida aqui se `printerId` existe — quem chama (a rota) já fez
  // `getById` antes para decidir entre 404 e seguir, então repetir a
  // checagem no repositório seria uma segunda fonte da mesma verdade.
  createMaintenanceEvent(printerId: string, input: CreateMaintenanceEventInput): PrinterMaintenanceEvent {
    const now = new Date().toISOString();
    const row: MaintenanceEventRow = {
      id: randomUUID(),
      printer_id: printerId,
      performed_at: input.performedAt ?? now,
      note: input.note ?? null,
      page_count_at_maintenance: input.pageCountAtMaintenance ?? null,
      created_at: now,
    };

    this.db
      .prepare(
        `INSERT INTO printer_maintenance_events (
          id, printer_id, performed_at, note, page_count_at_maintenance, created_at
        ) VALUES (
          $id, $printer_id, $performed_at, $note, $page_count_at_maintenance, $created_at
        )`,
      )
      .run(row as unknown as Record<string, SQLInputValue>);

    return maintenanceRowToRecord(row);
  }

  // Mais recente primeiro — é assim que o histórico é consumido (o
  // consumidor só precisa do último evento para calcular a próxima
  // manutenção devida, mas a listagem inteira também é exposta para
  // auditoria/UI).
  //
  // A ordenação FINAL é feita em JS, por instante real, e não pelo
  // `ORDER BY performed_at DESC` do SQLite: `performed_at` é guardado
  // exatamente como recebido (ISO 8601 com offset arbitrário — a rota aceita
  // `datetime({ offset: true })`), e comparar essas strings como texto não
  // equivale a comparar instantes. Exemplo real no fuso do projeto
  // (America/Sao_Paulo): '2026-03-10T23:00:00.000-03:00' é 02:00Z do dia 11,
  // logo POSTERIOR a '2026-03-11T01:00:00.000Z' — mas ordena ANTES por texto,
  // porque a string começa com '2026-03-10'. Isso não erraria só a listagem:
  // quem calcula a próxima manutenção usa o índice 0 como "última
  // manutenção", então um offset diferente de 'Z' contaminaria
  // dueAt/duePages/overdue com o evento errado.
  //
  // O `ORDER BY` continua no SQL só como desempate determinístico para
  // eventos com o MESMO instante (o sort do JS é estável, então preserva
  // essa ordem); a correção de fuso é a comparação numérica abaixo.
  listMaintenanceEvents(printerId: string): PrinterMaintenanceEvent[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM printer_maintenance_events WHERE printer_id = $printerId
         ORDER BY performed_at DESC, created_at DESC`,
      )
      .all({ printerId }) as unknown as MaintenanceEventRow[];
    return rows
      .map(maintenanceRowToRecord)
      .sort((a, b) => Date.parse(b.performedAt) - Date.parse(a.performedAt));
  }

  // --- Histórico de leituras SNMP (subtarefa 12) ---

  // Chamada pelo poller (printer-snmp.service.ts) depois de cada leitura SNMP
  // bem-sucedida. Não valida aqui se `printerId` existe (mesmo raciocínio de
  // createMaintenanceEvent) — o poller só chama isso para impressoras que
  // acabou de ler do próprio cadastro, então a existência já está garantida
  // por construção.
  recordSnmpHistoryEntry(printerId: string, entry: RecordSnmpHistoryInput): PrinterSnmpHistoryEntry {
    const suppliesJson = JSON.stringify(entry.supplies);
    const partial = entry.partial ? 1 : 0;

    const result = this.db
      .prepare(
        `INSERT INTO printer_snmp_history (
          printer_id, collected_at, page_count, supplies_json, partial
        ) VALUES (
          $printer_id, $collected_at, $page_count, $supplies_json, $partial
        )`,
      )
      .run({
        printer_id: printerId,
        collected_at: entry.collectedAt,
        page_count: entry.pageCount,
        supplies_json: suppliesJson,
        partial,
      } as Record<string, SQLInputValue>);

    return snmpHistoryRowToRecord({
      id: Number(result.lastInsertRowid),
      printer_id: printerId,
      collected_at: entry.collectedAt,
      page_count: entry.pageCount,
      supplies_json: suppliesJson,
      partial,
    });
  }

  // Ordenado CRESCENTE (collected_at ASC) — ao contrário de
  // listMaintenanceEvents (log, mais recente primeiro), este histórico é
  // consumido como SÉRIE TEMPORAL para gráfico de tendência, onde faz mais
  // sentido a ordem cronológica normal. `from`/`to`, quando informados, já
  // chegam normalizados para UTC canônico pela camada de aplicação (rota) —
  // ver o alerta sobre comparação de datas como TEXTO no SQLite em
  // toCanonicalUtcIso (bandwidth-history.service.ts), mesmo raciocínio vale
  // aqui: este método não normaliza nada, só compara o que recebeu.
  listSnmpHistory(printerId: string, options: SnmpHistoryRangeFilter = {}): PrinterSnmpHistoryEntry[] {
    const conditions = ['printer_id = $printerId'];
    const params: Record<string, SQLInputValue> = { printerId };

    if (options.from !== undefined) {
      conditions.push('collected_at >= $from');
      params.from = options.from;
    }
    if (options.to !== undefined) {
      conditions.push('collected_at <= $to');
      params.to = options.to;
    }

    const rows = this.db
      .prepare(`SELECT * FROM printer_snmp_history WHERE ${conditions.join(' AND ')} ORDER BY collected_at ASC`)
      .all(params) as unknown as SnmpHistoryRow[];
    return rows.map(snmpHistoryRowToRecord);
  }

  // Usado pelo job de retenção diário (printer-snmp.service.ts) — apaga
  // TODAS as impressoras de uma vez (sem filtro por printer_id), mesma forma
  // de bandwidth-history.db.ts#deleteSamplesOlderThan.
  deleteSnmpHistoryOlderThan(cutoffIso: string): number {
    const result = this.db.prepare('DELETE FROM printer_snmp_history WHERE collected_at < $cutoff').run({
      cutoff: cutoffIso,
    });
    return Number(result.changes);
  }

  close(): void {
    this.db.close();
  }
}

export function createPrintersRepository(dbFile: string): PrintersRepository {
  return new PrintersRepository(dbFile);
}
