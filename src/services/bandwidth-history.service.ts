import { unifiClassicService } from './unifi-classic.service.js';

// Histórico de uso de banda (Prioridade 3, parte 2). Diferente do resto de
// "saúde operacional" (que busca dado ao vivo só quando o dashboard pede),
// aqui precisamos de uma SÉRIE TEMPORAL — então em vez de esperar um
// request, este módulo mantém seu próprio poller em memória, coletando uma
// amostra a cada 5 minutos assim que o processo sobe, e guarda as últimas
// 24h (288 amostras) num buffer, no mesmo espírito de
// unifi-events.hub.ts: estado em memória a nível de módulo, singleton,
// buffer com limite, SEM banco de dados e SEM arquivo em disco. Isso quer
// dizer que o histórico é perdido a cada restart do backend, e que o
// buffer começa vazio — a primeira amostra só aparece depois do primeiro
// ciclo de 5 minutos rodando (não há coleta "imediata" no boot, pra não
// autenticar na API clássica antes do resto do app terminar de subir).
const POLL_INTERVAL_MS = 5 * 60 * 1000;
const HISTORY_LIMIT = 288; // 24h de amostras a cada 5 min

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
// comentário acima). Guarda o valor CRU/cumulativo de cada amostra (o mesmo
// que vem de tx_bytes/rx_bytes do controller), não a diferença já
// calculada — quem quiser "quanto foi usado no intervalo" chama
// computeDelta() abaixo.
let history: BandwidthSnapshot[] = [];
let pollTimer: ReturnType<typeof setInterval> | null = null;

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
  } catch (err) {
    // Uma falha de coleta (controller fora do ar, credenciais erradas,
    // rede instável) não pode derrubar o processo nem parar o poller — só
    // pula essa amostra e tenta de novo no próximo ciclo de 5 minutos.
    console.error('[bandwidth-history] falha ao coletar amostra de uso de banda:', err);
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

// Começa a coletar assim que o módulo é importado (isso é, assim que o
// backend sobe), sem esperar ninguém "assinar" — ao contrário do hub de
// eventos WS, aqui não faz sentido só coletar enquanto alguém está olhando
// o dashboard, já que é uma métrica de série temporal.
startPolling();

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

export const bandwidthHistoryService = {
  getHistory,
  computeDelta,
};
