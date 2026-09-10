import snmp, { type Session as SnmpSession, type Varbind } from 'net-snmp';
import { printersRepository } from '../db/printers.instance.js';
import type { PrinterRecord, SnmpSecretInput, SnmpV3Auth } from '../db/printers.db.js';
import { buildNetworkStatusResolver } from './printer-network-status.service.js';

// Poller SNMP de consumíveis + contador de páginas (Onda 2, subtarefa 5).
//
// Modelado em bandwidth-history.service.ts: estado em memória a nível de
// módulo, `setInterval` unref()'d iniciado no import do módulo, sem coleta
// imediata no boot, e falha pontual logada e ignorada sem derrubar o
// processo nem o poller. Diferença: aqui não guardamos série temporal, só a
// ÚLTIMA leitura bem-sucedida por impressora (`getLastReading`), que é o que
// `GET /printers/:id/consumables` (subtarefa 6) vai expor.
//
// Onda 2, subtarefa 12: além do buffer em memória acima, cada leitura
// bem-sucedida TAMBÉM é persistida em `printer_snmp_history` (ver
// src/db/printers.db.ts) — a série temporal que o buffer em memória nunca
// guardou. Ver `persistReadingToHistory` e o job de retenção
// `runSnmpHistoryCleanup` mais abaixo, ambos modelados em
// bandwidth-history.service.ts (persistSnapshotToDb / runRollupAndCleanup):
// falha de escrita isolada por try/catch próprio, nunca derruba o poller.
//
// ============================================================================
// ACHADOS REAIS (sonda executada em 2026-08-31 contra as 3 impressoras da
// rede — HP Laser MFP 135w 172.16.0.89, Brother HL-L2360D 172.16.0.222,
// Brother DCP-L3560CDW 172.16.0.80). Estes achados ditam o desenho abaixo;
// não são suposições da documentação:
//
// 1. As 3 responderam com community "public" (v1 e v2c). Nenhuma exigiu
//    credencial diferente.
// 2. `getBulk` (usado internamente por `session.walk()`/`subtree()` do
//    net-snmp quando a versão é v2c/v3) NÃO funciona em 2 das 3: a HP
//    devolve `GeneralError` e a DCP-L3560CDW dá timeout. Já um walk manual
//    baseado em `getNext` funciona nas 3, em v1 E em v2c. Por isso este
//    módulo implementa `walkColumn()` com getNext em vez de usar o
//    walk/subtree da biblioteca.
// 3. Em SNMPv1, um único OID inexistente num GET com vários OIDs derruba o
//    PDU INTEIRO (`NoSuchName`, semântica da RFC 1157) — enquanto v2c
//    devolve `NoSuchObject` só naquele varbind. Por isso os escalares são
//    buscados UM POR REQUISIÇÃO: assim "este modelo não suporta este OID"
//    nunca contamina os outros campos, em nenhuma versão do protocolo.
// 4. Os 3 sentinelas da RFC 3805 aparecem de verdade: as duas Brother
//    reportam `-3` (partial) no nível do toner e `-2` (unknown) na
//    capacidade máxima. Tratados explicitamente (ver `SnmpMeasurement`).
// 5. A HP reporta `prtMarkerSuppliesLevel = 143066` com
//    `prtMarkerSuppliesMaxCapacity = 100` em 3 dos 6 suprimentos — nível
//    MAIOR que a capacidade, um valor incoerente do firmware. Calcular
//    percentual com isso daria 143066%; `levelPercent` fica `null` nesse
//    caso (ver `computeLevelPercent`).
// ============================================================================

// Impressora não muda nível de toner na velocidade que banda de rede muda —
// 15 minutos é bastante granularidade e mantém o tráfego SNMP baixo.
const POLL_INTERVAL_MS = 15 * 60 * 1000;

// Timeout/retries por requisição SNMP. Curtos de propósito: uma impressora
// desligada não pode segurar o ciclo das outras.
const SNMP_TIMEOUT_MS = 3000;
const SNMP_RETRIES = 1;

// Teto de linhas por coluna do walk — evita loop infinito se um firmware
// devolver OIDs fora de ordem. A impressora com mais suprimentos da rede
// real tem 10 linhas (DCP-L3560CDW).
const WALK_MAX_ROWS = 64;

// Retenção do histórico de leituras SNMP (subtarefa 12) — decisão do
// usuário: 90 dias é uma janela generosa sem custo real de armazenamento,
// dado o volume baixo (poucas impressoras, uma leitura a cada 15 min).
// Diferente de bandwidth-history.service.ts, não há rollup/agregação aqui —
// é descarte direto por idade, então (ao contrário do corte de banda) não
// precisa ser arredondado para uma fronteira de hora: não existe uma
// "janela" sendo resumida cujo corte no meio perderia dado, só linhas
// individuais sendo apagadas por estarem velhas demais.
const SNMP_HISTORY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
// Job de limpeza próprio, independente do poller de 15 min — mesmo espírito
// de rollupTimer em bandwidth-history.service.ts (intervalo bem diferente,
// propósito diferente, então timer separado).
const SNMP_HISTORY_CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

