import { vi } from 'vitest';

process.env.CONTROLLER_HOST ??= 'controller.test';
process.env.UNIFI_API_KEY ??= 'test-api-key';
process.env.SITE_ID ??= 'default';
process.env.UNIFI_ALLOW_SELF_SIGNED ??= 'true';
process.env.JWT_SECRET ??= 'test-secret-with-at-least-16-chars';
process.env.ADMIN_USER ??= 'admin';
process.env.ADMIN_PASSWORD_HASH ??= 'fake-hash-mocked-in-tests';
process.env.PORT ??= '3000';
// Banco em memória por padrão nos testes — evita que qualquer teste que
// importe src/app.js (e portanto src/routes/printers.routes.ts) crie um
// arquivo printers.db real no disco. Testes que precisam mesmo de um
// arquivo real (ex: verificar persistência entre "restarts") sobrescrevem
// esta variável explicitamente antes de importar o app.
process.env.PRINTERS_DB_FILE ??= ':memory:';
// Mesma lógica de PRINTERS_DB_FILE acima, para o segundo banco SQLite do
// projeto (histórico de banda de longo prazo — ver
// src/db/bandwidth-history.db.ts).
process.env.BANDWIDTH_HISTORY_DB_FILE ??= ':memory:';

// src/app.ts registra um hook global que grava em auditLogService.record()
// pra toda requisição não-GET — sem mockar isso aqui, cada teste de rota
// mutável (block/unblock, restart, wifi, networks, ssh...) tocaria disco de
// verdade em ./audit.log. Mockado globalmente em vez de arquivo por
// arquivo porque o hook é transversal a quase todo teste de integração.
vi.mock('../src/services/audit-log.service.js', () => ({
  auditLogService: { record: vi.fn(), getHistory: vi.fn(() => []) },
}));
