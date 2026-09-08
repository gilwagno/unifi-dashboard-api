import { Ban, Radio, Users, Wifi } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Badge } from '../components/Badge';
import { Layout } from '../components/Layout';
import { StatCard } from '../components/StatCard';
import { usePolling } from '../hooks/usePolling';
import { api, type UniFiClient, type UniFiDevice, type UniFiEventRecord } from '../lib/api';

const POLL_INTERVAL_MS = 60_000;

function timeAgo(iso: string) {
  const diffMs = Date.now() - new Date(iso).getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'agora mesmo';
  if (min < 60) return `há ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `há ${h} h`;
  return `há ${Math.floor(h / 24)} d`;
}

function summarizeEvent(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    return parsed.meta?.message ?? parsed.key ?? parsed.type ?? 'Evento do controller';
  } catch {
    return raw.slice(0, 80);
  }
}

export function Overview() {
  const [clients, setClients] = useState<UniFiClient[] | null>(null);
  const [devices, setDevices] = useState<UniFiDevice[] | null>(null);
  const [events, setEvents] = useState<UniFiEventRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `silent = true` (polling em segundo plano) nunca reseta os states pra `null` — é esse
  // `null` que os StatCards usam como "—" enquanto carregam. Falha silenciosa só loga no
  // console e mantém os dados antigos na tela, em vez de trocar por erro a cada ciclo de 60s.
  const load = useCallback((silent = false) => {
    Promise.all([
      api.listClients({ pageSize: 200 }),
      api.listDevices({ pageSize: 200 }),
      api.eventsHistory(6),
    ])
      .then(([c, d, e]) => {
        setClients(c.data);
        setDevices(d.data);
        setEvents(e.data);
      })
      .catch((err) => {
        if (silent) {
          console.error('Falha ao atualizar a visão geral em segundo plano', err);
          return;
        }
        setError(err instanceof Error ? err.message : 'Erro ao carregar dados');
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  usePolling(() => load(true), POLL_INTERVAL_MS);

  const totalClients = clients?.length ?? 0;
  const blockedClients = clients?.filter((c) => c.blocked).length ?? 0;
  const onlineDevices = devices?.filter((d) => d.state === 'ONLINE').length ?? 0;
  const totalDevices = devices?.length ?? 0;

  return (
    <Layout title="Visão geral">
      {error && (
        <div className="mb-5 rounded-lg border border-[oklch(88%_0.06_25)] bg-[oklch(97%_0.03_25)] px-4 py-3 text-sm text-[oklch(40%_0.15_25)]">
          {error}
        </div>
      )}

      <div className="mb-5.5 grid grid-cols-4 gap-4">
        <StatCard
          label="Clientes conectados"
          value={clients ? totalClients : '—'}
          icon={<Users className="h-3.5 w-3.5 text-accent" strokeWidth={2} />}
          iconBg="oklch(94% 0.03 255 / 0.6)"
        />
        <StatCard
          label="Clientes bloqueados"
          value={clients ? blockedClients : '—'}
          icon={<Ban className="h-3.5 w-3.5 text-[oklch(55%_0.18_25)]" strokeWidth={2} />}
          iconBg="oklch(95% 0.05 25 / 0.5)"
        />
        <StatCard
          label="Access points online"
          value={devices ? `${onlineDevices}/${totalDevices}` : '—'}
          trend={devices ? (onlineDevices === totalDevices ? 'todos operacionais' : `${totalDevices - onlineDevices} offline`) : undefined}
          trendTone={devices && onlineDevices === totalDevices ? 'success' : 'danger'}
          icon={<Wifi className="h-3.5 w-3.5 text-[oklch(50%_0.13_150)]" strokeWidth={2} />}
          iconBg="oklch(94% 0.05 150 / 0.5)"
        />
        <StatCard
          label="Eventos recentes"
          value={events ? events.length : '—'}
          trend="via WebSocket"
          icon={<Radio className="h-3.5 w-3.5 text-accent" strokeWidth={2} />}
          iconBg="oklch(95% 0.03 255 / 0.6)"
        />
      </div>

      <div className="grid grid-cols-[1.4fr_1fr] items-start gap-4">
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <span className="text-[13.5px] font-bold text-slate-900">Access points</span>
            <Link to="/devices" className="text-xs font-semibold text-accent">
              Ver todos →
            </Link>
          </div>
          <div>
            {devices?.slice(0, 5).map((d) => (
              <div key={d.id} className="flex items-center justify-between border-b border-slate-50 px-5 py-3 last:border-b-0">
                <div className="flex min-w-0 items-center gap-2.75">
                  <span
                    className="h-2 w-2 shrink-0 rounded-full"
                    style={{ background: d.state === 'ONLINE' ? 'oklch(58% 0.16 150)' : 'oklch(55% 0.18 25)' }}
                  />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-[13px] font-semibold text-slate-800">{d.name}</span>
                    <span className="font-mono text-[11px] text-slate-500">{d.ipAddress ?? '—'}</span>
                  </div>
                </div>
                <Badge tone={d.state === 'ONLINE' ? 'success' : 'danger'}>
                  {d.state === 'ONLINE' ? 'Online' : d.state}
                </Badge>
              </div>
            ))}
            {devices?.length === 0 && <div className="px-5 py-6 text-sm text-slate-400">Nenhum dispositivo encontrado.</div>}
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <span className="text-[13.5px] font-bold text-slate-900">Eventos recentes</span>
            <Link to="/events" className="text-xs font-semibold text-accent">
              Ver todos →
            </Link>
          </div>
          <div>
            {events?.map((ev, i) => (
              <div key={i} className="flex flex-col gap-0.5 border-b border-slate-50 px-5 py-2.75 last:border-b-0">
                <span className="text-[12.5px] text-slate-700">{summarizeEvent(ev.data)}</span>
                <span className="font-mono text-[10.5px] text-slate-400">{timeAgo(ev.receivedAt)}</span>
              </div>
            ))}
            {events?.length === 0 && (
              <div className="px-5 py-6 text-sm text-slate-400">
                Nenhum evento no buffer ainda — abra o WebSocket em /ws/events para começar a coletar.
              </div>
            )}
          </div>
        </div>
      </div>
    </Layout>
  );
}
