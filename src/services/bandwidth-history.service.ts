import { bandwidthHistoryRepository } from '../db/bandwidth-history.instance.js';
import type { BandwidthSampleRow, HourlyRollupRow } from '../db/bandwidth-history.db.js';
import { unifiClassicService } from './unifi-classic.service.js';

// Histórico de uso de banda (Prioridade 3, parte 2). Diferente do resto de
// "saúde operacional" (que busca dado ao vivo só quando o dashboard pede),
// aqui precisamos de uma SÉRIE TEMPORAL — então em vez de esperar um
// request, este módulo mantém seu próprio poller em memória, coletando uma
// amostra a cada 5 minutos assim que o processo sobe, e guarda as últimas
// 24h (288 amostras) num buffer, no mesmo espírito de
// unifi-events.hub.ts: estado em memória a nível de módulo, singleton,
// buffer com limite. Isso quer dizer que o BUFFER EM MEMÓRIA é perdido a
// cada restart do backend, e que ele começa vazio — a primeira amostra só
// aparece depois do primeiro ciclo de 5 minutos rodando (não há coleta
// "imediata" no boot, pra não autenticar na API clássica antes do resto do
// app terminar de subir).
//
// Persistência de longo prazo (histórico além de 24h, decisão aprovada
// pelo usuário — ver CLAUDE.md): CADA amostra coletada pelo poller acima
// TAMBÉM é gravada em `bandwidth_samples` (SQLite, ver
// src/db/bandwidth-history.db.ts), além de entrar no buffer em memória. Um
// segundo job diário resume amostras com mais de 48h em
// `bandwidth_hourly_rollup` (um delta por hora, não o valor cumulativo cru)
// e depois as apaga, mantendo o rollup horário por até 30 dias. O
// comportamento do buffer em memória e das rotas /bandwidth/history e
// /bandwidth/history/summary (que continuam servidas SÓ do buffer) não
// muda em nada.
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const HISTORY_LIMIT = 288; // 24h de amostras a cada 5 min

// Janelas de retenção do banco de longo prazo — decisão explicitamente
// aprovada pelo usuário nesta sessão (não é um valor arbitrário do
// executor): 48h de grão fino (5 min) é generoso o bastante para investigar
// um pico recente amostra-a-amostra, e 30 dias de rollup horário cobre
// "como estava o uso há 3 semanas" sem guardar 5-em-5-min pra sempre (o que
// cresceria sem limite: um device/cliente a cada 5 min, indefinidamente).
const FINE_RETENTION_MS = 48 * 60 * 60 * 1000;
const ROLLUP_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const ROLLUP_INTERVAL_MS = 24 * 60 * 60 * 1000; // job de rollup/limpeza roda 1x/dia

export interface BandwidthSample {
  mac: string;
  rxBytes: number;
  txBytes: number;
}

export interface BandwidthDeviceSample extends BandwidthSample {
  name: string;
}

export interface BandwidthClientSample extends BandwidthSample {
  hostname: string;
}

export interface BandwidthSnapshot {
  timestamp: string;
  perDevice: BandwidthDeviceSample[];
  perClient: BandwidthClientSample[];
}

