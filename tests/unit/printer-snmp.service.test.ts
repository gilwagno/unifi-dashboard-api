import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Testes do poller SNMP de impressoras (Onda 2, subtarefa 5).
//
// A camada SNMP é INTEIRAMENTE mockada aqui — nada de rede real na suíte
// automatizada (seria lento e flaky em CI). A investigação contra as 3
// impressoras reais foi feita à parte, com uma sonda descartável, e os
// achados dela viraram os casos abaixo: sentinelas -1/-2/-3 reais das
// Brother, nível maior que a capacidade da HP, semântica de OID não
// suportado diferente entre v1 (NoSuchName no PDU inteiro) e v2c
// (noSuchObject por varbind), e walk por getNext.

// --- Agente SNMP falso ---------------------------------------------------

const OCTET_STRING = 4;
const INTEGER = 2;
const COUNTER = 65;
const NO_SUCH_OBJECT = 128;

type FakeVarbind = { oid: string; type: number; value: Buffer | number | string | null };

interface FakeDevice {
  // OIDs que o "equipamento" responde, na ordem em que estão na MIB.
  entries: Record<string, FakeVarbind['value'] | { type: number; value: FakeVarbind['value'] }>;
  // 'v2c' devolve noSuchObject por varbind; 'v1' derruba o PDU inteiro com
  // NoSuchName (semântica real da RFC 1157, confirmada nas 3 impressoras).
  noSuchOidStyle?: 'v1' | 'v2c';
  // Quando true, toda requisição estoura timeout (impressora desligada,
  // firewall bloqueando UDP 161, IP trocado).
  unreachable?: boolean;
  // Simula um erro construído PELA PRÓPRIA lib net-snmp (não pelo código
  // do poller) quando o OID pedido bate com esta chave — usado para provar
  // que erros nativos da lib (ex.: ResponseInvalidError de mismatch de
  // community, que embute a community em texto puro no `.message`) também
  // passam pela sanitização antes de log, não só os erros que o poller
  // mesmo constrói (timeout, NoSuchName).
  libErrorOn?: Record<string, Error>;
}

const devices = new Map<string, FakeDevice>();
const sessionCalls: Array<{ kind: 'v1v2c' | 'v3'; host: string; community?: string; user?: unknown; options?: unknown }> =
  [];

function oidCompare(a: string, b: string): number {
  const arcsA = a.split('.').map(Number);
  const arcsB = b.split('.').map(Number);
  for (let i = 0; i < Math.max(arcsA.length, arcsB.length); i++) {
    const x = arcsA[i] ?? -1;
    const y = arcsB[i] ?? -1;
    if (x !== y) return x - y;
  }
  return 0;
}

function normalize(oid: string, raw: FakeDevice['entries'][string]): FakeVarbind {
  if (raw !== null && typeof raw === 'object' && !Buffer.isBuffer(raw) && 'type' in raw) {
    return { oid, type: raw.type, value: raw.value };
  }
  const value = raw as FakeVarbind['value'];
  const type = Buffer.isBuffer(value) ? OCTET_STRING : INTEGER;
  return { oid, type, value };
}

function makeSession(host: string) {
  const device = devices.get(host);

  const respond = (
    callback: (error: Error | null, varbinds: FakeVarbind[]) => void,
    produce: () => { error: Error | null; varbinds: FakeVarbind[] },
  ) => {
    // Assíncrono, como a lib de verdade.
    setTimeout(() => {
      const { error, varbinds } = produce();
      callback(error, varbinds);
    }, 0);
  };

  const timeoutError = () => {
    const err = new Error('Request timed out');
    err.name = 'RequestTimedOutError';
    return err;
  };

  const noSuchName = (oid: string) => {
    const err = new Error(`NoSuchName: ${oid}`);
    err.name = 'RequestFailedError';
    return err;
  };

  return {
    get(oids: string[], callback: (error: Error | null, varbinds: FakeVarbind[]) => void) {
      respond(callback, () => {
        if (!device || device.unreachable) return { error: timeoutError(), varbinds: [] };
        const libError = device.libErrorOn?.[oids[0]];
        if (libError) return { error: libError, varbinds: [] };
        const varbinds: FakeVarbind[] = [];
        for (const oid of oids) {
          if (!(oid in device.entries)) {
            if (device.noSuchOidStyle === 'v1') return { error: noSuchName(oid), varbinds: [] };
            varbinds.push({ oid, type: NO_SUCH_OBJECT, value: null });
            continue;
          }
          varbinds.push(normalize(oid, device.entries[oid]));
        }
        return { error: null, varbinds };
      });
      return this;
    },
    getNext(oids: string[], callback: (error: Error | null, varbinds: FakeVarbind[]) => void) {
      respond(callback, () => {
        if (!device || device.unreachable) return { error: timeoutError(), varbinds: [] };
        const sorted = Object.keys(device.entries).sort(oidCompare);
        const next = sorted.find((candidate) => oidCompare(candidate, oids[0]) > 0);
        if (!next) {
          // Fim da MIB.
          if (device.noSuchOidStyle === 'v1') return { error: noSuchName(oids[0]), varbinds: [] };
          return { error: null, varbinds: [{ oid: oids[0], type: NO_SUCH_OBJECT, value: null }] };
        }
        return { error: null, varbinds: [normalize(next, device.entries[next])] };
      });
      return this;
    },
    close() {},
    on() {},
  };
}

