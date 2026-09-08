import { env } from '../config/env.js';
import { createBandwidthHistoryRepository } from './bandwidth-history.db.js';

// Instância singleton do repositório de histórico de banda (SQLite em
// `env.BANDWIDTH_HISTORY_DB_FILE`) — mesmo padrão de
// src/db/printers.instance.ts: extraída para seu próprio módulo (em vez de
// viver dentro de bandwidth-history.service.ts) para que os testes de
// integração consigam importar e fechar a conexão explicitamente antes de
// apagar o diretório temporário do banco (no Windows, apagar um arquivo com
// um handle SQLite ainda aberto falha com EPERM).
export const bandwidthHistoryRepository = createBandwidthHistoryRepository(env.BANDWIDTH_HISTORY_DB_FILE);
