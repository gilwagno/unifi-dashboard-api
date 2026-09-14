import { vi } from 'vitest';

// A SUÍTE NÃO PODE LER O `.env` DO DESENVOLVEDOR. `src/config/env.ts` faz
// `import 'dotenv/config'`, então qualquer variável presente no `.env`
// real vazava para dentro dos testes — e como o dotenv não sobrescreve o
// que já está em `process.env`, nem os defaults abaixo protegiam contra
// isso. O resultado da suíte dependia da máquina de quem a rodava.
//
// Não é hipótese: quando as `AD_*` foram configuradas no `.env` real
// (2026-09-14), 2 testes que afirmam o comportamento "sem AD configurado"
// passaram a FALHAR em `master`, com o mesmo commit que passava 759/759
// numa worktree (que não tem `.env`). A falha foi barulhenta por sorte —
// o sentido oposto é o perigoso: um teste que afirma um DEFAULT seguro
// passaria porque o `.env` local define o valor certo, e quebraria só em
// produção, em CI, ou na máquina de outra pessoa.
//
// Apontar o dotenv para um caminho inexistente o deixa carregar nada, sem
// erro. Toda variável que a suíte precisa vem explicitamente daqui de
// baixo ou do próprio teste.
process.env.DOTENV_CONFIG_PATH = './.env.vitest-nao-existe';

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
