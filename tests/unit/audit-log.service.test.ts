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

  // Regressão: um parse em bloco (JSON.parse dentro de um .map()) lançava
  // na primeira linha inválida e deixava o histórico INTEIRO vazio. Uma
  // última linha truncada é o resultado normal de um crash no meio do
  // append — ou seja, o histórico sumia exatamente no cenário pós-crash em
  // que alguém vai querer lê-lo.
  it('recupera as entradas boas quando a ÚLTIMA linha está truncada (crash no meio do append)', async () => {
    const good = [0, 1, 2].map((i) =>
      JSON.stringify({
        timestamp: `t${i}`,
        actor: 'admin',
        method: 'POST',
        route: '/clients/:mac/block',
        params: { mac: 'aa:bb:cc:dd:ee:ff' },
        statusCode: 200,
      }),
    );
    writeFileSync(auditLogFile, `${good.join('\n')}\n{"timestamp":"t3","act`);

    const { auditLogService } = await import('../../src/services/audit-log.service.js');

    const history = auditLogService.getHistory();
    expect(history).toHaveLength(3);
    expect(history.map((e) => e.timestamp)).toEqual(['t0', 't1', 't2']);
  });

  it('descarta linha inválida no MEIO do arquivo e mantém as de antes e depois', async () => {
    const entryAt = (i: number) =>
      JSON.stringify({
        timestamp: `t${i}`,
        actor: 'admin',
        method: 'DELETE',
        route: '/wifi/:id',
        params: { id: 'w1' },
        statusCode: 204,
      });
    writeFileSync(auditLogFile, `${entryAt(0)}\nnão-é-json\n${entryAt(2)}\n`);

    const { auditLogService } = await import('../../src/services/audit-log.service.js');

    expect(auditLogService.getHistory().map((e) => e.timestamp)).toEqual(['t0', 't2']);
  });

  it('descarta linha que é JSON válido mas não é uma entrada de auditoria', async () => {
    // `null`, um número e um array são JSON perfeitamente válidos — sem
    // checagem de forma, entrariam no histórico como se fossem ações reais
    // (e `null.actor` estouraria em quem consumisse a rota).
    writeFileSync(
      auditLogFile,
      [
        'null',
        '123',
        '[]',
        '{"actor":"admin"}',
        JSON.stringify({
          timestamp: 't9',
          actor: 'admin',
          method: 'POST',
          route: '/printers/:id/reboot',
          params: { id: 'p1' },
          statusCode: 200,
        }),
      ].join('\n'),
    );

    const { auditLogService } = await import('../../src/services/audit-log.service.js');

    expect(auditLogService.getHistory()).toEqual([
      {
        timestamp: 't9',
        actor: 'admin',
        method: 'POST',
        route: '/printers/:id/reboot',
        params: { id: 'p1' },
        statusCode: 200,
      },
    ]);
  });

  it('não perde o histórico já em memória quando o append em disco falha', async () => {
    const { auditLogService } = await import('../../src/services/audit-log.service.js');

    auditLogService.record({
      timestamp: 't0',
      actor: 'admin',
      method: 'POST',
      route: '/wifi',
      params: {},
      statusCode: 201,
    });

    // Diretório removido embaixo do serviço: o append passa a falhar, mas a
    // ação ACONTECEU e precisa continuar visível pro operador.
    rmSync(tempDir, { recursive: true, force: true });
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() =>
      auditLogService.record({
        timestamp: 't1',
        actor: 'admin',
        method: 'DELETE',
        route: '/networks/:id',
        params: { id: 'n1' },
        statusCode: 204,
      }),
    ).not.toThrow();

    expect(auditLogService.getHistory().map((e) => e.timestamp)).toEqual(['t0', 't1']);
    expect(consoleError).toHaveBeenCalled();
    consoleError.mockRestore();
  });

  // Limitação documentada no cabeçalho do serviço: o arquivo é a fonte
  // completa, a memória é um cache de HISTORY_LIMIT entradas — a rota nunca
  // devolve mais que isso, nem pedindo. Travado por teste pra ninguém
  // assumir o contrário depois.
  it('nunca devolve mais que o teto do buffer, mesmo com limit absurdo (arquivo segue completo)', async () => {
    const { auditLogService } = await import('../../src/services/audit-log.service.js');

    for (let i = 0; i < 520; i++) {
      auditLogService.record({
        timestamp: `t${i}`,
        actor: 'admin',
        method: 'POST',
        route: '/wifi',
        params: {},
        statusCode: 201,
      });
    }

    const history = auditLogService.getHistory(10_000);
    expect(history).toHaveLength(500);
    expect(history[0]?.timestamp).toBe('t20');
    // ...enquanto o arquivo em disco guardou as 520.
    expect(readFileSync(auditLogFile, 'utf-8').trim().split('\n')).toHaveLength(520);
  });
});