// Buffer em memória a nível de módulo — não persiste entre restarts (ver
// comentário acima; a cópia persistente é o banco SQLite). Guarda o valor
// CRU/cumulativo de cada amostra (o mesmo que vem de tx_bytes/rx_bytes do
// controller), não a diferença já calculada — quem quiser "quanto foi
// usado no intervalo" chama computeDelta() abaixo.
let history: BandwidthSnapshot[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;
let rollupTimer: ReturnType<typeof setInterval> | null = null;

// Grava a amostra recém-coletada em `bandwidth_samples` — uma linha por
// device/cliente do snapshot. Chamada depois que o snapshot JÁ entrou no
// buffer em memória (ver collectSnapshot): uma falha aqui não pode desfazer
// isso nem impedir o próximo ciclo do poller, por isso tem seu próprio
// try/catch, separado do try/catch da coleta em si. Se uma linha no meio do
// loop falhar (ex.: banco fechado/disco cheio), as linhas já inseridas
// antes dela permanecem — aceitável para uma tabela de amostras somada por
// poller, não é uma operação que precise ser tudo-ou-nada.
// MAC é normalizado para minúsculas NA ESCRITA porque o filtro `?mac=` do
// endpoint de longo prazo também normaliza para minúsculas
// (bandwidth.routes.ts) e a comparação `mac = ?` do SQLite é sensível a
// caixa: sem normalizar dos dois lados, um MAC que o controller devolvesse
// em maiúsculas ficaria gravado assim e o filtro simplesmente retornaria
// lista vazia — falha silenciosa, sem erro nenhum. Normalizar aqui torna
// garantido o que o comentário da rota até então só assumia.
function normalizeMac(mac: string): string {
  return mac.toLowerCase();
}

function persistSnapshotToDb(snapshot: BandwidthSnapshot): void {
  try {
    for (const device of snapshot.perDevice) {
      bandwidthHistoryRepository.insertSample({
        collectedAt: snapshot.timestamp,
        scope: 'device',
        mac: normalizeMac(device.mac),
        label: device.name,
        rxBytes: device.rxBytes,
        txBytes: device.txBytes,
      });
    }
    for (const client of snapshot.perClient) {
      bandwidthHistoryRepository.insertSample({
        collectedAt: snapshot.timestamp,
        scope: 'client',
        mac: normalizeMac(client.mac),
        label: client.hostname,
        rxBytes: client.rxBytes,
        txBytes: client.txBytes,
      });
    }
  } catch (err) {
    // Mesma filosofia de resiliência do resto do arquivo: uma falha de
    // ESCRITA NO BANCO não pode derrubar o buffer em memória (já atualizado
    // antes desta chamada) nem o poller de 5 minutos — só essa amostra
    // deixa de ser persistida em disco.
    console.error('[bandwidth-history] falha ao persistir amostra em disco (buffer em memória segue intacto):', err);
  }
}

async function collectSnapshot(): Promise<void> {
  try {
    const raw = await unifiClassicService.getRawTrafficCounters();
    const snapshot: BandwidthSnapshot = {
      timestamp: new Date().toISOString(),
      perDevice: raw.perDevice,
      perClient: raw.perClient,
    };

    history.push(snapshot);
    if (history.length > HISTORY_LIMIT) history.shift();

    persistSnapshotToDb(snapshot);
  } catch (err) {
    // Uma falha de coleta (controller fora do ar, credenciais erradas,
    // rede instável) não pode derrubar o processo nem parar o poller — só
    // pula essa amostra e tenta de novo no próximo ciclo de 5 minutos.
    console.error('[bandwidth-history] falha ao coletar amostra de uso de banda:', err);
  }
}

function hourStartOf(iso: string): string {
  const date = new Date(iso);
  date.setUTCMinutes(0, 0, 0);
  return date.toISOString();
}

function hourEndOf(hourStartIso: string): string {
  return new Date(new Date(hourStartIso).getTime() + 60 * 60 * 1000).toISOString();
}

// Contadores do controller são cumulativos desde o boot/conexão — a
// diferença entre duas amostras consecutivas dá o uso no intervalo. Se o
// device/cliente reiniciou ou reconectou entre as duas amostras, o
// contador zera e a diferença dá negativa; nesse caso não há como saber
// quanto foi usado nesse intervalo específico, então tratamos como
// "sem dado" (null) em vez de mostrar um número negativo sem sentido.
function diffCounter(previous: number, current: number): number | null {
  const diff = current - previous;
  return diff >= 0 ? diff : null;
}

// Agrupa amostras finas (já ordenadas por scope, mac, collected_at — ver
// listSamplesOlderThan) em baldes de 1 hora por (hourStart, scope, mac).
// Como a query de origem já vem ordenada com as amostras do mesmo
// scope+mac contíguas e em ordem cronológica, cada balde resultante também
// fica internamente ordenado, sem precisar reordenar aqui.
function groupSamplesByHour(
  samples: BandwidthSampleRow[],
): Array<{ hourStart: string; scope: BandwidthSampleRow['scope']; mac: string; samples: BandwidthSampleRow[] }> {
  const buckets = new Map<
    string,
    { hourStart: string; scope: BandwidthSampleRow['scope']; mac: string; samples: BandwidthSampleRow[] }
  >();

  for (const sample of samples) {
    const hourStart = hourStartOf(sample.collectedAt);
    const key = `${hourStart}|${sample.scope}|${sample.mac}`;
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { hourStart, scope: sample.scope, mac: sample.mac, samples: [] };
      buckets.set(key, bucket);
    }
    bucket.samples.push(sample);
  }

  return [...buckets.values()];
}