vi.mock('net-snmp', () => {
  const api = {
    createSession: (host: string, community: string, options: unknown) => {
      sessionCalls.push({ kind: 'v1v2c', host, community, options });
      return makeSession(host);
    },
    createV3Session: (host: string, user: unknown, options: unknown) => {
      sessionCalls.push({ kind: 'v3', host, user, options });
      return makeSession(host);
    },
    isVarbindError: (vb: FakeVarbind) => vb.type === 128 || vb.type === 129 || vb.type === 130,
    varbindError: (vb: FakeVarbind) => `NoSuchObject: ${vb.oid}`,
    Version1: 0,
    Version2c: 1,
    Version3: 3,
    ObjectType: {},
    AuthProtocols: {},
    PrivProtocols: {},
    SecurityLevel: {},
  };
  return { ...api, default: api };
});

// --- Cadastro de impressoras falso ---------------------------------------

interface FakePrinter {
  id: string;
  name: string;
  mac: string;
  ipOverride: string | null;
  snmpVersion: 'v1' | 'v2c' | 'v3';
  snmpSecret: string;
}

let registeredPrinters: FakePrinter[] = [];

// Registra cada chamada de gravação de histórico (subtarefa 12), sem
// persistir de verdade — o repositório em si já tem cobertura própria
// (tests/unit/printers.db.test.ts). O que este arquivo testa é que o
// POLLER chama o repositório com os dados certos, no momento certo, e que
// uma falha nessa escrita não derruba nada.
const recordSnmpHistoryEntryMock = vi.fn();
let recordSnmpHistoryEntryShouldThrow = false;
const deleteSnmpHistoryOlderThanMock = vi.fn(() => 0);
let deleteSnmpHistoryOlderThanShouldThrow = false;

vi.mock('../../src/db/printers.instance.js', () => ({
  printersRepository: {
    listAll: () => registeredPrinters,
    recordSnmpHistoryEntry: (...args: unknown[]) => {
      if (recordSnmpHistoryEntryShouldThrow) throw new Error('falha ao gravar histórico (simulado)');
      return recordSnmpHistoryEntryMock(...args);
    },
    deleteSnmpHistoryOlderThan: (...args: unknown[]) => {
      if (deleteSnmpHistoryOlderThanShouldThrow) throw new Error('falha ao limpar histórico (simulado)');
      return deleteSnmpHistoryOlderThanMock(...args);
    },
  },
}));

// Resolução de IP via merge de status do UniFi (subtarefa 2) — mockada para
// não tocar o controller. `null` = MAC desconhecido pelo controller.
let networkIpByMac: Record<string, string | null> = {};

vi.mock('../../src/services/printer-network-status.service.js', () => ({
  buildNetworkStatusResolver: async () => (mac: string) => ({
    source: networkIpByMac[mac] ? 'classic' : 'unknown',
    online: null,
    ipAddress: networkIpByMac[mac] ?? null,
    connectionType: null,
  }),
}));

const {
  collectAllReadings,
  getLastReading,
  computeLevelPercent,
  toMeasurement,
  runSnmpHistoryCleanup,
  parseSupplyDescription,
  supplyDisplayName,
} = await import('../../src/services/printer-snmp.service.js');

// --- Dados de referência (colhidos das impressoras reais) ----------------

const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  deviceDescr: '1.3.6.1.2.1.25.3.2.1.3.1',
  deviceStatus: '1.3.6.1.2.1.25.3.2.1.5.1',
  errorState: '1.3.6.1.2.1.25.3.5.1.2.1',
  lifeCount: '1.3.6.1.2.1.43.10.2.1.4.1.1',
  powerOnCount: '1.3.6.1.2.1.43.10.2.1.5.1.1',
  type: '1.3.6.1.2.1.43.11.1.1.5',
  description: '1.3.6.1.2.1.43.11.1.1.6',
  unit: '1.3.6.1.2.1.43.11.1.1.7',
  maxCapacity: '1.3.6.1.2.1.43.11.1.1.8',
  level: '1.3.6.1.2.1.43.11.1.1.9',
};

