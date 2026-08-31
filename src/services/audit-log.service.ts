import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { env } from '../config/env.js';

const HISTORY_LIMIT = 500;

export interface AuditLogEntry {
  timestamp: string;
  actor: string;
  method: string;
  route: string;
  params: Record<string, string>;
  statusCode: number;
}

// Registra quem fez o quê DENTRO deste dashboard (bloqueio/desbloqueio,
// restart de device, rotação de senha SSH, criação/remoção de VLAN/SSID,
// etc.) — diferente das rotas /security/*, que auditam o controller UniFi
// em si. Ao contrário dos buffers de eventos/banda (só em memória), este
// também é persistido num arquivo local (append-only, uma linha JSON por
// entrada) porque um log de auditoria que some a cada restart não serve
// pra investigar um incidente depois. Nunca grava o corpo da requisição
// (poderia conter senha/passphrase) — só método, rota, params de path
// (ids/macs, não segredos) e o status da resposta.
class AuditLogService {
  private history: AuditLogEntry[] = [];

  constructor() {
    this.loadFromDisk();
  }

  record(entry: AuditLogEntry): void {
    this.history.push(entry);
    if (this.history.length > HISTORY_LIMIT) this.history.shift();

    try {
      appendFileSync(env.AUDIT_LOG_FILE, `${JSON.stringify(entry)}\n`);
    } catch (err) {
      // Falha ao persistir em disco não deve derrubar o request que já foi
      // processado — só loga o erro e segue (mesmo espírito do poller de
      // bandwidth-history.service.ts, que não para o processo por uma
      // falha pontual).
      console.error('Falha ao gravar log de auditoria em disco:', err);
    }
  }

  getHistory(limit = HISTORY_LIMIT): AuditLogEntry[] {
    const capped = Math.min(limit, HISTORY_LIMIT);
    return this.history.slice(-capped);
  }

  private loadFromDisk(): void {
    if (!existsSync(env.AUDIT_LOG_FILE)) return;

    try {
      const lines = readFileSync(env.AUDIT_LOG_FILE, 'utf-8').split('\n').filter(Boolean);
      this.history = lines.slice(-HISTORY_LIMIT).map((line) => JSON.parse(line) as AuditLogEntry);
    } catch (err) {
      console.error('Falha ao carregar log de auditoria do disco:', err);
    }
  }
}

export const auditLogService = new AuditLogService();