// Executa o rollup horário das amostras com mais de 48h + a limpeza das
// duas tabelas (fina além de 48h, rollup além de 30 dias). Recebe `now`
// como parâmetro (em vez de sempre usar `new Date()`) para ser testável sem
// depender do timer real — mesmo espírito de collectSnapshot ser chamável
// diretamente nos testes.
//
// O corte tem DUAS condições, não uma só — a hora precisa ser (a) mais
// antiga que a retenção de 48h E (b) COMPLETA. O corte cru de 48h
// (`now - 48h`) quase nunca cai exatamente numa fronteira de hora: com
// `now` às 12:30, ele cai às 12:30 de dois dias atrás, no MEIO daquela
// hora. Resumir com só a condição (a) pegaria as amostras de 12:00–12:25,
// gravaria o rollup da hora 12:00 com o uso de meia hora, e apagaria essas
// amostras. Na execução do dia seguinte o resto da hora (12:30–12:55) viria
// a ser stale também, cairia no MESMO balde 12:00 — e o `INSERT OR IGNORE`
// (que existe pra idempotência) descartaria silenciosamente esse segundo
// pedaço. Resultado: perda de dado permanente e invisível, exatamente na
// tabela cujo propósito é ser o histórico de longo prazo.
//
// Por isso arredondamos o corte PARA BAIXO até o início da hora
// (`hourStartOf`): só horas inteiramente anteriores a esse limite são
// resumidas/apagadas. Nenhuma amostra nova pode cair nelas (o poller só
// insere com `collectedAt` = agora), então são estáveis por definição. O
// custo é guardar o grão fino por até 48h59min em vez de exatamente 48h —
// a retenção é um mínimo garantido, não um teto.
function runRollupAndCleanup(now: Date = new Date()): void {
  try {
    const fineCutoff = hourStartOf(new Date(now.getTime() - FINE_RETENTION_MS).toISOString());
    const rollupCutoff = new Date(now.getTime() - ROLLUP_RETENTION_MS).toISOString();

    const staleSamples = bandwidthHistoryRepository.listSamplesOlderThan(fineCutoff);
    const hourBuckets = groupSamplesByHour(staleSamples);

    for (const bucket of hourBuckets) {
      const first = bucket.samples[0];
      const last = bucket.samples[bucket.samples.length - 1];
      // Duas amostras distintas são o mínimo para existir um INTERVALO
      // medido dentro da hora — ver o comentário de rxBytesDelta abaixo.
      const hasInterval = bucket.samples.length > 1;
      bandwidthHistoryRepository.insertHourlyRollup({
        hourStart: bucket.hourStart,
        scope: bucket.scope,
        mac: bucket.mac,
        // Rótulo (nome do device / hostname do cliente) da amostra mais
        // recente da hora — mesma info que pode mudar entre amostras (ex.:
        // hostname trocado no meio da hora), mas não há um "certo" aqui;
        // usar a mais recente é a escolha mais previsível.
        label: last.label,
        // Delta = última amostra menos primeira amostra DA HORA (não a
        // amostra anterior a essa hora) — é a definição de "quanto foi
        // usado nessa hora específica" que o rollup se propõe a resumir.
        // `diffCounter` já cobre reset de contador (negativo -> null).
        //
        // Hora com UMA única amostra vira `null`, não 0: com um único ponto
        // não há intervalo nenhum medido, e isso normalmente significa que o
        // poller esteve de pé só uma fração daquela hora (boot do processo,
        // controller fora do ar no resto da hora). Gravar 0 afirmaria "este
        // device não trafegou nada nesta hora" — indistinguível de um device
        // genuinamente ocioso e simplesmente falso se ele transferiu 5 GB
        // enquanto ninguém estava medindo. `null` já é o vocabulário do
        // módulo para "sem dado confiável" (mesma decisão do reset de
        // contador acima), e o consumidor já tem que tratá-lo.
        rxBytesDelta: hasInterval ? diffCounter(first.rxBytes, last.rxBytes) : null,
        txBytesDelta: hasInterval ? diffCounter(first.txBytes, last.txBytes) : null,
      });
    }

    // Só apaga DEPOIS de ter gravado o rollup de toda a janela — se o
    // rollup falhasse no meio (exceção lançada acima), a exceção pula
    // direto pro catch abaixo e as amostras finas correspondentes
    // permanecem intactas para a próxima execução do job tentar de novo.
    bandwidthHistoryRepository.deleteSamplesOlderThan(fineCutoff);
    bandwidthHistoryRepository.deleteHourlyRollupsOlderThan(rollupCutoff);
  } catch (err) {
    // Mesma filosofia de resiliência do resto do arquivo: uma falha aqui
    // (banco indisponível, etc.) não pode derrubar o processo — só tenta de
    // novo no próximo ciclo do job (1x/dia).
    console.error('[bandwidth-history] falha no job de rollup/limpeza:', err);
  }
}