// --- OIDs (confirmados empiricamente contra as 3 impressoras, ver acima) ---
const OID = {
  sysDescr: '1.3.6.1.2.1.1.1.0',
  // hrDeviceDescr/hrDeviceStatus/hrPrinterDetectedErrorState têm índice de
  // dispositivo; `.1` é a própria impressora nas 3 (confirmado: a HP tem 7
  // dispositivos na hrDeviceTable e o índice 1 é "HP Laser MFP 131 133
  // 135-138", os outros são CPU/RAM/scanner).
  hrDeviceDescr1: '1.3.6.1.2.1.25.3.2.1.3.1',
  hrDeviceStatus1: '1.3.6.1.2.1.25.3.2.1.5.1',
  hrPrinterDetectedErrorState1: '1.3.6.1.2.1.25.3.5.1.2.1',
  // prtMarkerLifeCount tem índice composto <hrDeviceIndex>.<markerIndex>;
  // `.1.1` respondeu nas 3 (é a única linha da tabela em todas elas).
  prtMarkerLifeCount11: '1.3.6.1.2.1.43.10.2.1.4.1.1',
  // Colunas da prtMarkerSuppliesTable, varridas por getNext (índice
  // composto <hrDeviceIndex>.<supplyIndex>, descoberto pelo walk).
  prtMarkerSuppliesType: '1.3.6.1.2.1.43.11.1.1.5',
  prtMarkerSuppliesDescription: '1.3.6.1.2.1.43.11.1.1.6',
  prtMarkerSuppliesSupplyUnit: '1.3.6.1.2.1.43.11.1.1.7',
  prtMarkerSuppliesMaxCapacity: '1.3.6.1.2.1.43.11.1.1.8',
  prtMarkerSuppliesLevel: '1.3.6.1.2.1.43.11.1.1.9',
  // Subtarefa 19: campo padrão RFC 3805 (mesmo índice composto de
  // prtMarkerLifeCount11, coluna .5 em vez de .4), nunca lido pelo poller
  // até aqui. Confirmado por sonda real contra as 5 impressoras da rede
  // (HP `.89`=24, Brother `.222`=226) — nenhuma MIB privada envolvida.
  prtMarkerPowerOnCount11: '1.3.6.1.2.1.43.10.2.1.5.1.1',
} as const;

// --- Shape do resultado ---

// Todo valor numérico do Printer-MIB pode vir como um dos 3 sentinelas da
// RFC 3805 §2.4 em vez de um número de verdade. Em vez de deixar isso virar
// `-3` cru (ou pior, NaN/Infinity/percentual sem sentido num cálculo),
// modelamos o campo como união discriminada: quem consome é OBRIGADO a
// olhar `status` antes de usar `value`.
//
//   ok          → `value` é um número real e utilizável
//   other       → other(-1): condição indeterminada/não-padrão
//   unknown     → unknown(-2): o valor não pôde ser determinado
//   partial     → partial(-3): ainda há suprimento, quantidade indeterminada
//   unsupported → o OID não existe neste modelo (noSuchObject /
//                 noSuchInstance em v2c, NoSuchName em v1) — não é erro
//   error       → a leitura desse campo específico falhou (timeout do
//                 varbind, tipo inesperado); os demais campos seguem válidos
export type SnmpMeasurement =
  | { status: 'ok'; value: number }
  | { status: 'other' }
  | { status: 'unknown' }
  | { status: 'partial' }
  | { status: 'unsupported' }
  | { status: 'error' };

export interface PrinterSupply {
  // Índice composto da linha na prtMarkerSuppliesTable (ex.: '1.1').
  index: string;
  // Texto CRU de prtMarkerSuppliesDescription, exatamente como a impressora
  // devolveu (ex.: "Black Toner S/N:CRUM-210729A5BB3" nas 2 HPs reais) —
  // nunca modificado, para não perder informação que a impressora reportou.
  // Use `supplyDisplayName`/`serialNumber` para a versão sem o número de
  // série embutido.
  description: string | null;
  // Número de série do cartucho, extraído de `description` quando a
  // impressora o embute (achado real, subtarefa 19: as 2 HPs seguem o
  // padrão "<nome> S/N:<serial>"; as 3 Brother da rede real não têm esse
  // sufixo, então fica `null` para elas). Ver `parseSupplyDescription`.
  serialNumber: string | null;
  // prtMarkerSuppliesTypeTC (RFC 3805): 3=toner, 4=wasteToner, 9=opc/drum,
  // 15=fuser, 1=other... Mantemos o código cru + um rótulo dos valores que
  // as impressoras reais usam, sem tentar mapear a enumeração inteira.
  type: number | null;
  typeLabel: string | null;
  // prtMarkerSuppliesSupplyUnitTC: 19=percent, 13=tenthsOfGrams,
  // 7=impressions... Importante para interpretar `level`.
  unit: number | null;
  unitLabel: string | null;
  maxCapacity: SnmpMeasurement;
  level: SnmpMeasurement;
  // Percentual só quando dá pra calcular de forma confiável (ver
  // computeLevelPercent) — `null` para qualquer sentinela, unidade
  // incompatível ou valor incoerente do firmware.
  levelPercent: number | null;
}

