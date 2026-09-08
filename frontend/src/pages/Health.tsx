import { Activity, ArrowDownUp, Cpu, Signal, Wifi } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '../components/Badge';
import { Layout } from '../components/Layout';
import { StatCard } from '../components/StatCard';
import { usePolling } from '../hooks/usePolling';
import { api, type BandwidthDelta, type ClientSignal, type DeviceHealth, type WanHistoryDetail } from '../lib/api';

const POLL_INTERVAL_MS = 60_000;

// Formata bytes crus de forma legível ("1.2 GB" em vez de "1288490188") —
// mesmo espírito de formatUptime abaixo, sem precisar de lib externa.
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex++;
  }
  return `${value.toFixed(unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

interface BandwidthTotal {
  mac: string;
  label: string;
  totalBytes: number;
}

// O buffer de histórico guarda uma amostra a cada 5 min; /bandwidth/history/
// summary já entrega a diferença (uso no intervalo) entre cada par de
// amostras consecutivas. Aqui somamos esses deltas por device/cliente pra
// chegar no total trafegado no período inteiro coberto pelo buffer (até
// 24h). Diffs ausentes (null, contador zerou por restart/reconexão) são
// tratados como "sem dado pra esse intervalo", não como zero silencioso —
// mas como não dá pra distinguir "sem dado" de "zero" no total agregado,
// simplesmente não somamos nada nesse intervalo pra esse device/cliente.
function sumBandwidth(
  deltas: BandwidthDelta[],
  key: 'perDevice' | 'perClient',
): BandwidthTotal[] {
  const totals = new Map<string, BandwidthTotal>();

  for (const delta of deltas) {
    for (const entry of delta[key]) {
      const mac = entry.mac;
      const label = 'name' in entry ? entry.name : (entry as { hostname: string }).hostname;
      const current = totals.get(mac) ?? { mac, label, totalBytes: 0 };
      const rx = entry.rxBytes ?? 0;
      const tx = entry.txBytes ?? 0;
      current.totalBytes += rx + tx;
      current.label = label;
      totals.set(mac, current);
    }
  }

  return Array.from(totals.values()).sort((a, b) => b.totalBytes - a.totalBytes);
}

// Converte segundos pra algo legível tipo "2d 9h" — mesmo espírito de
// formatação amigável já usado em outras páginas (ex: Badge de status em
// Devices.tsx), sem precisar de uma lib de datas só pra isso.
function formatUptime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '—';
  const days = Math.floor(seconds / 86400);
  const hours = Math.floor((seconds % 86400) / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function signalTone(dbm: number | undefined): 'success' | 'warning' | 'danger' | 'neutral' {
  if (dbm === undefined) return 'neutral';
  if (dbm > -60) return 'success';
  if (dbm >= -75) return 'warning';
  return 'danger';
}

function signalLabel(dbm: number | undefined): string {
  if (dbm === undefined) return 'N/A';
  return `${dbm} dBm`;
}

function utilizationTone(pct: number | undefined): 'success' | 'warning' | 'danger' | 'neutral' {
  if (pct === undefined) return 'neutral';
  if (pct < 40) return 'success';
  if (pct < 75) return 'warning';
  return 'danger';
}

export function Health() {
  const [devices, setDevices] = useState<DeviceHealth[] | null>(null);
  const [clients, setClients] = useState<ClientSignal[] | null>(null);
  const [wanHistory, setWanHistory] = useState<WanHistoryDetail[] | null>(null);
  const [bandwidthDeltas, setBandwidthDeltas] = useState<BandwidthDelta[] | null>(null);
  const [expandedMac, setExpandedMac] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `silent = true` (polling em segundo plano) nunca reseta os states pra `null` — é esse
  // `null` que cada seção usa como sinal de "carregando". Falha silenciosa só loga no console e
  // mantém os dados antigos na tela, em vez de substituir por erro a cada ciclo de 60s.
  const load = useCallback((silent = false) => {
    Promise.all([
      api.getDeviceHealth(),
      api.getClientSignalStrength(),
      api.getWanUptimeHistory(),
      api.getBandwidthSummary(),
    ])
      .then(([d, c, w, b]) => {
        setDevices(d.data);
        setClients(c.data);
        setWanHistory(w.data);
        setBandwidthDeltas(b.data);
      })
      .catch((err) => {
        if (silent) {
          console.error('Falha ao atualizar dados de saúde da rede em segundo plano', err);
          return;
        }
        setError(err instanceof Error ? err.message : 'Erro ao carregar dados de saúde da rede');
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  usePolling(() => load(true), POLL_INTERVAL_MS);

  const deviceBandwidth = bandwidthDeltas ? sumBandwidth(bandwidthDeltas, 'perDevice') : null;
  const clientBandwidth = bandwidthDeltas ? sumBandwidth(bandwidthDeltas, 'perClient') : null;

  // Disponibilidade calculada a partir de quantos pontos de health_history
  // (de TODOS os wan_history_details, ex: WAN1/WAN2) têm wan_downtime false.
  // O controller já mantém esse histórico das últimas 24h — não precisamos
  // persistir nada nós mesmos.
  //
  // Pontos sem wan_downtime definido (ex: {"not_reported": true, "offline_reason":
  // [{"reason": "console_upgrading"}]}, observado de verdade no ambiente de
  // testes) NÃO contam como "up" — contam à parte, como "não reportado", pra
  // não esconder uma janela real de indisponibilidade do próprio controller/
  // gateway atrás de um percentual que parece bom.
  const allHealthPoints = wanHistory?.flatMap((detail) => detail.health_history ?? []) ?? [];
  const upPoints = allHealthPoints.filter((p) => p.wan_downtime === false).length;
  const downPoints = allHealthPoints.filter((p) => p.wan_downtime === true).length;
  const unreportedPoints = allHealthPoints.length - upPoints - downPoints;
  const availabilityPct =
    allHealthPoints.length > 0 ? ((upPoints / allHealthPoints.length) * 100).toFixed(2) : undefined;
  const downtimePeriods = wanHistory?.flatMap((detail) => detail.downtime_history ?? []) ?? [];

  function toggleExpand(mac: string) {
    setExpandedMac((current) => (current === mac ? null : mac));
  }

  return (
    <Layout title="Saúde da rede">
      {error && (
        <div className="mb-5 rounded-lg border border-[oklch(88%_0.06_25)] bg-[oklch(97%_0.03_25)] px-4 py-3 text-sm text-[oklch(40%_0.15_25)]">
          {error}
        </div>
      )}

      <div className="mb-5.5 grid grid-cols-3 gap-4">
        <StatCard
          label="Disponibilidade do WAN (24h)"
          value={availabilityPct !== undefined ? `${availabilityPct}%` : '—'}
          trend={
            downtimePeriods.length > 0
              ? `${downtimePeriods.length} período(s) de queda registrado(s)`
              : 'Sem quedas registradas'
          }
          trendTone={downtimePeriods.length > 0 ? 'danger' : 'success'}
          icon={<Activity className="h-3.5 w-3.5 text-[oklch(50%_0.13_150)]" strokeWidth={2} />}
          iconBg="oklch(94% 0.05 150 / 0.5)"
        />
        <StatCard
          label="APs/switches monitorados"
          value={devices ? devices.length : '—'}
          icon={<Cpu className="h-3.5 w-3.5 text-accent" strokeWidth={2} />}
          iconBg="oklch(95% 0.03 255 / 0.6)"
        />
        <StatCard
          label="Clientes Wi-Fi conectados"
          value={clients ? clients.length : '—'}
          icon={<Wifi className="h-3.5 w-3.5 text-[oklch(55%_0.18_25)]" strokeWidth={2} />}
          iconBg="oklch(95% 0.05 25 / 0.5)"
        />
      </div>

      <div className="mb-5 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <span className="text-[13.5px] font-bold text-slate-900">Saúde dos APs/switches</span>
        </div>

        <div className="grid grid-cols-[1.6fr_0.8fr_0.8fr_1fr_0.9fr] bg-slate-50 px-5 py-2.75 text-[11px] font-bold uppercase tracking-wide text-slate-500">
          <span>Dispositivo</span>
          <span>CPU</span>
          <span>Memória</span>
          <span>Uptime</span>
          <span>Clientes</span>
        </div>

        {devices === null && !error && (
          <div className="px-5 py-8 text-center text-sm text-slate-400">Carregando…</div>
        )}

        {devices?.map((d) => (
          <div key={d.mac} className="border-t border-slate-100">
            <div
              onClick={() => toggleExpand(d.mac)}
              className="grid cursor-pointer grid-cols-[1.6fr_0.8fr_0.8fr_1fr_0.9fr] items-center px-5 py-3 hover:bg-slate-50"
            >
              <span className="truncate text-[13px] font-semibold text-slate-800">{d.name}</span>
              <span className="font-mono text-xs text-slate-600">{d.cpu.toFixed(1)}%</span>
              <span className="font-mono text-xs text-slate-600">{d.mem.toFixed(1)}%</span>
              <span className="text-xs text-slate-500">{formatUptime(d.uptimeSeconds)}</span>
              <span className="text-xs text-slate-500">{d.clientCount}</span>
            </div>

            {expandedMac === d.mac && (
              <div className="border-t border-slate-100 bg-slate-50 px-5 py-4">
                {d.radios.length === 0 ? (
                  <div className="text-xs text-slate-400">
                    Este dispositivo não tem rádios (provavelmente é um switch).
                  </div>
                ) : (
                  <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                    <div className="grid grid-cols-[1fr_1fr_1.2fr_1.2fr_0.9fr] bg-slate-50 px-4 py-2 text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
                      <span>Rádio</span>
                      <span>Canal</span>
                      <span>Utilização do canal</span>
                      <span>Satisfação</span>
                      <span>Clientes</span>
                    </div>
                    {d.radios.map((radio, i) => (
                      <div
                        key={i}
                        className="grid grid-cols-[1fr_1fr_1.2fr_1.2fr_0.9fr] items-center border-t border-slate-100 px-4 py-2.5"
                      >
                        <span className="font-mono text-xs font-semibold text-slate-700">{radio.name}</span>
                        <span className="text-xs text-slate-500">{radio.channel ?? '—'}</span>
                        <Badge tone={utilizationTone(radio.channelUtilizationPct)}>
                          {radio.channelUtilizationPct !== undefined ? `${radio.channelUtilizationPct}%` : 'N/A'}
                        </Badge>
                        <span className="text-xs text-slate-500">
                          {radio.satisfactionScore !== undefined && radio.satisfactionScore >= 0
                            ? `${radio.satisfactionScore}/100`
                            : 'N/A'}
                        </span>
                        <span className="text-xs text-slate-500">{radio.clientCount ?? '—'}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {devices?.length === 0 && (
          <div className="px-5 py-8 text-center text-sm text-slate-400">Nenhum dispositivo encontrado.</div>
        )}
      </div>

      <div className="mb-5 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4">
          <Signal className="h-4 w-4 text-slate-500" strokeWidth={2} />
          <span className="text-[13.5px] font-bold text-slate-900">Força de sinal dos clientes Wi-Fi</span>
        </div>

        <div className="grid grid-cols-[1.6fr_1fr_1fr] bg-slate-50 px-5 py-2.75 text-[11px] font-bold uppercase tracking-wide text-slate-500">
          <span>Cliente</span>
          <span>Sinal</span>
          <span>Canal</span>
        </div>

        {clients === null && !error && (
          <div className="px-5 py-8 text-center text-sm text-slate-400">Carregando…</div>
        )}

        {clients?.map((c) => (
          <div key={c.mac} className="grid grid-cols-[1.6fr_1fr_1fr] items-center border-t border-slate-100 px-5 py-3">
            <span className="truncate text-[13px] font-semibold text-slate-800">{c.hostname}</span>
            <Badge tone={signalTone(c.signalDbm)}>{signalLabel(c.signalDbm)}</Badge>
            <span className="text-xs text-slate-500">{c.channel ?? '—'}</span>
          </div>
        ))}

        {clients?.length === 0 && (
          <div className="px-5 py-8 text-center text-sm text-slate-400">Nenhum cliente Wi-Fi conectado no momento.</div>
        )}
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
          <span className="text-[13.5px] font-bold text-slate-900">Uptime do gateway/WAN (últimas 24h)</span>
        </div>
        <div className="px-5 py-4">
          {wanHistory === null && !error && <div className="text-sm text-slate-400">Carregando…</div>}

          {wanHistory && (
            <>
              <p className="mb-1 text-[13px] text-slate-700">
                {availabilityPct !== undefined
                  ? `${availabilityPct}% de disponibilidade confirmada nas últimas 24h (${upPoints} de ${allHealthPoints.length} pontos monitorados sem queda${downPoints > 0 ? `, ${downPoints} com queda confirmada` : ''}).`
                  : 'Sem dados de histórico de WAN disponíveis.'}
              </p>
              {unreportedPoints > 0 && (
                <p className="mb-2 text-xs text-[oklch(55%_0.13_80)]">
                  {unreportedPoints} de {allHealthPoints.length} pontos vieram sem status reportado pelo controller
                  (ex: durante uma atualização do próprio gateway) — não contam nem como disponível nem como queda,
                  então o percentual acima pode não refletir uma indisponibilidade real nessas janelas.
                </p>
              )}
              {downtimePeriods.length > 0 ? (
                <div className="mt-2 flex flex-col gap-1.5">
                  <span className="text-xs font-semibold text-slate-500">Períodos de queda registrados:</span>
                  {downtimePeriods.map((period, i) => {
                    const p = period as Record<string, unknown>;
                    const start = typeof p.start === 'number' ? new Date(p.start).toLocaleString('pt-BR') : null;
                    const end = typeof p.end === 'number' ? new Date(p.end).toLocaleString('pt-BR') : null;
                    return (
                      <span key={i} className="rounded-md bg-slate-50 px-3 py-1.5 text-xs text-slate-600">
                        {start && end ? `${start} até ${end}` : JSON.stringify(period)}
                      </span>
                    );
                  })}
                </div>
              ) : (
                <span className="text-xs text-slate-400">Nenhum período de queda registrado nas últimas 24h.</span>
              )}
            </>
          )}
        </div>
      </div>

      <div className="mb-5 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4">
          <ArrowDownUp className="h-4 w-4 text-slate-500" strokeWidth={2} />
          <span className="text-[13.5px] font-bold text-slate-900">Uso de banda (últimas 24h)</span>
        </div>

        {bandwidthDeltas === null && !error && (
          <div className="px-5 py-8 text-center text-sm text-slate-400">Carregando…</div>
        )}

        {bandwidthDeltas && bandwidthDeltas.length === 0 && (
          <div className="px-5 py-8 text-center text-sm text-slate-400">
            Coletando dados… a primeira amostra aparece em até 5 minutos depois do backend subir.
          </div>
        )}

        {bandwidthDeltas && bandwidthDeltas.length > 0 && (
          <div className="grid grid-cols-2 divide-x divide-slate-100">
            <div>
              <div className="grid grid-cols-[1.6fr_1fr] bg-slate-50 px-5 py-2.75 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                <span>Dispositivo</span>
                <span>Total trafegado</span>
              </div>
              {deviceBandwidth?.map((entry) => (
                <div
                  key={entry.mac}
                  className="grid grid-cols-[1.6fr_1fr] items-center border-t border-slate-100 px-5 py-3"
                >
                  <span className="truncate text-[13px] font-semibold text-slate-800">{entry.label}</span>
                  <span className="font-mono text-xs text-slate-600">{formatBytes(entry.totalBytes)}</span>
                </div>
              ))}
              {deviceBandwidth?.length === 0 && (
                <div className="px-5 py-6 text-center text-xs text-slate-400">Nenhum dado de device ainda.</div>
              )}
            </div>

            <div>
              <div className="grid grid-cols-[1.6fr_1fr] bg-slate-50 px-5 py-2.75 text-[11px] font-bold uppercase tracking-wide text-slate-500">
                <span>Cliente</span>
                <span>Total trafegado</span>
              </div>
              {clientBandwidth?.map((entry) => (
                <div
                  key={entry.mac}
                  className="grid grid-cols-[1.6fr_1fr] items-center border-t border-slate-100 px-5 py-3"
                >
                  <span className="truncate text-[13px] font-semibold text-slate-800">{entry.label}</span>
                  <span className="font-mono text-xs text-slate-600">{formatBytes(entry.totalBytes)}</span>
                </div>
              ))}
              {clientBandwidth?.length === 0 && (
                <div className="px-5 py-6 text-center text-xs text-slate-400">Nenhum dado de cliente ainda.</div>
              )}
            </div>
          </div>
        )}

        <div className="border-t border-slate-100 px-5 py-2.5 text-[11.5px] text-slate-400">
          Coletado a cada 5 minutos por um poller em segundo plano (buffer de até 24h/288 amostras, em memória —
          reseta a cada restart do backend).
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-[12.5px] text-slate-500">
        O histórico de uptime do WAN vem diretamente do controller (últimas 24h), sem necessidade de armazenamento
        próprio.
      </div>
    </Layout>
  );
}