function startPolling(): void {
  if (pollTimer) return;
  pollTimer = setInterval(() => {
    void collectSnapshot();
  }, POLL_INTERVAL_MS);
  // unref() garante que esse timer sozinho não impede o processo Node (ou
  // o runner de testes) de terminar — só interessa enquanto o resto do
  // processo já está de pé por outro motivo.
  pollTimer.unref?.();
}

function startRollupJob(): void {
  if (rollupTimer) return;
  // Roda uma vez já no boot, além de agendar o timer diário: sem isso, um
  // processo que reinicia mais de uma vez por dia (deploy, dev, queda de
  // energia) nunca chega a rodar `runRollupAndCleanup` naquele dia, e as
  // tabelas crescem sem poda nenhuma. Diferente de `startPolling()`
  // (comentário acima) — aqui não há chamada de rede nenhuma, só leitura/
  // escrita local no SQLite, então não há motivo pra adiar.
  runRollupAndCleanup();
  rollupTimer = setInterval(() => {
    runRollupAndCleanup();
  }, ROLLUP_INTERVAL_MS);
  rollupTimer.unref?.();
}

// Começa a coletar assim que o módulo é importado (isso é, assim que o
// backend sobe), sem esperar ninguém "assinar" — ao contrário do hub de
// eventos WS, aqui não faz sentido só coletar enquanto alguém está olhando
// o dashboard, já que é uma métrica de série temporal. O job de rollup
// segue o mesmo espírito, mas com timer PRÓPRIO (não reaproveita
// `pollTimer`) — intervalos completamente diferentes (5 min vs. 1 dia) e
// propósitos diferentes (coletar vs. resumir/limpar).
startPolling();
startRollupJob();

function getHistory(): BandwidthSnapshot[] {
  return history;
}

export interface BandwidthDeltaEntry {
  mac: string;
  rxBytes: number | null;
  txBytes: number | null;
}

export interface BandwidthDeviceDelta extends BandwidthDeltaEntry {
  name: string;
}

export interface BandwidthClientDelta extends BandwidthDeltaEntry {
  hostname: string;
}

export interface BandwidthDelta {
  intervalStart: string;
  intervalEnd: string;
  perDevice: BandwidthDeviceDelta[];
  perClient: BandwidthClientDelta[];
}