// Réplica fiel da resposta real da Brother HL-L2360D (172.16.0.222): toner
// com nível -3 (partial) e capacidade -2 (unknown), drum com valores reais.
function brotherHlEntries(): FakeDevice['entries'] {
  return {
    [OID.sysDescr]: Buffer.from('Brother NC-8300w, Firmware Ver.Z  ,MID 84U-F77'),
    [OID.deviceDescr]: Buffer.from('Brother HL-L2360D series'),
    [OID.deviceStatus]: 2,
    [OID.errorState]: Buffer.from([0x00]),
    [OID.lifeCount]: { type: COUNTER, value: 52994 },
    // Valor real observado na Brother HL-L2360D (172.16.0.222) — subtarefa
    // 19, achado (e): OID padrão RFC 3805, nunca lido pelo poller até aqui.
    [OID.powerOnCount]: { type: COUNTER, value: 226 },
    [`${OID.type}.1.1`]: 3,
    [`${OID.type}.1.2`]: 9,
    [`${OID.description}.1.1`]: Buffer.from('Black Toner Cartridge'),
    [`${OID.description}.1.2`]: Buffer.from('Drum Unit'),
    [`${OID.unit}.1.1`]: 13,
    [`${OID.unit}.1.2`]: 7,
    [`${OID.maxCapacity}.1.1`]: -2,
    [`${OID.maxCapacity}.1.2`]: 12000,
    [`${OID.level}.1.1`]: -3,
    [`${OID.level}.1.2`]: 8278,
  };
}

function printer(overrides: Partial<FakePrinter> = {}): FakePrinter {
  return {
    id: 'p1',
    name: 'Brother Vendas',
    mac: 'e8:6f:38:ba:b9:32',
    ipOverride: '10.0.0.10',
    snmpVersion: 'v2c',
    snmpSecret: JSON.stringify({ community: 'public' }),
    ...overrides,
  };
}

let consoleErrors: string[] = [];
let consoleWarns: string[] = [];

