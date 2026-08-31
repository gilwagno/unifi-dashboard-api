import { vi } from 'vitest';

process.env.CONTROLLER_HOST ??= 'controller.test';
process.env.UNIFI_API_KEY ??= 'test-api-key';
process.env.SITE_ID ??= 'default';
process.env.UNIFI_ALLOW_SELF_SIGNED ??= 'true';
process.env.JWT_SECRET ??= 'test-secret-with-at-least-16-chars';
process.env.ADMIN_USER ??= 'admin';
process.env.ADMIN_PASSWORD_HASH ??= 'fake-hash-mocked-in-tests';
process.env.PORT ??= '3000';

// src/app.ts registra um hook global que grava em auditLogService.record()
// pra toda requisição não-GET — sem mockar isso aqui, cada teste de rota
// mutável (block/unblock, restart, wifi, networks, ssh...) tocaria disco de
// verdade em ./audit.log. Mockado globalmente em vez de arquivo por
// arquivo porque o hook é transversal a quase todo teste de integração.
vi.mock('../src/services/audit-log.service.js', () => ({
  auditLogService: { record: vi.fn(), getHistory: vi.fn(() => []) },
}));