function diffByMac<T extends { mac: string; rxBytes: number; txBytes: number }, Extra extends Record<string, unknown>>(
  previous: T[],
  current: T[],
  extraFrom: (entry: T) => Extra,
): Array<BandwidthDeltaEntry & Extra> {
  const previousByMac = new Map(previous.map((entry) => [entry.mac, entry]));

  return current.map((entry) => {
    const prevEntry = previousByMac.get(entry.mac);
    const rxBytes = prevEntry ? diffCounter(prevEntry.rxBytes, entry.rxBytes) : null;
    const txBytes = prevEntry ? diffCounter(prevEntry.txBytes, entry.txBytes) : null;
    return { mac: entry.mac, rxBytes, txBytes, ...extraFrom(entry) };
  });
}

// Transforma a lista de snapshots crus (cumulativos) numa lista de "uso no
// intervalo" por device/cliente — uma entrada por PAR de amostras
// consecutivas. Com N snapshots, devolve N-1 deltas (o primeiro snapshot
// não tem um anterior pra comparar).
export function computeDelta(snapshots: BandwidthSnapshot[]): BandwidthDelta[] {
  const deltas: BandwidthDelta[] = [];

  for (let i = 1; i < snapshots.length; i++) {
    const previous = snapshots[i - 1];
    const current = snapshots[i];

    deltas.push({
      intervalStart: previous.timestamp,
      intervalEnd: current.timestamp,
      perDevice: diffByMac(previous.perDevice, current.perDevice, (entry) => ({ name: entry.name })),
      perClient: diffByMac(previous.perClient, current.perClient, (entry) => ({ hostname: entry.hostname })),
    });
  }

  return deltas;
}

// --- GET /bandwidth/history/long-range ---
//
// Combina o trecho recente (bandwidth_samples, até 48h — grão fino de 5
// min) com o trecho mais antigo (bandwidth_hourly_rollup, até 30 dias —
// grão de 1h) numa única lista ordenada por tempo. Formato de saída:
// reaproveita EXATAMENTE `BandwidthDelta`/`BandwidthDeviceDelta`/
// `BandwidthClientDelta` (os mesmos tipos de /bandwidth/history/summary),
// em vez de inventar um formato paralelo — decisão deliberada para que o
// frontend consiga tratar "resumo de curto prazo" e "histórico de longo
// prazo" com o mesmo componente/parsing. Cada entrada da lista é um
// intervalo (`intervalStart`/`intervalEnd`) com o USO (delta), não o valor
// cumulativo cru:
// - Para o trecho de rollup, cada linha do banco já É um delta por hora —
//   `intervalStart`/`intervalEnd` são o início/fim daquela hora.
// - Para o trecho fino, as amostras cruas (cumulativas, do jeito que foram
//   coletadas) são reagrupadas em snapshots por `collectedAt` e passadas
//   pelo MESMO `computeDelta()` acima — reaproveita a lógica existente em
//   vez de duplicá-la, e produz o delta entre cada par de amostras de 5 min
//   consecutivas dentro da janela.

export interface LongRangeOptions {
  mac?: string;
  from?: string;
  to?: string;
}

function rollupRowsToDeltas(rows: HourlyRollupRow[]): BandwidthDelta[] {
  const byHour = new Map<string, { perDevice: BandwidthDeviceDelta[]; perClient: BandwidthClientDelta[] }>();

  for (const row of rows) {
    let bucket = byHour.get(row.hourStart);
    if (!bucket) {
      bucket = { perDevice: [], perClient: [] };
      byHour.set(row.hourStart, bucket);
    }
    if (row.scope === 'device') {
      bucket.perDevice.push({ mac: row.mac, name: row.label, rxBytes: row.rxBytesDelta, txBytes: row.txBytesDelta });
    } else {
      bucket.perClient.push({
        mac: row.mac,
        hostname: row.label,
        rxBytes: row.rxBytesDelta,
        txBytes: row.txBytesDelta,
      });
    }
  }

  return [...byHour.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([hourStart, bucket]) => ({
      intervalStart: hourStart,
      intervalEnd: hourEndOf(hourStart),
      perDevice: bucket.perDevice,
      perClient: bucket.perClient,
    }));
}