export interface PrinterSnmpReading {
  printerId: string;
  printerName: string;
  ipAddress: string;
  collectedAt: string;
  sysDescr: string | null;
  deviceDescr: string | null;
  deviceStatus: SnmpMeasurement;
  deviceStatusLabel: string | null;
  // Bitmap hrPrinterDetectedErrorState (RFC 2790) já decodificado em nomes.
  // `null` quando o OID não é suportado/falhou; lista vazia = sem erro ativo.
  detectedErrorStates: string[] | null;
  pageCount: SnmpMeasurement;
  // prtMarkerPowerOnCount (subtarefa 19) — mesmo tratamento de SnmpMeasurement
  // que pageCount: sentinela/OID não suportado/erro pontual nunca viram um
  // número inventado.
  powerOnCount: SnmpMeasurement;
  supplies: PrinterSupply[];
  // true quando ao menos um campo veio como 'unsupported'/'error' — a
  // leitura é utilizável, mas incompleta.
  partial: boolean;
}

// --- Buffer em memória (não persiste entre restarts, igual bandwidth-history) ---
const lastReadings = new Map<string, PrinterSnmpReading>();
let pollTimer: ReturnType<typeof setInterval> | null = null;
let snmpHistoryCleanupTimer: ReturnType<typeof setInterval> | null = null;
let collecting = false;

// Última leitura BEM-SUCEDIDA da impressora, ou `undefined` se o poller
// nunca conseguiu falar com ela (processo recém-iniciado, impressora
// offline, SNMP desabilitado). Pronta para a subtarefa 6
// (`GET /printers/:id/consumables`).
export function getLastReading(printerId: string): PrinterSnmpReading | undefined {
  return lastReadings.get(printerId);
}

// --- Helpers de decodificação ---

const SUPPLY_TYPE_LABELS: Record<number, string> = {
  1: 'other',
  2: 'unknown',
  3: 'toner',
  4: 'wasteToner',
  5: 'ink',
  9: 'opc', // drum/photoconductor
  15: 'fuser',
  16: 'coronaWire',
  17: 'fuserOil',
  20: 'transferUnit',
};

const SUPPLY_UNIT_LABELS: Record<number, string> = {
  3: 'tenThousandthsOfInches',
  4: 'micrometers',
  7: 'impressions',
  8: 'sheets',
  11: 'hours',
  12: 'thousandthsOfOunces',
  13: 'tenthsOfGrams',
  14: 'hundredthsOfFluidOunces',
  15: 'tenthsOfMilliliters',
  16: 'feet',
  17: 'meters',
  18: 'items',
  19: 'percent',
};

const DEVICE_STATUS_LABELS: Record<number, string> = {
  1: 'unknown',
  2: 'running',
  3: 'warning',
  4: 'testing',
  5: 'down',
};

// hrPrinterDetectedErrorState (RFC 2790): bitmap big-endian, bit 0 = MSB do
// primeiro octeto.
const PRINTER_ERROR_BITS = [
  'lowPaper',
  'noPaper',
  'lowToner',
  'noToner',
  'doorOpen',
  'jammed',
  'offline',
  'serviceRequested',
  'inputTrayMissing',
  'outputTrayMissing',
  'markerSupplyMissing',
  'outputNearFull',
  'outputFull',
  'inputTrayEmpty',
  'overduePreventMaint',
];

function decodeErrorStateBitmap(buffer: Buffer): string[] {
  const active: string[] = [];
  for (let bit = 0; bit < PRINTER_ERROR_BITS.length; bit++) {
    const byte = buffer[Math.floor(bit / 8)];
    if (byte === undefined) break;
    if ((byte & (0x80 >> bit % 8)) !== 0) active.push(PRINTER_ERROR_BITS[bit]);
  }
  return active;
}

// Traduz o valor numérico cru do MIB para SnmpMeasurement, isolando os 3
// sentinelas da RFC 3805. Qualquer outro negativo (não previsto pela RFC)
// também não vira número utilizável — cai em 'other', que é justamente o
// "condição indeterminada/não-padrão" da RFC.
export function toMeasurement(value: number): SnmpMeasurement {
  if (!Number.isFinite(value)) return { status: 'error' };
  if (value === -1) return { status: 'other' };
  if (value === -2) return { status: 'unknown' };
  if (value === -3) return { status: 'partial' };
  if (value < 0) return { status: 'other' };
  return { status: 'ok', value };
}