beforeEach(() => {
  devices.clear();
  sessionCalls.length = 0;
  registeredPrinters = [];
  networkIpByMac = {};
  consoleErrors = [];
  consoleWarns = [];
  recordSnmpHistoryEntryMock.mockClear();
  recordSnmpHistoryEntryShouldThrow = false;
  deleteSnmpHistoryOlderThanMock.mockClear();
  deleteSnmpHistoryOlderThanShouldThrow = false;
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => {
    consoleErrors.push(args.map((a) => (a instanceof Error ? a.stack ?? a.message : String(a))).join(' '));
  });
  vi.spyOn(console, 'warn').mockImplementation((...args: unknown[]) => {
    consoleWarns.push(args.map((a) => (a instanceof Error ? a.stack ?? a.message : String(a))).join(' '));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('toMeasurement — sentinelas da RFC 3805', () => {
  it('mapeia os 3 sentinelas (-1 other, -2 unknown, -3 partial) sem virar número', () => {
    expect(toMeasurement(-1)).toEqual({ status: 'other' });
    expect(toMeasurement(-2)).toEqual({ status: 'unknown' });
    expect(toMeasurement(-3)).toEqual({ status: 'partial' });
  });

  it('trata valor normal como ok e negativo fora da RFC como other (nunca NaN/Infinity)', () => {
    expect(toMeasurement(8278)).toEqual({ status: 'ok', value: 8278 });
    expect(toMeasurement(0)).toEqual({ status: 'ok', value: 0 });
    expect(toMeasurement(-99)).toEqual({ status: 'other' });
    expect(toMeasurement(Number.NaN)).toEqual({ status: 'error' });
    expect(toMeasurement(Number.POSITIVE_INFINITY)).toEqual({ status: 'error' });
  });
});

describe('computeLevelPercent', () => {
  it('não calcula percentual a partir de nenhum dos 3 sentinelas', () => {
    for (const status of ['other', 'unknown', 'partial'] as const) {
      expect(computeLevelPercent({ status }, { status: 'ok', value: 100 }, 19)).toBeNull();
    }
  });

  it('usa o próprio nível quando a unidade é percent (19)', () => {
    expect(computeLevelPercent({ status: 'ok', value: 42 }, { status: 'unknown' }, 19)).toBe(42);
  });

  it('calcula nível/capacidade quando ambos são valores reais', () => {
    expect(computeLevelPercent({ status: 'ok', value: 8278 }, { status: 'ok', value: 12000 }, 7)).toBe(69);
  });

  it('devolve null quando o nível é maior que a capacidade (bug real do firmware da HP: 143066 de 100)', () => {
    expect(computeLevelPercent({ status: 'ok', value: 143066 }, { status: 'ok', value: 100 }, 19)).toBeNull();
    expect(computeLevelPercent({ status: 'ok', value: 143066 }, { status: 'ok', value: 100 }, 7)).toBeNull();
  });

  it('devolve null quando a capacidade é 0 ou desconhecida e a unidade não é percent', () => {
    expect(computeLevelPercent({ status: 'ok', value: 5 }, { status: 'ok', value: 0 }, 7)).toBeNull();
    expect(computeLevelPercent({ status: 'ok', value: 5 }, { status: 'unknown' }, 7)).toBeNull();
  });
});

// Subtarefa 19, achado (a): as 2 HPs reais da rede embutem o número de série
// do cartucho na própria prtMarkerSuppliesDescription, no padrão
// "<nome> S/N:<serial>" — confirmado por SNMP GET real contra elas
// (community "public", só leitura). As 3 Brother reais não têm esse sufixo.
describe('parseSupplyDescription', () => {
  it('extrai nome e serial do padrão real das 2 HPs ("<nome> S/N:<serial>")', () => {
    expect(parseSupplyDescription('Black Toner S/N:CRUM-210729A5BB3')).toEqual({
      name: 'Black Toner',
      serialNumber: 'CRUM-210729A5BB3',
    });
  });

  it('sem "S/N:" (padrão real das 3 Brother): serialNumber null, nome intacto', () => {
    expect(parseSupplyDescription('Black Toner Cartridge')).toEqual({
      name: 'Black Toner Cartridge',
      serialNumber: null,
    });
  });

  it('description null (OID não suportado/nunca coletado): tudo null, sem lançar', () => {
    expect(parseSupplyDescription(null)).toEqual({ name: null, serialNumber: null });
  });

  it('description que é SÓ o "S/N:<serial>", sem nome antes: name vira null (nunca string vazia)', () => {
    expect(parseSupplyDescription('S/N:ABC123')).toEqual({ name: null, serialNumber: 'ABC123' });
  });

  it('"S/N:" no meio do texto (não no fim) não é reconhecido como o padrão observado — não inventa um corte que nunca foi confirmado nas impressoras reais', () => {
    expect(parseSupplyDescription('S/N:ABC123 Black Toner')).toEqual({
      name: 'S/N:ABC123 Black Toner',
      serialNumber: null,
    });
  });

  // Achado 2 da revisão crítica: o ramo SEM "S/N:" não aparava espaço nem
  // tratava vazio/só-espaço como ausente — duas descriptions da MESMA
  // leitura podiam receber tratamento de espaço diferente (uma com "S/N:"
  // já saía aparada, a outra não).
  it('apara espaço também no ramo sem "S/N:" (mesmo tratamento do ramo com serial)', () => {
    expect(parseSupplyDescription('  Black Toner Cartridge  ')).toEqual({
      name: 'Black Toner Cartridge',
      serialNumber: null,
    });
  });

  it('description vazia ou só espaço (sem "S/N:") vira name null — cai no fallback (typeLabel/índice), não um rótulo vazio na UI', () => {
    expect(parseSupplyDescription('')).toEqual({ name: null, serialNumber: null });
    expect(parseSupplyDescription('   ')).toEqual({ name: null, serialNumber: null });
  });

  // Achado 3 da revisão crítica (endurecimento, não confirmado contra
  // hardware real): caracteres de controle (NUL etc.) não são `\s`, então
  // `\S+` sozinho os deixaria entrar no valor do serial.
  it('exclui caracteres de controle (NUL) do valor do serial, mesmo como padding no fim', () => {
    expect(parseSupplyDescription('Black Toner S/N:ABC\u0000')).toEqual({
      name: 'Black Toner',
      serialNumber: 'ABC',
    });
  });

  it('continua tolerando espaço em branco de verdade (tab/CR/LF) como padding no fim do serial', () => {
    expect(parseSupplyDescription('Black Toner S/N:ABC\t\r\n')).toEqual({
      name: 'Black Toner',
      serialNumber: 'ABC',
    });
  });
});

describe('supplyDisplayName', () => {
  it('usa o nome sem o serial quando description tem "S/N:"', () => {
    expect(
      supplyDisplayName({ description: 'Black Toner S/N:CRUM-210729A5BB3', typeLabel: 'toner', index: '1.1' }),
    ).toBe('Black Toner');
  });

  it('cai no typeLabel quando description é null (mesmo fallback de antes da subtarefa 19)', () => {
    expect(supplyDisplayName({ description: null, typeLabel: 'fuser', index: '1.5' })).toBe('fuser');
  });

  it('cai no índice quando description E typeLabel são null (mesmo fallback de antes da subtarefa 19)', () => {
    expect(supplyDisplayName({ description: null, typeLabel: null, index: '1.1' })).toBe('Suprimento 1.1');
  });
});

describe('poller SNMP — coleta', () => {
  it('coleta uma leitura completa e trata -3/-2 (partial/unknown) da Brother real', async () => {
    registeredPrinters = [printer()];
    devices.set('10.0.0.10', { entries: brotherHlEntries(), noSuchOidStyle: 'v2c' });

    await collectAllReadings();

    const reading = getLastReading('p1');
    expect(reading).toBeDefined();
    expect(reading!.ipAddress).toBe('10.0.0.10');
    expect(reading!.sysDescr).toContain('Brother NC-8300w');
    expect(reading!.deviceDescr).toBe('Brother HL-L2360D series');
    expect(reading!.deviceStatus).toEqual({ status: 'ok', value: 2 });
    expect(reading!.deviceStatusLabel).toBe('running');
    expect(reading!.pageCount).toEqual({ status: 'ok', value: 52994 });
    expect(reading!.powerOnCount).toEqual({ status: 'ok', value: 226 });
    expect(reading!.detectedErrorStates).toEqual([]);

    expect(reading!.supplies).toHaveLength(2);
    const [toner, drum] = reading!.supplies;

    expect(toner.description).toBe('Black Toner Cartridge');
    expect(toner.serialNumber).toBeNull();
    expect(toner.typeLabel).toBe('toner');
    // Sentinelas reais: nível partial(-3), capacidade unknown(-2).
    expect(toner.level).toEqual({ status: 'partial' });
    expect(toner.maxCapacity).toEqual({ status: 'unknown' });
    expect(toner.levelPercent).toBeNull();

    expect(drum.description).toBe('Drum Unit');
    expect(drum.typeLabel).toBe('opc');
    expect(drum.level).toEqual({ status: 'ok', value: 8278 });
    expect(drum.maxCapacity).toEqual({ status: 'ok', value: 12000 });
    expect(drum.levelPercent).toBe(69);
  });

  it('mapeia other(-1) num suprimento sem contaminar os outros campos', async () => {
    const entries = brotherHlEntries();
    entries[`${OID.level}.1.1`] = -1;
    registeredPrinters = [printer()];
    devices.set('10.0.0.10', { entries, noSuchOidStyle: 'v2c' });

    await collectAllReadings();

    const reading = getLastReading('p1')!;
    expect(reading.supplies[0].level).toEqual({ status: 'other' });
    expect(reading.supplies[0].levelPercent).toBeNull();
    // O outro suprimento e o contador de páginas seguem válidos.
    expect(reading.supplies[1].level).toEqual({ status: 'ok', value: 8278 });
    expect(reading.pageCount).toEqual({ status: 'ok', value: 52994 });
  });

  it('decodifica o bitmap hrPrinterDetectedErrorState (0x20 = lowToner, como a DCP-L3560CDW real)', async () => {
    const entries = brotherHlEntries();
    entries[OID.errorState] = Buffer.from([0x20]);
    entries[OID.deviceStatus] = 3;
    registeredPrinters = [printer()];
    devices.set('10.0.0.10', { entries, noSuchOidStyle: 'v2c' });

    await collectAllReadings();

    const reading = getLastReading('p1')!;
    expect(reading.detectedErrorStates).toEqual(['lowToner']);
    expect(reading.deviceStatusLabel).toBe('warning');
  });

  it('trata OID não suportado em v2c (noSuchObject) como "não suportado", sem derrubar os outros campos', async () => {
    const entries = brotherHlEntries();
    delete entries[OID.lifeCount]; // modelo sem contador de páginas
    registeredPrinters = [printer()];
    devices.set('10.0.0.10', { entries, noSuchOidStyle: 'v2c' });

    await collectAllReadings();

    const reading = getLastReading('p1')!;
    expect(reading.pageCount).toEqual({ status: 'unsupported' });
    expect(reading.partial).toBe(true);
    // Suprimentos e identificação continuam coletados normalmente.
    expect(reading.supplies).toHaveLength(2);
    expect(reading.sysDescr).toContain('Brother');
  });

  it('prtMarkerPowerOnCount não suportado neste modelo vira "unsupported", sem contaminar os demais campos', async () => {
    const entries = brotherHlEntries();
    delete entries[OID.powerOnCount];
    registeredPrinters = [printer({ id: 'p-sem-poweroncount' })];
    devices.set('10.0.0.10', { entries, noSuchOidStyle: 'v2c' });

    await collectAllReadings();

    const reading = getLastReading('p-sem-poweroncount')!;
    expect(reading.powerOnCount).toEqual({ status: 'unsupported' });
    expect(reading.partial).toBe(true);
    // O resto da leitura segue válido — um campo novo/opcional não pode
    // contaminar os demais.
    expect(reading.pageCount).toEqual({ status: 'ok', value: 52994 });
    expect(reading.supplies).toHaveLength(2);
  });

  // Achado real, subtarefa 19: as 2 HPs da rede embutem o serial do
  // cartucho na própria description ("Black Toner S/N:CRUM-...") — o poller
  // precisa extrair isso na leitura, não só a rota.
  it('extrai serialNumber de prtMarkerSuppliesDescription no formato real das 2 HPs, na própria leitura', async () => {
    const entries = brotherHlEntries();
    entries[`${OID.description}.1.1`] = Buffer.from('Black Toner S/N:CRUM-210729A5BB3');
    registeredPrinters = [printer({ id: 'p-com-serial' })];
    devices.set('10.0.0.10', { entries, noSuchOidStyle: 'v2c' });

    await collectAllReadings();

    const reading = getLastReading('p-com-serial')!;
    expect(reading.supplies[0].description).toBe('Black Toner S/N:CRUM-210729A5BB3');
    expect(reading.supplies[0].serialNumber).toBe('CRUM-210729A5BB3');
    // O outro suprimento (sem "S/N:" na description) continua sem serial.
    expect(reading.supplies[1].serialNumber).toBeNull();
  });

  it('trata OID não suportado em v1 (NoSuchName derruba o PDU inteiro) sem perder os demais campos', async () => {
    // id PRÓPRIO (achado do crítico): o buffer `lastReadings` é estado de
    // módulo não zerado entre testes (ver nota acima). Reaproveitar 'p1'
    // aqui mascararia uma quebra real do tratamento de v1 — se
    // `readPrinter` lançasse (ex.: NoSuchName tratado como erro fatal em
    // vez de "não suportado"), o catch de `collectAllReadings` simplesmente
    // preservaria a leitura antiga do teste anterior (v2c, também com
    // pageCount 'unsupported' e 2 supplies) e as asserções abaixo passariam
    // "por coincidência" mesmo com o comportamento de v1 quebrado.
    const entries = brotherHlEntries();
    delete entries[OID.lifeCount];
    registeredPrinters = [printer({ id: 'p1-v1', snmpVersion: 'v1' })];
    devices.set('10.0.0.10', { entries, noSuchOidStyle: 'v1' });

    await collectAllReadings();

    const reading = getLastReading('p1-v1')!;
    // Este é o motivo de cada escalar ser buscado numa requisição própria:
    // em v1, um GET com vários OIDs falharia inteiro por causa deste um.
    expect(reading.pageCount).toEqual({ status: 'unsupported' });
    expect(reading.partial).toBe(true);
    expect(reading.deviceDescr).toBe('Brother HL-L2360D series');
    expect(reading.supplies).toHaveLength(2);
  });

  // NOTA: o buffer de últimas leituras é estado de MÓDULO (igual
  // bandwidth-history.service.ts) e não é zerado entre testes — de
  // propósito, é o comportamento real do poller. Por isso todo teste que
  // afirma "não há leitura" usa um id de impressora próprio, em vez de
  // reaproveitar o 'p1' que outros testes já preencheram.
  it('não grava leitura quando a impressora está inalcançável (timeout), e loga sem derrubar o poller', async () => {
    registeredPrinters = [printer({ id: 'p-offline' })];
    devices.set('10.0.0.10', { entries: {}, unreachable: true });

    await expect(collectAllReadings()).resolves.toBeUndefined();

    expect(getLastReading('p-offline')).toBeUndefined();
    expect(consoleErrors.join('\n')).toContain('falha ao coletar SNMP da impressora p-offline');
  });

  it('preserva a última leitura boa quando um ciclo seguinte falha', async () => {
    registeredPrinters = [printer()];
    devices.set('10.0.0.10', { entries: brotherHlEntries(), noSuchOidStyle: 'v2c' });
    await collectAllReadings();
    const first = getLastReading('p1');
    expect(first).toBeDefined();

    devices.set('10.0.0.10', { entries: {}, unreachable: true });
    await collectAllReadings();

    expect(getLastReading('p1')).toEqual(first);
  });

  it('uma impressora falhando não impede a coleta das outras', async () => {
    registeredPrinters = [
      printer({ id: 'quebrada', name: 'Offline', mac: 'aa:aa:aa:aa:aa:aa', ipOverride: '10.0.0.99' }),
      printer({ id: 'boa', name: 'Funciona', mac: 'bb:bb:bb:bb:bb:bb', ipOverride: '10.0.0.11' }),
    ];
    devices.set('10.0.0.99', { entries: {}, unreachable: true });
    devices.set('10.0.0.11', { entries: brotherHlEntries(), noSuchOidStyle: 'v2c' });

    await collectAllReadings();

    expect(getLastReading('quebrada')).toBeUndefined();
    expect(getLastReading('boa')).toBeDefined();
    expect(getLastReading('boa')!.supplies).toHaveLength(2);
    expect(consoleErrors.join('\n')).toContain('impressora quebrada');
  });
});

describe('poller SNMP — resolução de IP', () => {
  it('usa ipOverride quando definido, sem consultar o merge de status do UniFi', async () => {
    registeredPrinters = [printer({ ipOverride: '10.0.0.10' })];
    networkIpByMac['e8:6f:38:ba:b9:32'] = '192.168.99.99'; // ignorado
    devices.set('10.0.0.10', { entries: brotherHlEntries(), noSuchOidStyle: 'v2c' });

    await collectAllReadings();

    expect(getLastReading('p1')!.ipAddress).toBe('10.0.0.10');
    expect(sessionCalls[0].host).toBe('10.0.0.10');
  });

  it('cai para o IP do merge de status do UniFi quando não há ipOverride', async () => {
    registeredPrinters = [printer({ ipOverride: null })];
    networkIpByMac['e8:6f:38:ba:b9:32'] = '172.16.0.222';
    devices.set('172.16.0.222', { entries: brotherHlEntries(), noSuchOidStyle: 'v2c' });

    await collectAllReadings();

    expect(getLastReading('p1')!.ipAddress).toBe('172.16.0.222');
  });

  it('pula a impressora (com aviso) quando não há ipOverride nem IP conhecido no controller', async () => {
    registeredPrinters = [printer({ id: 'p-sem-ip', ipOverride: null })];

    await collectAllReadings();

    expect(getLastReading('p-sem-ip')).toBeUndefined();
    expect(consoleWarns.join('\n')).toContain('sem IP conhecido');
    expect(sessionCalls).toHaveLength(0);
  });
});

describe('poller SNMP — segredo nunca vaza em log', () => {
  it('não expõe a community string em nenhum log, mesmo quando a coleta falha', async () => {
    const secret = 'community-super-secreta-123';
    registeredPrinters = [printer({ snmpSecret: JSON.stringify({ community: secret }) })];
    devices.set('10.0.0.10', { entries: {}, unreachable: true });

    await collectAllReadings();

    // A sessão REALMENTE recebeu o segredo (senão o teste passaria por
    // vacuidade), mas nenhum log emitido pelo poller o contém.
    expect(sessionCalls[0].community).toBe(secret);
    const allLogs = [...consoleErrors, ...consoleWarns].join('\n');
    expect(allLogs).not.toContain(secret);
    expect(allLogs).not.toContain('community');
    expect(allLogs).toContain('falha ao coletar SNMP');
  });

  it('não expõe as credenciais SNMPv3 (senhas de auth/priv) em nenhum log', async () => {
    const authPassword = 'senha-auth-ultra-secreta';
    const privPassword = 'senha-priv-ultra-secreta';
    registeredPrinters = [
      printer({
        snmpVersion: 'v3',
        snmpSecret: JSON.stringify({
          v3Auth: { username: 'monitor', authProtocol: 'SHA', authPassword, privProtocol: 'AES', privPassword },
        }),
      }),
    ];
    devices.set('10.0.0.10', { entries: {}, unreachable: true });

    await collectAllReadings();

    const call = sessionCalls[0];
    expect(call.kind).toBe('v3');
    // authPriv (nível 3) porque auth e priv foram informados.
    expect(call.user).toMatchObject({ name: 'monitor', level: 3, authProtocol: 'sha', privProtocol: 'aes' });

    const allLogs = [...consoleErrors, ...consoleWarns].join('\n');
    expect(allLogs).not.toContain(authPassword);
    expect(allLogs).not.toContain(privPassword);
    expect(allLogs).not.toContain('monitor');
  });

  it('sanitiza um erro construído PELA PRÓPRIA lib net-snmp (não pelo poller) antes de logar', async () => {
    // Réplica textual exata de node_modules/net-snmp/index.js (linhas
    // ~2432-2435): quando a community da resposta não bate com a da
    // requisição, a lib cria um ResponseInvalidError cujo `.message` contém
    // a community EM TEXTO PURO. Isso não é um erro que o código do poller
    // constrói — chega pronto no callback de session.get(), então "nenhum
    // log do poller inclui o segredo" só vale se o poller sanitizar
    // qualquer `err.message` de terceiros antes de logar, não só os que ele
    // mesmo escreve.
    const secret = 'community-super-secreta-da-lib';
    const libError = new Error(
      `Community '${secret}' in request does not match community 'outra' in response`,
    );
    libError.name = 'ResponseInvalidError';

    registeredPrinters = [printer({ snmpSecret: JSON.stringify({ community: secret }) })];
    devices.set('10.0.0.10', {
      entries: {},
      libErrorOn: { [OID.sysDescr]: libError },
    });

    await collectAllReadings();

    const allLogs = [...consoleErrors, ...consoleWarns].join('\n');
    expect(allLogs).not.toContain(secret);
    expect(allLogs).toContain('falha ao coletar SNMP');
  });

  it('monta sessão v3 em noAuthNoPriv quando só o usuário foi cadastrado', async () => {
    registeredPrinters = [
      printer({
        id: 'p-v3-noauth',
        snmpVersion: 'v3',
        snmpSecret: JSON.stringify({ v3Auth: { username: 'somente-usuario' } }),
      }),
    ];
    devices.set('10.0.0.10', { entries: brotherHlEntries(), noSuchOidStyle: 'v2c' });

    await collectAllReadings();

    expect(sessionCalls[0].user).toMatchObject({ name: 'somente-usuario', level: 1 });
    expect(getLastReading('p-v3-noauth')).toBeDefined();
  });
});

// --- Histórico de leituras SNMP (Onda 2, subtarefa 12) ---------------------

describe('poller SNMP — persistência do histórico', () => {
  it('grava no histórico após uma leitura bem-sucedida, com o MESMO collectedAt do buffer em memória', async () => {
    registeredPrinters = [printer({ id: 'p-hist' })];
    devices.set('10.0.0.10', { entries: brotherHlEntries(), noSuchOidStyle: 'v2c' });

    await collectAllReadings();

    const reading = getLastReading('p-hist')!;
    expect(recordSnmpHistoryEntryMock).toHaveBeenCalledTimes(1);
    expect(recordSnmpHistoryEntryMock).toHaveBeenCalledWith('p-hist', {
      collectedAt: reading.collectedAt,
      pageCount: 52994,
      supplies: [
        { name: 'Black Toner Cartridge', levelPercent: null },
        { name: 'Drum Unit', levelPercent: 69 },
      ],
      partial: false,
    });
  });

  it('pageCount com sentinela vira null no histórico, igual a /consumables (mesma pageCountValue)', async () => {
    const entries = brotherHlEntries();
    delete entries[OID.lifeCount]; // -> pageCount 'unsupported'
    registeredPrinters = [printer({ id: 'p-hist-sentinela' })];
    devices.set('10.0.0.10', { entries, noSuchOidStyle: 'v2c' });

    await collectAllReadings();

    expect(recordSnmpHistoryEntryMock).toHaveBeenCalledWith(
      'p-hist-sentinela',
      expect.objectContaining({ pageCount: null }),
    );
  });

  it('impressora nunca lida com sucesso (offline) nunca grava histórico', async () => {
    registeredPrinters = [printer({ id: 'p-hist-offline' })];
    devices.set('10.0.0.10', { entries: {}, unreachable: true });

    await collectAllReadings();

    expect(recordSnmpHistoryEntryMock).not.toHaveBeenCalled();
  });

  it('falha ao gravar histórico NÃO impede getLastReading de funcionar nem derruba o poller', async () => {
    registeredPrinters = [
      printer({ id: 'p-hist-falha', mac: 'e8:6f:38:ba:b9:32', ipOverride: '10.0.0.10' }),
      printer({ id: 'p-hist-ok', mac: 'bb:bb:bb:bb:bb:bb', ipOverride: '10.0.0.11' }),
    ];
    devices.set('10.0.0.10', { entries: brotherHlEntries(), noSuchOidStyle: 'v2c' });
    devices.set('10.0.0.11', { entries: brotherHlEntries(), noSuchOidStyle: 'v2c' });
    recordSnmpHistoryEntryShouldThrow = true;

    await expect(collectAllReadings()).resolves.toBeUndefined();

    // O buffer em memória (o que /consumables e /diagnostics consultam)
    // continua funcionando normalmente, para as DUAS impressoras — a falha
    // de escrita em disco não contamina o resto do ciclo.
    expect(getLastReading('p-hist-falha')).toBeDefined();
    expect(getLastReading('p-hist-ok')).toBeDefined();
    expect(consoleErrors.join('\n')).toContain('falha ao persistir histórico');
  });

  it('não expõe o segredo SNMP no log de falha de persistência do histórico', async () => {
    const secret = 'community-do-historico-secreta';
    registeredPrinters = [printer({ snmpSecret: JSON.stringify({ community: secret }) })];
    devices.set('10.0.0.10', { entries: brotherHlEntries(), noSuchOidStyle: 'v2c' });
    recordSnmpHistoryEntryShouldThrow = true;

    await collectAllReadings();

    expect(consoleErrors.join('\n')).not.toContain(secret);
  });
});

describe('runSnmpHistoryCleanup — retenção de 90 dias', () => {
  it('calcula o corte como exatamente now - 90 dias e delega ao repositório', () => {
    const now = new Date('2026-09-01T00:00:00.000Z');
    runSnmpHistoryCleanup(now);

    expect(deleteSnmpHistoryOlderThanMock).toHaveBeenCalledTimes(1);
    expect(deleteSnmpHistoryOlderThanMock).toHaveBeenCalledWith('2026-06-03T00:00:00.000Z');
  });

  it('a fronteira de 90 dias é exata (não 89 nem 91)', () => {
    const now = new Date('2026-01-01T12:34:56.789Z');
    const expectedCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000).toISOString();

    runSnmpHistoryCleanup(now);

    expect(deleteSnmpHistoryOlderThanMock).toHaveBeenCalledWith(expectedCutoff);
    // Ancora a fronteira exata contra um valor cru calculado à mão, não só
    // contra a mesma fórmula usada pela implementação (que esconderia um
    // "off by 1 dia" se os dois lados repetissem o mesmo erro).
    expect(expectedCutoff).toBe('2025-10-03T12:34:56.789Z');
  });

  it('falha no job não derruba o processo — só loga e devolve na próxima execução', () => {
    deleteSnmpHistoryOlderThanShouldThrow = true;

    expect(() => runSnmpHistoryCleanup(new Date('2026-09-05T00:00:00.000Z'))).not.toThrow();
    expect(consoleErrors.join('\n')).toContain('falha no job de limpeza do histórico SNMP');
  });
});
