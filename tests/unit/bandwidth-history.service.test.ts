import { describe, expect, it } from 'vitest';
import { computeDelta, type BandwidthSnapshot } from '../../src/services/bandwidth-history.service.js';

// Importar bandwidth-history.service.ts dispara startPolling() (setInterval
// real), mas o timer é unref()'d propositalmente — não impede este arquivo
// de terminar, e o intervalo é de 5 minutos, bem além da duração de um
// teste. computeDelta() em si é pura (só opera sobre os snapshots
// recebidos), então testamos ela isolada, sem mockar rede.
function snapshot(
  timestamp: string,
  perDevice: BandwidthSnapshot['perDevice'],
  perClient: BandwidthSnapshot['perClient'] = [],
): BandwidthSnapshot {
  return { timestamp, perDevice, perClient };
}

describe('computeDelta', () => {
  it('retorna lista vazia com 0 ou 1 snapshot (nada pra comparar)', () => {
    expect(computeDelta([])).toEqual([]);
    expect(computeDelta([snapshot('t0', [])])).toEqual([]);
  });

  it('calcula a diferença de bytes entre duas amostras consecutivas', () => {
    const snapshots = [
      snapshot(
        't0',
        [{ mac: 'aa:bb', name: 'AP Sala', rxBytes: 1000, txBytes: 500 }],
        [{ mac: '11:22', hostname: 'iPhone', rxBytes: 200, txBytes: 100 }],
      ),
      snapshot(
        't1',
        [{ mac: 'aa:bb', name: 'AP Sala', rxBytes: 1500, txBytes: 700 }],
        [{ mac: '11:22', hostname: 'iPhone', rxBytes: 350, txBytes: 120 }],
      ),
    ];

    const deltas = computeDelta(snapshots);

    expect(deltas).toEqual([
      {
        intervalStart: 't0',
        intervalEnd: 't1',
        perDevice: [{ mac: 'aa:bb', name: 'AP Sala', rxBytes: 500, txBytes: 200 }],
        perClient: [{ mac: '11:22', hostname: 'iPhone', rxBytes: 150, txBytes: 20 }],
      },
    ]);
  });

  it('trata contador que zerou/diminuiu (restart/reconexão) como null, não negativo', () => {
    const snapshots = [
      snapshot('t0', [{ mac: 'aa:bb', name: 'AP Sala', rxBytes: 9000, txBytes: 4000 }]),
      // rxBytes caiu de 9000 pra 100 — o device reiniciou entre as duas
      // amostras e o contador zerou. txBytes segue crescendo normalmente.
      snapshot('t1', [{ mac: 'aa:bb', name: 'AP Sala', rxBytes: 100, txBytes: 4200 }]),
    ];

    const deltas = computeDelta(snapshots);

    expect(deltas[0].perDevice).toEqual([{ mac: 'aa:bb', name: 'AP Sala', rxBytes: null, txBytes: 200 }]);
  });

  it('trata device/cliente novo (sem amostra anterior) como null em vez de expor o valor cumulativo cru', () => {
    const snapshots = [
      snapshot('t0', [{ mac: 'aa:bb', name: 'AP Sala', rxBytes: 1000, txBytes: 500 }]),
      snapshot('t1', [
        { mac: 'aa:bb', name: 'AP Sala', rxBytes: 1100, txBytes: 550 },
        { mac: 'cc:dd', name: 'Switch Novo', rxBytes: 300, txBytes: 150 },
      ]),
    ];

    const deltas = computeDelta(snapshots);

    expect(deltas[0].perDevice).toEqual([
      { mac: 'aa:bb', name: 'AP Sala', rxBytes: 100, txBytes: 50 },
      { mac: 'cc:dd', name: 'Switch Novo', rxBytes: null, txBytes: null },
    ]);
  });

  it('produz N-1 deltas para N snapshots (uma entrada por par consecutivo)', () => {
    const snapshots = [
      snapshot('t0', [{ mac: 'aa:bb', name: 'AP', rxBytes: 0, txBytes: 0 }]),
      snapshot('t1', [{ mac: 'aa:bb', name: 'AP', rxBytes: 100, txBytes: 50 }]),
      snapshot('t2', [{ mac: 'aa:bb', name: 'AP', rxBytes: 300, txBytes: 80 }]),
    ];

    const deltas = computeDelta(snapshots);

    expect(deltas).toHaveLength(2);
    expect(deltas[0].intervalStart).toBe('t0');
    expect(deltas[1].intervalStart).toBe('t1');
  });
});
