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

// Uma entrada só entra no buffer em memória se tiver a forma esperada. O
// arquivo é append-only e vive fora do processo (pode ser tocado por
// logrotate, editado à mão numa investigação, ou ter uma linha truncada
// por um crash no meio do append) — sem essa checagem, uma linha
// sintaticamente válida mas semanticamente lixo (`null`, `123`, `[]`)
// entraria no histórico como se fosse uma ação real.
function isAuditLogEntry(value: unknown): value is AuditLogEntry {
  if (typeof value !== 'object' || value === null) return false;
  const entry = value as Record<string, unknown>;
  return (
    typeof entry.timestamp === 'string' &&
    typeof entry.actor === 'string' &&
    typeof entry.method === 'string' &&
    typeof entry.route === 'string' &&
    typeof entry.statusCode === 'number' &&
    typeof entry.params === 'object' &&
    entry.params !== null
  );
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
//
// LIMITAÇÕES CONHECIDAS E ACEITAS (documentadas de propósito, não são bugs
// a corrigir sem um pedido explícito):
//
//  1. O ARQUIVO é a fonte de verdade completa; a memória é só um cache das
//     últimas HISTORY_LIMIT entradas. Consequência direta:
//     `GET /security/audit-log` NUNCA devolve mais que HISTORY_LIMIT
//     entradas, mesmo com `?limit=10000` e mesmo com o arquivo em disco
//     tendo o histórico inteiro. Pra investigar mais fundo que isso, lê-se
//     o arquivo (`AUDIT_LOG_FILE`) direto. Uma leitura paginada por disco
//     na rota seria a correção "de verdade", mas exigiria ler um arquivo
//     sem rotação/limite de tamanho a cada request — fica pra quando
//     houver necessidade real.
//  2. Single-process. O buffer em memória é por processo: rodar duas
//     instâncias apontando pro mesmo AUDIT_LOG_FILE dá dois caches
//     divergentes (cada um só vê as ações que passaram por ele até o
//     próximo restart), e as escritas concorrentes no mesmo arquivo não têm
//     garantia de atomicidade em todo sistema de arquivos. O arquivo segue
//     recebendo tudo; só a visão via API fica parcial.
//  3. Se o append em disco falhar, a entrada continua no buffer em memória
//     (a ação ACONTECEU e precisa aparecer pro operador) — nesse caso
//     memória e disco divergem até o próximo restart, quando a entrada não
//     persistida desaparece. O erro é logado, nunca silencioso.
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
      console.error(
        '[audit-log] falha ao persistir entrada em disco (buffer em memória segue intacto):',
        err,
      );
    }
  }

  getHistory(limit = HISTORY_LIMIT): AuditLogEntry[] {
    const capped = Math.min(limit, HISTORY_LIMIT);
    return this.history.slice(-capped);
  }

  private loadFromDisk(): void {
    if (!existsSync(env.AUDIT_LOG_FILE)) return;

    let lines: string[];
    try {
      lines = readFileSync(env.AUDIT_LOG_FILE, 'utf-8').split('\n').filter(Boolean);
    } catch (err) {
      console.error('[audit-log] falha ao ler o arquivo de log de auditoria do disco:', err);
      return;
    }

    // Cada linha é parseada ISOLADAMENTE, e uma linha inválida é descartada
    // sem derrubar as outras. Não é preciosismo: um `kill -9`/queda de
    // energia/disco cheio no meio de um appendFileSync deixa a ÚLTIMA linha
    // truncada, e um parse em bloco (um único JSON.parse dentro de um
    // .map()) lançava no primeiro caractere inválido e deixava o histórico
    // inteiro vazio — exatamente no cenário (pós-crash) em que alguém vai
    // querer ler o log de auditoria. O arquivo continua intacto; só as
    // linhas ilegíveis ficam de fora do buffer, com aviso de quantas foram.
    const recovered: AuditLogEntry[] = [];
    let skipped = 0;

    for (const line of lines.slice(-HISTORY_LIMIT)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        skipped++;
        continue;
      }

      if (!isAuditLogEntry(parsed)) {
        skipped++;
        continue;
      }
      recovered.push(parsed);
    }

    this.history = recovered;

    if (skipped > 0) {
      console.error(
        `[audit-log] ${skipped} linha(s) ilegível(is) descartada(s) ao carregar ${env.AUDIT_LOG_FILE} ` +
          `(${recovered.length} entrada(s) recuperada(s)); o arquivo não foi alterado`,
      );
    }
  }
}

export const auditLogService = new AuditLogService();
