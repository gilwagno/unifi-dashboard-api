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

  close(): void {
    this.db.close();
  }
}

export function createPrintersRepository(dbFile: string): PrintersRepository {
  return new PrintersRepository(dbFile);
}
