import { describe, expect, it } from 'vitest';
import { computeDhcpRange } from '../../src/routes/networks.routes.js';

describe('computeDhcpRange', () => {
  it('caso normal: começa 10 endereços após a rede e termina antes do broadcast', () => {
    const range = computeDhcpRange('10.30.0.1', 24);

    expect(range).toEqual({ start: '10.30.0.10', stop: '10.30.0.254' });
  });

  it('colapsa para o menor intervalo válido numa sub-rede pequena (/30) sem inverter start/stop', () => {
    // 10.30.0.0/30 -> rede=10.30.0.0, broadcast=10.30.0.3, só 10.30.0.1 e
    // 10.30.0.2 são endereços utilizáveis. Gateway/host = 10.30.0.1.
    const range = computeDhcpRange('10.30.0.1', 30);

    // start nunca pode ficar maior que stop.
    expect(range.start).toBeDefined();
    expect(range.stop).toBeDefined();

    const toInt = (ip: string) =>
      ip
        .split('.')
        .map(Number)
        .reduce((acc, octet) => (acc << 8) + octet, 0) >>> 0;

    const start = toInt(range.start);
    const stop = toInt(range.stop);
    const network = toInt('10.30.0.0');
    const broadcast = toInt('10.30.0.3');

    expect(start).toBeLessThanOrEqual(stop);
    expect(start).toBeGreaterThan(network);
    expect(stop).toBeLessThanOrEqual(broadcast);

    // O range de DHCP não pode coincidir com o IP do gateway informado
    // (10.30.0.1) — do contrário o controller atribuiria por DHCP o mesmo
    // endereço já usado pelo gateway.
    expect(range.start).not.toBe('10.30.0.1');
    expect(range).toEqual({ start: '10.30.0.2', stop: '10.30.0.2' });
  });

  it('evita que o range de DHCP coincida com o IP do host informado numa sub-rede pequena, escolhendo o outro endereço utilizável', () => {
    // Mesma sub-rede /30, mas com o gateway no outro endereço utilizável
    // (10.30.0.2) — a colisão que seria produzida pelo colapso ingênuo
    // (sempre network+1) não deve ocorrer aqui.
    const range = computeDhcpRange('10.30.0.2', 30);

    expect(range).toEqual({ start: '10.30.0.1', stop: '10.30.0.1' });
    expect(range.start).not.toBe('10.30.0.2');
  });

  it('evita que o range de DHCP comece exatamente no IP do host informado no caso normal (sub-rede grande)', () => {
    // hostIpAddress coincide com o que seria network+10 (10.30.0.10) numa
    // /24 — o range deve avançar para o próximo IP livre.
    const range = computeDhcpRange('10.30.0.10', 24);

    expect(range.start).toBe('10.30.0.11');
    expect(range.stop).toBe('10.30.0.254');
    expect(range.start).not.toBe('10.30.0.10');
  });
});