// Percentual do suprimento — só quando o dado permite. Regras (todas vindas
// do comportamento real das 3 impressoras):
//  - qualquer sentinela em level/maxCapacity → null (não inventa número);
//  - unidade 19 (percent): o próprio `level` já é o percentual, desde que
//    esteja em 0..100;
//  - caso geral: level/maxCapacity, com maxCapacity > 0;
//  - level > maxCapacity (bug real do firmware da HP: 143066 de 100) →
//    null, nunca 143066%.
export function computeLevelPercent(
  level: SnmpMeasurement,
  maxCapacity: SnmpMeasurement,
  unit: number | null,
): number | null {
  if (level.status !== 'ok') return null;

  if (unit === 19) {
    return level.value >= 0 && level.value <= 100 ? level.value : null;
  }

  if (maxCapacity.status !== 'ok' || maxCapacity.value <= 0) return null;
  if (level.value > maxCapacity.value) return null;

  return Math.round((level.value / maxCapacity.value) * 100);
}

// Extrai o número de série embutido em prtMarkerSuppliesDescription, quando
// presente (achado real, subtarefa 19: as 2 HPs da rede usam o padrão
// "<nome> S/N:<serial>", ex. "Black Toner S/N:CRUM-210729A5BB3"; as 3
// Brother reais não têm esse sufixo). Âncora no fim da string (`$`) porque é
// assim que o padrão observado sempre aparece — evita casar um "S/N:" que
// por acaso apareça no meio de um nome de suprimento diferente.
//
// Endurecimento (achado 3 da revisão crítica, não confirmado contra
// hardware real): o valor capturado exclui explicitamente caracteres de
// controle (`\x00-\x1f`, inclusive NUL) além de espaço em branco comum —
// `\S` sozinho não filtra NUL, então um firmware que preenchesse a
// description com padding NUL depois do serial (nunca observado nas 5
// impressoras reais, mas nenhuma garantia contra isso) faria o NUL entrar
// no valor de `serialNumber`. A cauda `[\s\x00-\x1f]*$` continua aceitando
// esse padding depois do serial, só não deixando ele fazer parte do valor.
const SUPPLY_SERIAL_PATTERN = /\bS\/N:\s*([^\s\x00-\x1f]+)[\s\x00-\x1f]*$/i;

export function parseSupplyDescription(description: string | null): {
  name: string | null;
  serialNumber: string | null;
} {
  if (description === null) return { name: null, serialNumber: null };

  const match = SUPPLY_SERIAL_PATTERN.exec(description);
  if (!match) {
    // Achado 2 da revisão crítica: o ramo sem "S/N:" não aparava espaço
    // nem tratava string vazia/só-espaço como ausente — duas descriptions
    // da MESMA leitura podiam receber tratamento de espaço diferente
    // (uma com sufixo "S/N:" já era aparada, a outra não), e uma
    // description vazia virava um rótulo vazio na UI em vez de cair no
    // fallback (`typeLabel`/"Suprimento <index>") como já acontece quando
    // description é `null`.
    const trimmed = description.trim();
    return { name: trimmed.length > 0 ? trimmed : null, serialNumber: null };
  }

  const name = description.slice(0, match.index).trim();
  return { name: name.length > 0 ? name : null, serialNumber: match[1] };
}

// Nome de exibição de um suprimento — mesmo fallback que /consumables e o
// histórico SNMP (suppliesForHistory) já usavam antes da subtarefa 19
// (description ?? typeLabel ?? "Suprimento <index>"), só que agora com o
// número de série (se houver) removido do nome via parseSupplyDescription,
// em vez de deixá-lo embutido na string. Centralizado aqui (em vez de
// duplicado em printers.routes.ts) para que a resposta atual e o histórico
// nunca divirjam em como nomeiam um suprimento — mesmo motivo de
// pageCountValue ser compartilhado entre os dois.
export function supplyDisplayName(supply: Pick<PrinterSupply, 'description' | 'typeLabel' | 'index'>): string {
  const { name } = parseSupplyDescription(supply.description);
  return name ?? supply.typeLabel ?? `Suprimento ${supply.index}`;
}

// --- Camada SNMP ---

function isNoSuchOidVarbind(varbind: Varbind): boolean {
  // v2c/v3 sinalizam por tipo no próprio varbind (128 = noSuchObject,
  // 129 = noSuchInstance, 130 = endOfMibView).
  return varbind.type === 128 || varbind.type === 129 || varbind.type === 130;
}

