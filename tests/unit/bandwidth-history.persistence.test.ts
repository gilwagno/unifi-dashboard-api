import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Este arquivo cobre a parte NOVA do serviço (persistência em disco, job de
// rollup/limpeza, endpoint de longo prazo) — diferente de
// bandwidth-history.service.test.ts (que testa só computeDelta(), puro, com
// o banco em ':memory:' do setup global). Aqui precisamos de um arquivo
// SQLite real num diretório temporário próprio (mesmo padrão de
// tests/integration/printers.routes.test.ts), então sobrescrevemos
// BANDWIDTH_HISTORY_DB_FILE ANTES de importar o serviço — cada arquivo de
// teste do Vitest tem seu próprio módulo isolado, então isso não vaza para
// outros arquivos de teste.
vi.mock('../../src/services/unifi-classic.service.js', () => ({
  unifiClassicService: {
    getRawTrafficCounters: vi.fn(),
  },
}));

const tmpDir = mkdtempSync(join(tmpdir(), 'bandwidth-history-service-test-'));
process.env.BANDWIDTH_HISTORY_DB_FILE = join(tmpDir, 'bandwidth-history.db');

const { bandwidthHistoryService } = await import('../../src/services/bandwidth-history.service.js');
const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
const { bandwidthHistoryRepository } = await import('../../src/db/bandwidth-history.instance.js');

afterAll(() => {
  // Fecha a conexão SQLite antes de apagar o diretório temporário — no
  // Windows, remover um arquivo com um handle ainda aberto falha com EPERM
  // (mesmo motivo documentado em printers.routes.test.ts).
  bandwidthHistoryRepository.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

beforeEach(() => {
  vi.mocked(unifiClassicService.getRawTrafficCounters).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('collectSnapshot — poller de 5 min continua funcionando com a escrita nova no banco', () => {
  it('grava a amostra no buffer em memória E em bandwidth_samples', async () => {
    vi.mocked(unifiClassicService.getRawTrafficCounters).mockResolvedValue({
      perDevice: [{ mac: 'aa:bb', name: 'AP Sala', rxBytes: 1000, txBytes: 500 }],
      perClient: [{ mac: '11:22', hostname: 'iPhone', rxBytes: 200, txBytes: 100 }],
    });

    const beforeCount = bandwidthHistoryService.getHistory().length;
    await bandwidthHistoryService.collectSnapshot();

    const history = bandwidthHistoryService.getHistory();
    expect(history).toHaveLength(beforeCount + 1);
    const snapshot = history[history.length - 1];
    expect(snapshot.perDevice).toEqual([{ mac: 'aa:bb', name: 'AP Sala', rxBytes: 1000, txBytes: 500 }]);

    const rows = bandwidthHistoryRepository.listSamples({
      from: '2000-01-01T00:00:00.000Z',
      to: '2999-01-01T00:00:00.000Z',
    });
    const deviceRow = rows.find((r) => r.scope === 'device' && r.mac === 'aa:bb' && r.collectedAt === snapshot.timestamp);
    const clientRow = rows.find((r) => r.scope === 'client' && r.mac === '11:22' && r.collectedAt === snapshot.timestamp);
    expect(deviceRow).toMatchObject({ label: 'AP Sala', rxBytes: 1000, txBytes: 500 });
    expect(clientRow).toMatchObject({ label: 'iPhone', rxBytes: 200, txBytes: 100 });
  });

  it('falha de escrita no SQLite não derruba o buffer em memória nem o poller', async () => {
    vi.mocked(unifiClassicService.getRawTrafficCounters).mockResolvedValue({
      perDevice: [{ mac: 'cc:dd', name: 'Switch', rxBytes: 10, txBytes: 5 }],
      perClient: [],
    });
    vi.spyOn(bandwidthHistoryRepository, 'insertSample').mockImplementation(() => {
      throw new Error('disco cheio (simulado)');
    });
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const beforeCount = bandwidthHistoryService.getHistory().length;

    await expect(bandwidthHistoryService.collectSnapshot()).resolves.toBeUndefined();

    const history = bandwidthHistoryService.getHistory();
    expect(history).toHaveLength(beforeCount + 1);
    expect(history[history.length - 1].perDevice).toEqual([
      { mac: 'cc:dd', name: 'Switch', rxBytes: 10, txBytes: 5 },
    ]);
    expect(consoleSpy).toHaveBeenCalled();
  });

  // O filtro `?mac=` do endpoint normaliza para minúsculas e a comparação
  // do SQLite é sensível a caixa — se a escrita não normalizasse, um MAC
  // devolvido em maiúsculas pelo controller ficaria inalcançável pelo
  // filtro (lista vazia, sem erro nenhum).
  it('normaliza o MAC para minúsculas na escrita, para casar com o filtro do endpoint', async () => {
    vi.mocked(unifiClassicService.getRawTrafficCounters).mockResolvedValue({
      perDevice: [{ mac: 'AA:BB:CC:DD:EE:F1', name: 'AP Maiúsculo', rxBytes: 10, txBytes: 5 }],
      perClient: [{ mac: 'AA:BB:CC:DD:EE:F2', hostname: 'Cliente Maiúsculo', rxBytes: 1, txBytes: 1 }],
    });

    await bandwidthHistoryService.collectSnapshot();

    const rows = bandwidthHistoryRepository.listSamples({
      from: '2000-01-01T00:00:00.000Z',
      to: '2999-01-01T00:00:00.000Z',
    });
    expect(rows.some((r) => r.mac === 'aa:bb:cc:dd:ee:f1')).toBe(true);
    expect(rows.some((r) => r.mac === 'aa:bb:cc:dd:ee:f2')).toBe(true);
    expect(rows.some((r) => r.mac === 'AA:BB:CC:DD:EE:F1')).toBe(false);

    // E o MAC em maiúsculas na CONSULTA (getLongRange é chamável direto,
    // sem passar pela normalização da rota) também encontra o dado gravado.
    bandwidthHistoryRepository.insertSample({
      collectedAt: '2026-04-01T08:00:00.000Z',
      scope: 'device',
      mac: 'aa:bb:cc:dd:ee:f3',
      label: 'AP Caixa',
      rxBytes: 100,
      txBytes: 50,
    });
    bandwidthHistoryRepository.insertSample({
      collectedAt: '2026-04-01T08:05:00.000Z',
      scope: 'device',
      mac: 'aa:bb:cc:dd:ee:f3',
      label: 'AP Caixa',
      rxBytes: 300,
      txBytes: 150,
    });

    const found = bandwidthHistoryService.getLongRange({
      mac: 'AA:BB:CC:DD:EE:F3',
      from: '2026-04-01T00:00:00.000Z',
      to: '2026-04-02T00:00:00.000Z',
    });
    expect(found).toHaveLength(1);
    expect(found[0].perDevice).toEqual([{ mac: 'aa:bb:cc:dd:ee:f3', name: 'AP Caixa', rxBytes: 200, txBytes: 100 }]);
  });

  it('falha na coleta em si (controller fora do ar) continua sem derrubar o poller (comportamento preexistente)', async () => {
    vi.mocked(unifiClassicService.getRawTrafficCounters).mockRejectedValue(new Error('controller indisponível'));
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const beforeCount = bandwidthHistoryService.getHistory().length;
    await expect(bandwidthHistoryService.collectSnapshot()).resolves.toBeUndefined();

    expect(bandwidthHistoryService.getHistory()).toHaveLength(beforeCount);
    expect(consoleSpy).toHaveBeenCalled();
  });
});

describe('runRollupAndCleanup — resume amostras antigas e aplica as janelas de retenção', () => {
  it('resume em bandwidth_hourly_rollup só as horas com mais de 48h, e apaga as amostras finas correspondentes', () => {
    const now = new Date('2026-08-10T12:00:00.000Z');

    // Hora antiga (dentro da hora 2026-08-08T10:00, mais de 48h atrás de
    // `now`) — duas amostras no mesmo device, delta esperado = 300 (rx) / 100
    // (tx).
    bandwidthHistoryRepository.insertSample({
      collectedAt: '2026-08-08T10:00:00.000Z',
      scope: 'device',
      mac: 'aa:bb:old',
      label: 'AP Antigo',
      rxBytes: 1000,
      txBytes: 500,
    });
    bandwidthHistoryRepository.insertSample({
      collectedAt: '2026-08-08T10:05:00.000Z',
      scope: 'device',
      mac: 'aa:bb:old',
      label: 'AP Antigo',
      rxBytes: 1300,
      txBytes: 600,
    });

    // Hora recente (dentro das últimas 48h) — não deve ser tocada.
    bandwidthHistoryRepository.insertSample({
      collectedAt: '2026-08-10T11:00:00.000Z',
      scope: 'device',
      mac: 'aa:bb:novo',
      label: 'AP Novo',
      rxBytes: 10,
      txBytes: 5,
    });

    bandwidthHistoryService.runRollupAndCleanup(now);

    const rollups = bandwidthHistoryRepository.listHourlyRollups({
      from: '2000-01-01T00:00:00.000Z',
      to: '2999-01-01T00:00:00.000Z',
    });
    const rollupForOld = rollups.find((r) => r.mac === 'aa:bb:old');
    expect(rollupForOld).toEqual({
      hourStart: '2026-08-08T10:00:00.000Z',
      scope: 'device',
      mac: 'aa:bb:old',
      label: 'AP Antigo',
      rxBytesDelta: 300,
      txBytesDelta: 100,
    });

    const remainingSamples = bandwidthHistoryRepository.listSamples({
      from: '2000-01-01T00:00:00.000Z',
      to: '2999-01-01T00:00:00.000Z',
    });
    // A amostra antiga foi resumida e apagada; a recente permanece intacta.
    expect(remainingSamples.some((s) => s.mac === 'aa:bb:old')).toBe(false);
    expect(remainingSamples.some((s) => s.mac === 'aa:bb:novo')).toBe(true);
  });

  it('reset de contador dentro da hora vira delta null, não negativo — a linha é gravada mesmo assim', () => {
    const now = new Date('2026-08-20T12:00:00.000Z');

    bandwidthHistoryRepository.insertSample({
      collectedAt: '2026-08-18T09:00:00.000Z',
      scope: 'client',
      mac: 'reset:mac',
      label: 'Cliente Reiniciado',
      rxBytes: 9000,
      txBytes: 4000,
    });
    // rxBytes caiu (reset de contador); txBytes segue crescendo normalmente.
    bandwidthHistoryRepository.insertSample({
      collectedAt: '2026-08-18T09:30:00.000Z',
      scope: 'client',
      mac: 'reset:mac',
      label: 'Cliente Reiniciado',
      rxBytes: 100,
      txBytes: 4200,
    });

    bandwidthHistoryService.runRollupAndCleanup(now);

    const rollups = bandwidthHistoryRepository.listHourlyRollups({
      from: '2000-01-01T00:00:00.000Z',
      to: '2999-01-01T00:00:00.000Z',
    });
    const rollup = rollups.find((r) => r.mac === 'reset:mac');
    expect(rollup).toBeDefined();
    expect(rollup!.rxBytesDelta).toBeNull();
    expect(rollup!.txBytesDelta).toBe(200);
  });

  it('respeita a janela de retenção do rollup (30 dias) — apaga rollups mais antigos', () => {
    const now = new Date('2026-09-01T00:00:00.000Z');

    // Valores COLADOS na fronteira dos 30 dias (now = 2026-09-01T00:00Z, ou
    // seja, corte em 2026-08-02T00:00Z): só assim o teste ancora o limite de
    // verdade — com 2026-06-01 vs 2026-08-30 qualquer retenção entre ~2 e ~90
    // dias passaria igual.
    bandwidthHistoryRepository.insertHourlyRollup({
      hourStart: '2026-08-01T23:00:00.000Z', // 1h ALÉM dos 30 dias -> apagar
      scope: 'device',
      mac: 'muito:antigo',
      label: 'Antigo',
      rxBytesDelta: 1,
      txBytesDelta: 1,
    });
    bandwidthHistoryRepository.insertHourlyRollup({
      hourStart: '2026-08-02T01:00:00.000Z', // 1h DENTRO dos 30 dias -> manter
      scope: 'device',
      mac: 'recente:rollup',
      label: 'Recente',
      rxBytesDelta: 2,
      txBytesDelta: 2,
    });

    bandwidthHistoryService.runRollupAndCleanup(now);

    const remaining = bandwidthHistoryRepository.listHourlyRollups({
      from: '2000-01-01T00:00:00.000Z',
      to: '2999-01-01T00:00:00.000Z',
    });
    expect(remaining.some((r) => r.mac === 'muito:antigo')).toBe(false);
    expect(remaining.some((r) => r.mac === 'recente:rollup')).toBe(true);
  });

  // Regressão: o corte de 48h cru cai no MEIO de uma hora quase sempre. Se o
  // job resumisse "tudo mais antigo que now-48h" sem exigir hora COMPLETA,
  // ele gravaria o rollup da hora com só o primeiro pedaço dela e apagaria
  // essas amostras; no dia seguinte o resto da mesma hora cairia no mesmo
  // balde e o INSERT OR IGNORE o descartaria em silêncio — perda permanente
  // de dado. Ver o comentário de runRollupAndCleanup.
  it('não resume uma hora que o corte de 48h parte no meio — espera a hora fechar por completo', () => {
    // Hora cheia 2026-07-01T12:00Z, uma amostra a cada 5 min, contador
    // cumulativo indo de 1000 (12:05) a 2000 (12:55): uso real = 1000.
    let rx = 1000;
    for (let minute = 5; minute < 60; minute += 5) {
      bandwidthHistoryRepository.insertSample({
        collectedAt: `2026-07-01T12:${String(minute).padStart(2, '0')}:00.000Z`,
        scope: 'device',
        mac: 'parcial:mac',
        label: 'AP Parcial',
        rxBytes: rx,
        txBytes: rx,
      });
      rx += 100;
    }

    // now - 48h = 2026-07-01T12:30Z, dentro da hora 12:00.
    bandwidthHistoryService.runRollupAndCleanup(new Date('2026-07-03T12:30:00.000Z'));

    const afterFirstRun = bandwidthHistoryRepository
      .listHourlyRollups({ from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z' })
      .filter((r) => r.mac === 'parcial:mac');
    // Nada resumido ainda, e NENHUMA amostra da hora apagada.
    expect(afterFirstRun).toHaveLength(0);
    expect(
      bandwidthHistoryRepository
        .listSamples({ from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z' })
        .filter((s) => s.mac === 'parcial:mac'),
    ).toHaveLength(11);

    // Execução seguinte, já com a hora inteira fora da janela de 48h.
    bandwidthHistoryService.runRollupAndCleanup(new Date('2026-07-04T12:30:00.000Z'));

    const afterSecondRun = bandwidthHistoryRepository
      .listHourlyRollups({ from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z' })
      .filter((r) => r.mac === 'parcial:mac');
    expect(afterSecondRun).toHaveLength(1);
    // Uso da hora INTEIRA (2000 - 1000), não só do pedaço antes do corte.
    expect(afterSecondRun[0].rxBytesDelta).toBe(1000);
    expect(afterSecondRun[0].hourStart).toBe('2026-07-01T12:00:00.000Z');
  });

  // Executar o job duas vezes sobre a mesma janela não pode duplicar nem
  // alterar o rollup já gravado (índice único + INSERT OR IGNORE).
  it('é idempotente: rodar o job duas vezes seguidas não duplica o rollup', () => {
    bandwidthHistoryRepository.insertSample({
      collectedAt: '2026-07-10T08:00:00.000Z',
      scope: 'device',
      mac: 'idem:mac',
      label: 'AP Idem',
      rxBytes: 100,
      txBytes: 50,
    });
    bandwidthHistoryRepository.insertSample({
      collectedAt: '2026-07-10T08:30:00.000Z',
      scope: 'device',
      mac: 'idem:mac',
      label: 'AP Idem',
      rxBytes: 400,
      txBytes: 150,
    });

    const now = new Date('2026-07-12T12:00:00.000Z');
    bandwidthHistoryService.runRollupAndCleanup(now);
    bandwidthHistoryService.runRollupAndCleanup(now);

    const rollups = bandwidthHistoryRepository
      .listHourlyRollups({ from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z' })
      .filter((r) => r.mac === 'idem:mac');
    expect(rollups).toHaveLength(1);
    expect(rollups[0].rxBytesDelta).toBe(300);
    // A segunda execução também precisa CONCLUIR (não abortar no insert
    // duplicado): as amostras finas já resumidas seguem apagadas.
    expect(
      bandwidthHistoryRepository
        .listSamples({ from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z' })
        .filter((s) => s.mac === 'idem:mac'),
    ).toHaveLength(0);
  });

  // Invariante de ordem: o rollup é gravado ANTES da limpeza. Se a gravação
  // falhar no meio, as amostras finas daquela janela precisam continuar no
  // banco para a execução seguinte tentar de novo — apagar primeiro (ou
  // apagar mesmo com o rollup falhando) seria perda de dado irreversível.
  it('não apaga as amostras finas se a gravação do rollup falhar', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    bandwidthHistoryRepository.insertSample({
      collectedAt: '2026-07-25T05:00:00.000Z',
      scope: 'device',
      mac: 'ordem:mac',
      label: 'AP Ordem',
      rxBytes: 10,
      txBytes: 5,
    });
    bandwidthHistoryRepository.insertSample({
      collectedAt: '2026-07-25T05:30:00.000Z',
      scope: 'device',
      mac: 'ordem:mac',
      label: 'AP Ordem',
      rxBytes: 20,
      txBytes: 9,
    });
    vi.spyOn(bandwidthHistoryRepository, 'insertHourlyRollup').mockImplementation(() => {
      throw new Error('falha ao gravar rollup (simulado)');
    });

    bandwidthHistoryService.runRollupAndCleanup(new Date('2026-07-27T12:00:00.000Z'));

    expect(consoleSpy).toHaveBeenCalled();
    expect(
      bandwidthHistoryRepository
        .listSamples({ from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z' })
        .filter((s) => s.mac === 'ordem:mac'),
    ).toHaveLength(2);
  });

  // Uma única amostra na hora não é "uso zero", é "não medido" — ver o
  // comentário de rxBytesDelta em runRollupAndCleanup.
  it('hora com uma única amostra vira delta null (não 0)', () => {
    bandwidthHistoryRepository.insertSample({
      collectedAt: '2026-07-20T03:40:00.000Z',
      scope: 'client',
      mac: 'sozinha:mac',
      label: 'Cliente Solitário',
      rxBytes: 5000,
      txBytes: 2500,
    });

    bandwidthHistoryService.runRollupAndCleanup(new Date('2026-07-22T12:00:00.000Z'));

    const rollup = bandwidthHistoryRepository
      .listHourlyRollups({ from: '2000-01-01T00:00:00.000Z', to: '2999-01-01T00:00:00.000Z' })
      .find((r) => r.mac === 'sozinha:mac');
    expect(rollup).toBeDefined();
    expect(rollup!.hourStart).toBe('2026-07-20T03:00:00.000Z');
    expect(rollup!.rxBytesDelta).toBeNull();
    expect(rollup!.txBytesDelta).toBeNull();
  });

  it('falha no job não derruba o processo — só loga e devolve na próxima execução', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(bandwidthHistoryRepository, 'listSamplesOlderThan').mockImplementation(() => {
      throw new Error('banco indisponível (simulado)');
    });

    expect(() => bandwidthHistoryService.runRollupAndCleanup(new Date('2026-09-05T00:00:00.000Z'))).not.toThrow();
    expect(consoleSpy).toHaveBeenCalled();
  });
});

describe('getLongRange — combina amostras finas + rollup horário', () => {
  it('sem filtro nenhum, devolve os dois trechos ordenados por tempo, no shape de BandwidthDelta', () => {
    // Trecho "antigo" (rollup) — uma hora, um device.
    bandwidthHistoryRepository.insertHourlyRollup({
      hourStart: '2026-05-01T08:00:00.000Z',
      scope: 'device',
      mac: 'aa:aa',
      label: 'AP 1',
      rxBytesDelta: 400,
      txBytesDelta: 100,
    });
    // Trecho "recente" (fino) — duas amostras consecutivas do mesmo device,
    // que viram um delta via computeDelta().
    bandwidthHistoryRepository.insertSample({
      collectedAt: '2026-05-02T08:00:00.000Z',
      scope: 'device',
      mac: 'bb:bb',
      label: 'AP 2',
      rxBytes: 1000,
      txBytes: 500,
    });
    bandwidthHistoryRepository.insertSample({
      collectedAt: '2026-05-02T08:05:00.000Z',
      scope: 'device',
      mac: 'bb:bb',
      label: 'AP 2',
      rxBytes: 1500,
      txBytes: 700,
    });

    const result = bandwidthHistoryService.getLongRange({
      from: '2026-05-01T00:00:00.000Z',
      to: '2026-05-03T00:00:00.000Z',
    });

    expect(result).toEqual([
      {
        intervalStart: '2026-05-01T08:00:00.000Z',
        intervalEnd: '2026-05-01T09:00:00.000Z',
        perDevice: [{ mac: 'aa:aa', name: 'AP 1', rxBytes: 400, txBytes: 100 }],
        perClient: [],
      },
      {
        intervalStart: '2026-05-02T08:00:00.000Z',
        intervalEnd: '2026-05-02T08:05:00.000Z',
        perDevice: [{ mac: 'bb:bb', name: 'AP 2', rxBytes: 500, txBytes: 200 }],
        perClient: [],
      },
    ]);
  });

  it('filtra por mac quando informado', () => {
    bandwidthHistoryRepository.insertHourlyRollup({
      hourStart: '2026-06-01T08:00:00.000Z',
      scope: 'device',
      mac: 'filtrar:este',
      label: 'Alvo',
      rxBytesDelta: 10,
      txBytesDelta: 10,
    });
    bandwidthHistoryRepository.insertHourlyRollup({
      hourStart: '2026-06-01T08:00:00.000Z',
      scope: 'device',
      mac: 'ignorar:este',
      label: 'Outro',
      rxBytesDelta: 99,
      txBytesDelta: 99,
    });

    const result = bandwidthHistoryService.getLongRange({
      mac: 'filtrar:este',
      from: '2026-06-01T00:00:00.000Z',
      to: '2026-06-02T00:00:00.000Z',
    });

    expect(result).toHaveLength(1);
    expect(result[0].perDevice).toEqual([{ mac: 'filtrar:este', name: 'Alvo', rxBytes: 10, txBytes: 10 }]);
  });

  // Regressão: `from`/`to` são comparados como TEXTO no SQLite contra
  // timestamps gravados em ISO-8601 UTC canônico. Um `from` com offset de
  // fuso (aceito pelo schema da rota, e o natural para America/São_Paulo) ou
  // sem milissegundos não casava com nada — resposta vazia, sem erro.
  it('aceita from/to com offset de fuso e sem milissegundos, convertendo para UTC canônico', () => {
    bandwidthHistoryRepository.insertHourlyRollup({
      hourStart: '2026-03-10T11:00:00.000Z', // == 08:00 em America/São_Paulo (-03:00)
      scope: 'device',
      mac: 'fuso:mac',
      label: 'AP Fuso',
      rxBytesDelta: 7,
      txBytesDelta: 3,
    });

    const comOffset = bandwidthHistoryService.getLongRange({
      mac: 'fuso:mac',
      from: '2026-03-10T08:00:00-03:00',
      to: '2026-03-10T09:00:00-03:00',
    });
    expect(comOffset).toHaveLength(1);
    expect(comOffset[0].intervalStart).toBe('2026-03-10T11:00:00.000Z');

    // Limite exato, em UTC sem milissegundos: a hora começa exatamente em
    // `from` e precisa entrar na janela.
    const semMilissegundos = bandwidthHistoryService.getLongRange({
      mac: 'fuso:mac',
      from: '2026-03-10T11:00:00Z',
      to: '2026-03-10T12:00:00Z',
    });
    expect(semMilissegundos).toHaveLength(1);
  });

  it('from/to inválido falha alto, em vez de devolver lista vazia como se não houvesse dado', () => {
    expect(() => bandwidthHistoryService.getLongRange({ from: 'ontem' })).toThrow(TypeError);
    expect(() => bandwidthHistoryService.getLongRange({ to: 'amanhã' })).toThrow(TypeError);
  });

  it('sem from/to, assume os últimos 30 dias (não lança e não inclui dado fora da janela padrão)', () => {
    bandwidthHistoryRepository.insertHourlyRollup({
      hourStart: '2000-01-01T00:00:00.000Z', // bem antes de qualquer janela padrão de 30 dias
      scope: 'device',
      mac: 'fora:da:janela',
      label: 'Muito antigo',
      rxBytesDelta: 1,
      txBytesDelta: 1,
    });

    const result = bandwidthHistoryService.getLongRange();
    expect(result.some((entry) => entry.perDevice.some((d) => d.mac === 'fora:da:janela'))).toBe(false);
  });
});