function fineRowsToDeltas(rows: BandwidthSampleRow[]): BandwidthDelta[] {
  const byTimestamp = new Map<string, BandwidthSnapshot>();

  for (const row of rows) {
    let snapshot = byTimestamp.get(row.collectedAt);
    if (!snapshot) {
      snapshot = { timestamp: row.collectedAt, perDevice: [], perClient: [] };
      byTimestamp.set(row.collectedAt, snapshot);
    }
    if (row.scope === 'device') {
      snapshot.perDevice.push({ mac: row.mac, name: row.label, rxBytes: row.rxBytes, txBytes: row.txBytes });
    } else {
      snapshot.perClient.push({ mac: row.mac, hostname: row.label, rxBytes: row.rxBytes, txBytes: row.txBytes });
    }
  }

  const snapshots = [...byTimestamp.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return computeDelta(snapshots);
}

// `collected_at`/`hour_start` são gravados SEMPRE como ISO-8601 UTC
// canônico (`new Date().toISOString()`, com milissegundos e sufixo `Z`), e a
// comparação no SQLite é LEXICOGRÁFICA sobre TEXT — não há tipo de data
// nativo. Então qualquer `from`/`to` que chegue em outro formato precisa ser
// convertido para essa mesma forma canônica antes de virar parâmetro da
// query, senão a comparação é feita entre textos de formatos diferentes e
// devolve lixo, silenciosamente:
// - `2026-05-01T08:00:00-03:00` (fuso America/São_Paulo, o do projeto — e
//   explicitamente aceito pelo schema da rota, que usa `offset: true`)
//   nunca casaria com `2026-05-01T11:00:00.000Z`, apesar de ser o MESMO
//   instante.
// - `2026-05-01T11:00:00Z` (ISO válido, sem milissegundos) é
//   lexicograficamente MAIOR que `2026-05-01T11:00:00.000Z` ('Z' > '.'),
//   então como `from` ele excluiria a própria amostra daquele instante.
// Nos dois casos o endpoint respondia `[]` — sem erro, sem aviso.
function toCanonicalUtcIso(value: string, field: 'from' | 'to'): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    // A rota já valida o formato (400 antes de chegar aqui), então isto só
    // acontece com chamada interna errada — falhar alto é melhor que
    // devolver lista vazia como se não houvesse dado.
    throw new TypeError(`[bandwidth-history] "${field}" não é uma data ISO-8601 válida: ${value}`);
  }
  return date.toISOString();
}

// Sem `from` informado, assume os últimos 30 dias — a janela de retenção
// inteira (não faz sentido pedir "mais que isso": o dado simplesmente não
// existe mais, foi limpo pelo job de rollup).
function getLongRange(options: LongRangeOptions = {}): BandwidthDelta[] {
  const now = new Date();
  const to = options.to ? toCanonicalUtcIso(options.to, 'to') : now.toISOString();
  const from = options.from
    ? toCanonicalUtcIso(options.from, 'from')
    : new Date(now.getTime() - ROLLUP_RETENTION_MS).toISOString();

  // Normaliza também na leitura (a rota já normaliza, mas o serviço é
  // chamável direto): o dado é gravado em minúsculas por persistSnapshotToDb
  // e a comparação do SQLite é sensível a caixa — ver normalizeMac.
  const mac = options.mac ? normalizeMac(options.mac) : undefined;
  const rollupRows = bandwidthHistoryRepository.listHourlyRollups({ mac, from, to });
  const fineRows = bandwidthHistoryRepository.listSamples({ mac, from, to });

  const deltas = [...rollupRowsToDeltas(rollupRows), ...fineRowsToDeltas(fineRows)];
  deltas.sort((a, b) => a.intervalStart.localeCompare(b.intervalStart));
  return deltas;
}

export const bandwidthHistoryService = {
  getHistory,
  computeDelta,
  getLongRange,
  // Expostas para os testes chamarem diretamente, sem depender dos timers
  // reais (5 min / 1 dia) — mesmo espírito de computeDelta já ser puro e
  // testável isoladamente.
  collectSnapshot,
  runRollupAndCleanup,
};