// Em v1 o "OID não existe" chega como erro do PDU inteiro (NoSuchName), não
// como varbind. Como cada escalar é buscado numa requisição própria (achado
// 3 do cabeçalho), esse erro é atribuível com segurança ao único OID pedido.
function isNoSuchNameError(error: Error): boolean {
  return /NoSuchName/i.test(error.message) || /NoSuchName/i.test(error.name);
}

function buildSession(record: PrinterRecord, host: string): SnmpSession {
  const secret = JSON.parse(record.snmpSecret) as SnmpSecretInput;
  const options = { timeout: SNMP_TIMEOUT_MS, retries: SNMP_RETRIES, port: 161 };

  if (record.snmpVersion === 'v3') {
    const v3 = (secret as { v3Auth: SnmpV3Auth }).v3Auth;
    const hasAuth = Boolean(v3.authProtocol && v3.authPassword);
    const hasPriv = hasAuth && Boolean(v3.privProtocol && v3.privPassword);
    return snmp.createV3Session(
      host,
      {
        name: v3.username,
        level: hasPriv ? 3 : hasAuth ? 2 : 1, // authPriv / authNoPriv / noAuthNoPriv
        authProtocol: v3.authProtocol === 'SHA' ? 'sha' : v3.authProtocol === 'MD5' ? 'md5' : undefined,
        authKey: v3.authPassword,
        privProtocol: v3.privProtocol === 'AES' ? 'aes' : v3.privProtocol === 'DES' ? 'des' : undefined,
        privKey: v3.privPassword,
      },
      { ...options, version: snmp.Version3 },
    );
  }

  const community = (secret as { community: string }).community;
  return snmp.createSession(host, community, {
    ...options,
    version: record.snmpVersion === 'v1' ? snmp.Version1 : snmp.Version2c,
  });
}

type ScalarResult =
  | { kind: 'value'; varbind: Varbind }
  | { kind: 'unsupported' }
  // 'fatal' = a sessão/rede falhou (timeout, host inalcançável): não adianta
  // continuar pedindo os outros OIDs desta impressora neste ciclo.
  | { kind: 'fatal'; error: Error };

// UMA requisição por OID (achado 3): em v1, misturar um OID não suportado
// com os suportados derrubaria o PDU inteiro.
function getScalar(session: SnmpSession, oid: string): Promise<ScalarResult> {
  return new Promise((resolve) => {
    session.get([oid], (error, varbinds) => {
      if (error) {
        resolve(isNoSuchNameError(error) ? { kind: 'unsupported' } : { kind: 'fatal', error });
        return;
      }
      const varbind = varbinds[0];
      if (!varbind || isNoSuchOidVarbind(varbind) || snmp.isVarbindError(varbind)) {
        resolve({ kind: 'unsupported' });
        return;
      }
      resolve({ kind: 'value', varbind });
    });
  });
}

// Walk manual por getNext (achado 2: o walk/subtree da lib usa getBulk em
// v2c e falha em 2 das 3 impressoras reais). Devolve as linhas da coluna
// indexadas pelo sufixo do OID.
async function walkColumn(session: SnmpSession, baseOid: string): Promise<Map<string, Varbind> | null> {
  const rows = new Map<string, Varbind>();
  let cursor = baseOid;

  for (let i = 0; i < WALK_MAX_ROWS; i++) {
    const step = await new Promise<ScalarResult>((resolve) => {
      session.getNext([cursor], (error, varbinds) => {
        if (error) {
          resolve(isNoSuchNameError(error) ? { kind: 'unsupported' } : { kind: 'fatal', error });
          return;
        }
        const varbind = varbinds[0];
        if (!varbind) {
          resolve({ kind: 'unsupported' });
          return;
        }
        resolve({ kind: 'value', varbind });
      });
    });

    // Fim da MIB ou coluna inexistente neste modelo: devolve o que já tem
    // (possivelmente vazio) em vez de tratar como falha.
    if (step.kind === 'unsupported') break;
    // Falha de rede: sinaliza pra cima, para não montar uma leitura pela
    // metade achando que a impressora simplesmente não tem suprimentos.
    if (step.kind === 'fatal') return null;

    const { varbind } = step;
    if (isNoSuchOidVarbind(varbind) || !varbind.oid.startsWith(`${baseOid}.`)) break;

    rows.set(varbind.oid.slice(baseOid.length + 1), varbind);
    cursor = varbind.oid;
  }

  return rows;
}

