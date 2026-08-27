import { useCallback, useEffect, useState } from 'react';
import { Badge } from '../components/Badge';
import { Layout } from '../components/Layout';
import { api, ApiError, type Pagination, type UniFiClient } from '../lib/api';

const PAGE_SIZE = 8;

type TypeFilter = 'ALL' | 'WIRED' | 'WIRELESS';
type BlockedFilter = 'ALL' | 'ACTIVE' | 'BLOCKED';

export function Clients() {
  const [clients, setClients] = useState<UniFiClient[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState<TypeFilter>('ALL');
  const [blockedFilter, setBlockedFilter] = useState<BlockedFilter>('ALL');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingMac, setPendingMac] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .listClients({
        page,
        pageSize: PAGE_SIZE,
        type: typeFilter,
        blocked: blockedFilter === 'ALL' ? undefined : blockedFilter === 'BLOCKED',
      })
      .then((res) => {
        setClients(res.data);
        setPagination(res.pagination);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Erro ao carregar clientes'))
      .finally(() => setLoading(false));
  }, [page, typeFilter, blockedFilter]);

  useEffect(() => {
    load();
  }, [load]);

  function changeTypeFilter(value: TypeFilter) {
    setTypeFilter(value);
    setPage(1);
  }

  function changeBlockedFilter(value: BlockedFilter) {
    setBlockedFilter(value);
    setPage(1);
  }

  async function toggleBlock(client: UniFiClient) {
    setPendingMac(client.macAddress);
    try {
      if (client.blocked) {
        await api.unblockClient(client.macAddress);
      } else {
        await api.blockClient(client.macAddress);
      }
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao atualizar o cliente');
    } finally {
      setPendingMac(null);
    }
  }

  return (
    <Layout title="Clientes">
      <div className="mb-4 flex items-center gap-2">
        <Pill active={typeFilter === 'ALL'} onClick={() => changeTypeFilter('ALL')}>
          Todos
        </Pill>
        <Pill active={typeFilter === 'WIRED'} onClick={() => changeTypeFilter('WIRED')}>
          Cabo
        </Pill>
        <Pill active={typeFilter === 'WIRELESS'} onClick={() => changeTypeFilter('WIRELESS')}>
          Wi-Fi
        </Pill>
        <div className="mx-1 h-4.5 w-px bg-slate-200" />
        <Pill active={blockedFilter === 'ALL'} onClick={() => changeBlockedFilter('ALL')}>
          Status: todos
        </Pill>
        <Pill active={blockedFilter === 'ACTIVE'} onClick={() => changeBlockedFilter('ACTIVE')}>
          Ativos
        </Pill>
        <Pill active={blockedFilter === 'BLOCKED'} onClick={() => changeBlockedFilter('BLOCKED')}>
          Bloqueados
        </Pill>
      </div>

      {error && (
        <div className="mb-4 rounded-lg border border-[oklch(88%_0.06_25)] bg-[oklch(97%_0.03_25)] px-4 py-3 text-sm text-[oklch(40%_0.15_25)]">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="grid grid-cols-[2.2fr_1.6fr_1.3fr_0.9fr_1.3fr_1.1fr] bg-slate-50 px-5 py-2.75 text-[11px] font-bold uppercase tracking-wide text-slate-500">
          <span>Cliente</span>
          <span>MAC</span>
          <span>IP</span>
          <span>Tipo</span>
          <span>Status</span>
          <span className="text-right">Ação</span>
        </div>

        {loading && <div className="px-5 py-8 text-center text-sm text-slate-400">Carregando…</div>}

        {!loading &&
          clients.map((c) => (
            <div
              key={c.id}
              className="grid grid-cols-[2.2fr_1.6fr_1.3fr_0.9fr_1.3fr_1.1fr] items-center border-t border-slate-100 px-5 py-3"
            >
              <span className="truncate text-[13px] font-semibold text-slate-800">{c.name ?? c.hostname ?? 'Sem nome'}</span>
              <span className="font-mono text-xs text-slate-500">{c.macAddress}</span>
              <span className="font-mono text-xs text-slate-500">{c.ipAddress ?? '—'}</span>
              <span className="text-xs text-slate-600">{c.type === 'WIRED' ? 'Cabo' : 'Wi-Fi'}</span>
              <Badge tone={c.blocked ? 'danger' : 'success'}>{c.blocked ? 'Bloqueado' : 'Ativo'}</Badge>
              <div className="flex justify-end">
                <button
                  onClick={() => toggleBlock(c)}
                  disabled={pendingMac === c.macAddress}
                  className={`rounded-md border px-3 py-1.5 text-[11.5px] font-semibold disabled:opacity-50 ${
                    c.blocked
                      ? 'border-[oklch(85%_0.05_150)] bg-[oklch(97%_0.03_150_/_0.6)] text-[oklch(40%_0.13_150)]'
                      : 'border-[oklch(87%_0.06_25)] bg-white text-[oklch(48%_0.16_25)]'
                  }`}
                >
                  {pendingMac === c.macAddress ? '...' : c.blocked ? 'Desbloquear' : 'Bloquear'}
                </button>
              </div>
            </div>
          ))}

        {!loading && clients.length === 0 && (
          <div className="px-5 py-8 text-center text-sm text-slate-400">Nenhum cliente encontrado com esses filtros.</div>
        )}
      </div>

      {pagination && (
        <div className="mt-4 flex items-center justify-between">
          <span className="text-[12.5px] text-slate-500">
            {pagination.total === 0
              ? 'Nenhum cliente'
              : `Mostrando ${(pagination.page - 1) * pagination.pageSize + 1}–${Math.min(
                  pagination.page * pagination.pageSize,
                  pagination.total,
                )} de ${pagination.total}`}
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-40"
            >
              Anterior
            </button>
            <span className="font-mono text-xs text-slate-500">
              Página {pagination.page} de {pagination.totalPages}
            </span>
            <button
              onClick={() => setPage((p) => Math.min(pagination.totalPages, p + 1))}
              disabled={page >= pagination.totalPages}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-40"
            >
              Próximo
            </button>
          </div>
        </div>
      )}
    </Layout>
  );
}

function Pill({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`rounded-full border px-3.25 py-1.5 text-[12.5px] font-semibold ${
        active ? 'border-accent bg-accent text-white' : 'border-slate-300 bg-white text-slate-600'
      }`}
    >
      {children}
    </button>
  );
}
