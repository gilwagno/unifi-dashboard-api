import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// tests/setup.ts mocka este serviço globalmente (o hook onResponse de
// src/app.ts chamaria auditLogService.record() de verdade em quase todo
// teste de integração, gravando em disco à toa). Aqui é o próprio serviço
// sendo testado, então desfaz esse mock e reimporta o módulo real a cada
// teste, com um arquivo de log isolado num diretório temporário.
let tempDir: string;
let auditLogFile: string;

beforeEach(() => {
  vi.resetModules();
  tempDir = mkdtempSync(join(tmpdir(), 'audit-log-test-'));
  auditLogFile = join(tempDir, 'audit.log');
  process.env.AUDIT_LOG_FILE = auditLogFile;
  vi.doUnmock('../../src/services/audit-log.service.js');
});

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
  delete process.env.AUDIT_LOG_FILE;
});

describe('auditLogService', () => {
  it('registra uma entrada em memória e persiste no arquivo', async () => {
    const { auditLogService } = await import('../../src/services/audit-log.service.js');

    auditLogService.record({
      timestamp: '2026-01-01T00:00:00.000Z',
      actor: 'admin',
      method: 'POST',
      route: '/clients/:mac/block',
      params: { mac: 'aa:bb:cc:dd:ee:ff' },
      statusCode: 200,
    });

    expect(auditLogService.getHistory()).toEqual([
      {
        timestamp: '2026-01-01T00:00:00.000Z',
        actor: 'admin',
        method: 'POST',
        route: '/clients/:mac/block',
        params: { mac: 'aa:bb:cc:dd:ee:ff' },
        statusCode: 200,
      },
    ]);

    expect(existsSync(auditLogFile)).toBe(true);
    const lines = readFileSync(auditLogFile, 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0])).toMatchObject({ actor: 'admin', method: 'POST' });
  });

  it('carrega o histórico existente do disco ao iniciar (sobrevive a um restart)', async () => {
    writeFileSync(
      auditLogFile,
      `${JSON.stringify({
        timestamp: 't0',
        actor: 'admin',
        method: 'POST',
        route: '/devices/:id/restart',
        params: { id: 'dev-1' },
        statusCode: 200,
      })}\n`,
    );

    const { auditLogService } = await import('../../src/services/audit-log.service.js');

    expect(auditLogService.getHistory()).toEqual([
      {
        timestamp: 't0',
        actor: 'admin',
        method: 'POST',
        route: '/devices/:id/restart',
        params: { id: 'dev-1' },
        statusCode: 200,
      },
    ]);
  });

  it('não quebra se o arquivo ainda não existir', async () => {
    const { auditLogService } = await import('../../src/services/audit-log.service.js');
    expect(auditLogService.getHistory()).toEqual([]);
  });

  it('respeita o limite passado pra getHistory (retorna as mais recentes)', async () => {
    const { auditLogService } = await import('../../src/services/audit-log.service.js');

    for (let i = 0; i < 5; i++) {
      auditLogService.record({
        timestamp: `t${i}`,
        actor: 'admin',
        method: 'POST',
        route: '/wifi',
        params: {},
        statusCode: 201,
      });
    }

    expect(auditLogService.getHistory(2)).toEqual([
      { timestamp: 't3', actor: 'admin', method: 'POST', route: '/wifi', params: {}, statusCode: 201 },
      { timestamp: 't4', actor: 'admin', method: 'POST', route: '/wifi', params: {}, statusCode: 201 },
    ]);
  });
});