function asNumber(varbind: Varbind | undefined): number | null {
  if (!varbind) return null;
  if (typeof varbind.value === 'number') return varbind.value;
  if (typeof varbind.value === 'string') {
    const parsed = Number(varbind.value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(varbind: Varbind | undefined): string | null {
  if (!varbind) return null;
  if (Buffer.isBuffer(varbind.value)) return varbind.value.toString('utf8').trim();
  if (typeof varbind.value === 'string') return varbind.value;
  if (typeof varbind.value === 'number') return String(varbind.value);
  return null;
}

function measurementFromScalar(result: ScalarResult): SnmpMeasurement {
  if (result.kind === 'unsupported') return { status: 'unsupported' };
  if (result.kind === 'fatal') return { status: 'error' };
  const value = asNumber(result.varbind);
  return value === null ? { status: 'error' } : toMeasurement(value);
}

// Erro de rede/sessão: quem chama loga e pula a impressora.
class PrinterUnreachableError extends Error {}

// SANITIZAÇÃO DE LOG (achado do crítico, subtarefa 5): a lib `net-snmp`
// pode construir ela mesma um erro cujo `.message` contém a community
// string em texto puro — ex.: `ResponseInvalidError` de mismatch de
// community entre requisição e resposta (mismatch legítimo de
// concorrência/rede, não só um cenário de laboratório) embute
// `"Community '<segredo>' in request does not match community '<outro>' in
// response"` literalmente no texto do erro (confirmado lendo
// node_modules/net-snmp/index.js). Esse erro chega ao poller pelo mesmo
// callback de `session.get()`/`getNext()` usado em todo o resto do módulo,
// então não dá pra confiar que TODO erro vindo da lib já vem sem segredo —
// o código do poller precisa remover qualquer valor secreto do texto antes
// de logar, não só confiar que ele nunca aparece.
function extractSecretStrings(record: PrinterRecord): string[] {
  try {
    const secret = JSON.parse(record.snmpSecret) as SnmpSecretInput;
    const values: string[] = [];
    const collect = (v: unknown): void => {
      if (typeof v === 'string' && v.length > 0) values.push(v);
      else if (v && typeof v === 'object') Object.values(v).forEach(collect);
    };
    collect(secret);
    return values;
  } catch {
    // Segredo malformado no banco não é motivo pra falhar o log; só não há
    // nada pra redigir.
    return [];
  }
}

function sanitizeErrorMessage(message: string, record: PrinterRecord): string {
  let sanitized = message;
  for (const secretValue of extractSecretStrings(record)) {
    sanitized = sanitized.split(secretValue).join('[REDACTED]');
  }
  return sanitized;
}

async function readPrinter(record: PrinterRecord, ipAddress: string): Promise<PrinterSnmpReading> {
  const session = buildSession(record, ipAddress);
  // A sessão emite 'error' de forma assíncrona (ex.: socket UDP recusado);
  // sem um listener, o EventEmitter derrubaria o processo inteiro.
  session.on('error', () => {
    /* já tratado pelo callback de cada requisição */
  });

  try {
    let partial = false;
    const note = (result: ScalarResult) => {
      if (result.kind !== 'value') partial = true;
      return result;
    };
    const failFast = (result: ScalarResult): ScalarResult => {
      if (result.kind === 'fatal') throw new PrinterUnreachableError(result.error.message);
      return result;
    };

    // sysDescr é o "ping SNMP": se ele falhar por rede, não adianta seguir.
    const sysDescr = failFast(await getScalar(session, OID.sysDescr));
    const deviceDescr = note(await getScalar(session, OID.hrDeviceDescr1));
    const deviceStatus = note(await getScalar(session, OID.hrDeviceStatus1));
    const errorState = note(await getScalar(session, OID.hrPrinterDetectedErrorState1));
    const pageCount = note(await getScalar(session, OID.prtMarkerLifeCount11));
    const powerOnCount = note(await getScalar(session, OID.prtMarkerPowerOnCount11));

    const [types, descriptions, units, maxCapacities, levels] = await Promise.all([
      walkColumn(session, OID.prtMarkerSuppliesType),
      walkColumn(session, OID.prtMarkerSuppliesDescription),
      walkColumn(session, OID.prtMarkerSuppliesSupplyUnit),
      walkColumn(session, OID.prtMarkerSuppliesMaxCapacity),
      walkColumn(session, OID.prtMarkerSuppliesLevel),
    ]);

    if (!types || !descriptions || !units || !maxCapacities || !levels) {
      throw new PrinterUnreachableError('falha de rede ao varrer a prtMarkerSuppliesTable');
    }

    // A união dos índices de todas as colunas (não só de uma) — se um
    // firmware expuser uma linha só em algumas colunas, ela ainda aparece,
    // com os campos ausentes marcados como não suportados.
    const indices = [...new Set([...descriptions.keys(), ...levels.keys(), ...types.keys()])].sort((a, b) =>
      a.localeCompare(b, undefined, { numeric: true }),
    );

    const supplies: PrinterSupply[] = indices.map((index) => {
      const rawMax = asNumber(maxCapacities.get(index));
      const rawLevel = asNumber(levels.get(index));
      const maxCapacity: SnmpMeasurement = rawMax === null ? { status: 'unsupported' } : toMeasurement(rawMax);
      const level: SnmpMeasurement = rawLevel === null ? { status: 'unsupported' } : toMeasurement(rawLevel);
      const type = asNumber(types.get(index));
      const unit = asNumber(units.get(index));

      if (maxCapacity.status === 'unsupported' || level.status === 'unsupported') partial = true;

      const description = asString(descriptions.get(index));

      return {
        index,
        description,
        serialNumber: parseSupplyDescription(description).serialNumber,
        type,
        typeLabel: type === null ? null : (SUPPLY_TYPE_LABELS[type] ?? null),
        unit,
        unitLabel: unit === null ? null : (SUPPLY_UNIT_LABELS[unit] ?? null),
        maxCapacity,
        level,
        levelPercent: computeLevelPercent(level, maxCapacity, unit),
      };
    });

    const statusMeasurement = measurementFromScalar(deviceStatus);
    const errorVarbind = errorState.kind === 'value' ? errorState.varbind : null;

    return {
      printerId: record.id,
      printerName: record.name,
      ipAddress,
      collectedAt: new Date().toISOString(),
      sysDescr: sysDescr.kind === 'value' ? asString(sysDescr.varbind) : null,
      deviceDescr: deviceDescr.kind === 'value' ? asString(deviceDescr.varbind) : null,
      deviceStatus: statusMeasurement,
      deviceStatusLabel:
        statusMeasurement.status === 'ok' ? (DEVICE_STATUS_LABELS[statusMeasurement.value] ?? null) : null,
      detectedErrorStates:
        errorVarbind && Buffer.isBuffer(errorVarbind.value) ? decodeErrorStateBitmap(errorVarbind.value) : null,
      pageCount: measurementFromScalar(pageCount),
      powerOnCount: measurementFromScalar(powerOnCount),
      supplies,
      partial,
    };
  } finally {
    try {
      session.close();
    } catch {
      // fechar uma sessão já morta não é motivo pra falhar a coleta
    }
  }
}

// --- Ciclo de coleta ---

// `pageCount` de uma leitura como número utilizável — só quando o
// SnmpMeasurement tem status 'ok'; sentinela/erro/OID não suportado viram
// `null` (nunca NaN/undefined). Mesma regra usada pela rota
// (pageCountValue em printers.routes.ts) — reexportada aqui para o
// histórico usar exatamente a mesma definição em vez de duplicá-la.
export function pageCountValue(pageCount: SnmpMeasurement): number | null {
  return pageCount.status === 'ok' ? pageCount.value : null;
}

// Formata os suprimentos de uma leitura no mesmo shape que
// `toConsumablesResponse` (printers.routes.ts) já usa para o snapshot atual
// — nome (com o mesmo fallback `Suprimento <index>`) + levelPercent. O
// histórico reaproveita esta função para que a série temporal e o snapshot
// atual nunca divirjam silenciosamente em como nomeiam um suprimento.
export function suppliesForHistory(supplies: PrinterSupply[]): Array<{ name: string; levelPercent: number | null }> {
  return supplies.map((supply) => ({
    name: supplyDisplayName(supply),
    levelPercent: supply.levelPercent,
  }));
}

// Grava a leitura recém-coletada em `printer_snmp_history` — chamada depois
// que `lastReadings` JÁ foi atualizado (ver collectAllReadings): uma falha
// aqui não pode desfazer isso nem impedir o próximo ciclo do poller, por
// isso tem seu próprio try/catch, separado do try/catch da coleta em si.
// Mesmo padrão de persistSnapshotToDb em bandwidth-history.service.ts.
function persistReadingToHistory(reading: PrinterSnmpReading): void {
  try {
    printersRepository.recordSnmpHistoryEntry(reading.printerId, {
      collectedAt: reading.collectedAt,
      pageCount: pageCountValue(reading.pageCount),
      supplies: suppliesForHistory(reading.supplies),
      partial: reading.partial,
    });
  } catch (err) {
    // Mesma filosofia de resiliência do resto do arquivo: uma falha de
    // ESCRITA NO BANCO não pode derrubar `lastReadings` (já atualizado antes
    // desta chamada) nem o poller de 15 minutos — só esta leitura deixa de
    // ser persistida em disco (getLastReading continua funcionando normal).
    console.error(
      `[printer-snmp] falha ao persistir histórico da impressora ${reading.printerId} em disco ` +
        '(última leitura em memória segue intacta):',
      err,
    );
  }
}

// Resolve o IP: `ipOverride` do cadastro tem precedência; senão usa
// exatamente o mesmo merge de status da subtarefa 2
// (printer-network-status.service.ts), sem duplicar a lógica.
export async function collectAllReadings(): Promise<void> {
  if (collecting) return; // um ciclo lento nunca deve se sobrepor ao próximo
  collecting = true;

  try {
    const printers = printersRepository.listAll();
    if (printers.length === 0) return;

    const resolveNetwork = await buildNetworkStatusResolver({
      warn: (obj, msg) => console.warn('[printer-snmp]', msg, obj),
    });

    for (const printer of printers) {
      // IMPORTANTE (segurança): nenhum log deste laço inclui `printer`
      // inteiro nem `printer.snmpSecret` — só id/nome/IP. O segredo SNMP
      // (community string ou credenciais v3) nunca sai em log, mesmo em
      // caso de erro. Mesma disciplina do CRUD (subtarefa 1), onde o
      // segredo nunca é devolvido em GET.
      const ipAddress = printer.ipOverride ?? resolveNetwork(printer.mac).ipAddress;

      if (!ipAddress) {
        console.warn(
          `[printer-snmp] impressora ${printer.id} (${printer.name}) sem IP conhecido ` +
            '(sem ipOverride e não encontrada no controller) — pulando neste ciclo',
        );
        continue;
      }

      try {
        const reading = await readPrinter(printer, ipAddress);
        lastReadings.set(printer.id, reading);
        // Persistência do histórico (subtarefa 12) SÓ depois que o buffer em
        // memória já foi atualizado — getLastReading nunca fica bloqueado
        // nem prejudicado por uma falha de escrita em disco (ver
        // persistReadingToHistory).
        persistReadingToHistory(reading);
      } catch (err) {
        // Impressora desligada, IP trocado, firewall bloqueando UDP 161,
        // SNMP desabilitado no equipamento: loga e segue para a PRÓXIMA
        // impressora. Uma falhando nunca impede a coleta das outras, e
        // nunca derruba o poller nem o processo (mesmo espírito de
        // bandwidth-history.service.ts). A última leitura boa desta
        // impressora continua no buffer, com seu `collectedAt` antigo.
        const rawMessage = err instanceof Error ? err.message : String(err);
        console.error(
          `[printer-snmp] falha ao coletar SNMP da impressora ${printer.id} (${printer.name}) em ${ipAddress}:`,
          sanitizeErrorMessage(rawMessage, printer),
        );
      }
    }
  } catch (err) {
    // Falha antes do laço (ex.: leitura do cadastro, resolução de rede) —
    // pula este ciclo inteiro e tenta de novo no próximo.
    console.error('[printer-snmp] falha ao executar o ciclo de coleta SNMP:', err);
  } finally {
    collecting = false;
  }
}

// Apaga entradas de `printer_snmp_history` mais antigas que a janela de
// retenção (90 dias). Recebe `now` como parâmetro (em vez de sempre usar
// `new Date()`) para ser testável sem depender do timer real — mesmo
// espírito de runRollupAndCleanup em bandwidth-history.service.ts. Chamável
// diretamente pelos testes, sem depender de `setInterval`.
export function runSnmpHistoryCleanup(now: Date = new Date()): void {
  try {
    const cutoffIso = new Date(now.getTime() - SNMP_HISTORY_RETENTION_MS).toISOString();
    printersRepository.deleteSnmpHistoryOlderThan(cutoffIso);
  } catch (err) {
    // Mesma filosofia de resiliência do resto do arquivo: uma falha aqui
    // (banco indisponível, etc.) não pode derrubar o processo — só tenta de
    // novo na próxima execução do job (1x/dia).
    console.error('[printer-snmp] falha no job de limpeza do histórico SNMP:', err);
  }
}

function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void collectAllReadings();
  }, POLL_INTERVAL_MS);
  // unref() garante que esse timer sozinho não impede o processo Node (ou o
  // runner de testes) de terminar — igual bandwidth-history.service.ts.
  pollTimer.unref?.();
}

function startSnmpHistoryCleanupJob(): void {
  if (snmpHistoryCleanupTimer) return;
  // Roda uma vez já no boot, além de agendar o timer diário — mesmo
  // raciocínio de bandwidth-history.service.ts (startRollupJob): sem isso,
  // um processo que reinicia mais de uma vez por dia nunca poda a tabela
  // naquele dia. Sem chamada de rede aqui (só SQLite local), então não há
  // motivo pra adiar como a coleta SNMP em si (comentário abaixo).
  runSnmpHistoryCleanup();
  snmpHistoryCleanupTimer = setInterval(() => {
    runSnmpHistoryCleanup();
  }, SNMP_HISTORY_CLEANUP_INTERVAL_MS);
  snmpHistoryCleanupTimer.unref?.();
}

// Sem coleta imediata no boot (mesma escolha de bandwidth-history): a
// primeira leitura aparece depois do primeiro intervalo, para não disparar
// tráfego de rede antes do app terminar de subir.
startPolling();
startSnmpHistoryCleanupJob();

export const printerSnmpService = {
  getLastReading,
  collectAllReadings,
  runSnmpHistoryCleanup,
};
