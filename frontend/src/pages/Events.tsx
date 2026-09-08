import { useCallback, useEffect, useState } from 'react';
import { Layout } from '../components/Layout';
import { usePolling } from '../hooks/usePolling';
import { api, type UniFiEventRecord } from '../lib/api';

const POLL_INTERVAL_MS = 60_000;

// Nenhum campo do payload é confiável: `meta.message`/`key`/`type` podem vir
// como objeto/array em schemas desconhecidos, e devolver isso pra JSX quebra a
// página inteira ("Objects are not valid as a React child"). Só aceita valores
// que dá pra renderizar como texto; qualquer outra coisa cai no resumo JSON.
function summarize(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    const candidate = parsed?.meta?.message ?? parsed?.key ?? parsed?.type;
    if (typeof candidate === 'string') return candidate;
    if (typeof candidate === 'number' || typeof candidate === 'boolean') return String(candidate);
    return String(JSON.stringify(parsed) ?? raw).slice(0, 120);
  } catch {
    return raw.slice(0, 160);
  }
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleString('pt-BR');
}

export function Events() {
  const [events, setEvents] = useState<UniFiEventRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // `silent = true` (usado pelo polling em segundo plano) nunca reseta `events` para `null` —
  // é esse `null` que a UI usa como sinal de "carregando", então mantê-lo intacto evita que a
  // lista pisque "Carregando…" a cada minuto. Falha silenciosa só loga no console e mantém o
  // buffer antigo na tela, em vez de substituir por uma mensagem de erro a cada ciclo.
  const load = useCallback((silent = false) => {
    api
      .eventsHistory(200)
      .then((res) => setEvents(res.data))
      .catch((err) => {
        if (silent) {
          console.error('Falha ao atualizar eventos em segundo plano', err);
          return;
        }
        setError(err instanceof Error ? err.message : 'Erro ao carregar eventos');
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  usePolling(() => load(true), POLL_INTERVAL_MS);

  return (
    <Layout title="Eventos">
      {error && (
        <div className="mb-4 rounded-lg border border-[oklch(88%_0.06_25)] bg-[oklch(97%_0.03_25)] px-4 py-3 text-sm text-[oklch(40%_0.15_25)]">
          {error}
        </div>
      )}

      <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-[12.5px] text-slate-500">
        Buffer em memória (até 200 eventos) — zera a cada restart do backend e só é alimentado enquanto o WebSocket de
        eventos está ativo.
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        {events?.length === 0 && (
          <div className="px-5 py-10 text-center text-sm text-slate-400">
            Nenhum evento no buffer ainda. Eventos aparecem aqui quando o controller UniFi envia algo pelo WebSocket.
          </div>
        )}
        {events?.map((ev, i) => (
          <div key={i} className="flex items-start gap-3.5 border-t border-slate-50 px-5 py-3.5 first:border-t-0">
            <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-accent" />
            <div className="flex grow flex-col gap-0.5">
              <span className="text-[13px] text-slate-700">{summarize(ev.data)}</span>
              <span className="font-mono text-[11px] text-slate-400">{formatTime(ev.receivedAt)}</span>
            </div>
          </div>
        ))}
        {events === null && !error && <div className="px-5 py-10 text-center text-sm text-slate-400">Carregando…</div>}
      </div>
    </Layout>
  );
}
