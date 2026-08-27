import { useCallback, useEffect, useState } from 'react';
import { Badge } from '../components/Badge';
import { Layout } from '../components/Layout';
import { api, ApiError, type Pagination, type UniFiDevice, type UniFiDeviceDetail } from '../lib/api';

const PAGE_SIZE = 8;

export function Devices() {
  const [devices, setDevices] = useState<UniFiDevice[]>([]);
  const [pagination, setPagination] = useState<Pagination | null>(null);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<UniFiDeviceDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState<string | null>(null);
  const [portActionError, setPortActionError] = useState<string | null>(null);
  const [pendingPort, setPendingPort] = useState<number | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    setError(null);
    api
      .listDevices({ page, pageSize: PAGE_SIZE })
      .then((res) => {
        setDevices(res.data);
        setPagination(res.pagination);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Erro ao carregar dispositivos'))
      .finally(() => setLoading(false));
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  async function restart(device: UniFiDevice) {
    if (!confirm(`Reiniciar "${device.name}"? Isso derruba a conexão dos clientes ligados a ele por alguns segundos.`)) {
      return;
    }
    setPendingId(device.id);
    try {
      await api.restartDevice(device.id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao reiniciar o dispositivo');
    } finally {
      setPendingId(null);
    }
  }

  function loadDetail(id: string) {
    setDetailLoading(true);
    setDetailError(null);
    api
      .getDevice(id)
      .then(setDetail)
      .catch((err) => setDetailError(err instanceof Error ? err.message : 'Erro ao carregar as portas'))
      .finally(() => setDetailLoading(false));
  }

  function toggleExpand(device: UniFiDevice) {
    if (expandedId === device.id) {
      setExpandedId(null);
      setDetail(null);
      return;
    }
    setExpandedId(device.id);
    setDetail(null);
    setPortActionError(null);
    loadDetail(device.id);
  }

  async function powerCyclePort(device: UniFiDevice, portIdx: number) {
    if (
      !confirm(
        `Power-cycle na porta ${portIdx} de "${device.name}"? Isso reinicia qualquer equipamento PoE conectado nessa porta (ex.: um AP).`,
      )
    ) {
      return;
    }
    setPendingPort(portIdx);
    setPortActionError(null);
    try {
      await api.powerCyclePort(device.id, portIdx);
      loadDetail(device.id);
    } catch (err) {
      setPortActionError(err instanceof ApiError ? err.message : 'Falha ao fazer power-cycle da porta');
    } finally {
      setPendingPort(null);
    }
  }

  return (
    <Layout title="Dispositivos">
      {error && (
        <div className="mb-4 rounded-lg border border-[oklch(88%_0.06_25)] bg-[oklch(97%_0.03_25)] px-4 py-3 text-sm text-[oklch(40%_0.15_25)]">
          {error}
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="grid grid-cols-[2fr_1.3fr_1.6fr_1.3fr_1.1fr_1.1fr] bg-slate-50 px-5 py-2.75 text-[11px] font-bold uppercase tracking-wide text-slate-500">
          <span>Dispositivo</span>
          <span>Modelo</span>
          <span>MAC</span>
          <span>IP</span>
          <span>Status</span>
          <span className="text-right">Ação</span>
        </div>

        {loading && <div className="px-5 py-8 text-center text-sm text-slate-400">Carregando…</div>}

        {!loading &&
          devices.map((d) => (
            <div key={d.id} className="border-t border-slate-100">
              <div
                onClick={() => toggleExpand(d)}
                className="grid cursor-pointer grid-cols-[2fr_1.3fr_1.6fr_1.3fr_1.1fr_1.1fr] items-center px-5 py-3 hover:bg-slate-50"
              >
                <div className="flex min-w-0 items-center gap-2.5">
                  <span
                    className="h-1.75 w-1.75 shrink-0 rounded-full"
                    style={{
                      background:
                        d.state === 'ONLINE'
                          ? 'oklch(58% 0.16 150)'
                          : d.state === 'PENDING' || d.state === 'UPDATING'
                            ? 'oklch(65% 0.15 80)'
                            : 'oklch(55% 0.18 25)',
                    }}
                  />
                  <span className="truncate text-[13px] font-semibold text-slate-800">{d.name}</span>
                </div>
                <span className="text-xs text-slate-600">{d.model}</span>
                <span className="font-mono text-xs text-slate-500">{d.macAddress}</span>
                <span className="font-mono text-xs text-slate-500">{d.ipAddress ?? '—'}</span>
                <Badge
                  tone={d.state === 'ONLINE' ? 'success' : d.state === 'PENDING' || d.state === 'UPDATING' ? 'warning' : 'danger'}
                >
                  {d.state === 'ONLINE'
                    ? 'Online'
                    : d.state === 'PENDING'
                      ? 'Pendente'
                      : d.state === 'UPDATING'
                        ? 'Atualizando'
                        : 'Offline'}
                </Badge>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      restart(d);
                    }}
                    disabled={pendingId === d.id}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[11.5px] font-semibold text-slate-700 disabled:opacity-50"
                  >
                    {pendingId === d.id ? 'Reiniciando…' : 'Reiniciar'}
                  </button>
                </div>
              </div>

              {expandedId === d.id && (
                <div className="border-t border-slate-100 bg-slate-50 px-5 py-4">
                  {detailLoading && <div className="text-xs text-slate-400">Carregando portas…</div>}

                  {detailError && (
                    <div className="mb-2 rounded-md border border-[oklch(88%_0.06_25)] bg-[oklch(97%_0.03_25)] px-3 py-2 text-xs text-[oklch(40%_0.15_25)]">
                      {detailError}
                    </div>
                  )}

                  {portActionError && (
                    <div className="mb-2 rounded-md border border-[oklch(88%_0.06_25)] bg-[oklch(97%_0.03_25)] px-3 py-2 text-xs text-[oklch(40%_0.15_25)]">
                      {portActionError}
                    </div>
                  )}

                  {!detailLoading && !detailError && detail && (
                    <>
                      {!detail.interfaces?.ports || detail.interfaces.ports.length === 0 ? (
                        <div className="text-xs text-slate-400">Este dispositivo não tem portas gerenciáveis.</div>
                      ) : (
                        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white">
                          <div className="grid grid-cols-[0.6fr_1fr_1fr_1.2fr] bg-slate-50 px-4 py-2 text-[10.5px] font-bold uppercase tracking-wide text-slate-500">
                            <span>Porta</span>
                            <span>Estado</span>
                            <span>Velocidade</span>
                            <span className="text-right">Ação</span>
                          </div>
                          {detail.interfaces.ports.map((port) => (
                            <div
                              key={port.idx}
                              className="grid grid-cols-[0.6fr_1fr_1fr_1.2fr] items-center border-t border-slate-100 px-4 py-2.5"
                            >
                              <span className="font-mono text-xs font-semibold text-slate-700">{port.idx}</span>
                              <Badge tone={port.state === 'UP' ? 'success' : 'neutral'}>
                                {port.state === 'UP' ? 'Ativa' : 'Inativa'}
                              </Badge>
                              <span className="text-xs text-slate-500">
                                {port.speedMbps ? `${port.speedMbps} Mbps` : '—'}
                              </span>
                              <div className="flex justify-end">
                                <button
                                  onClick={() => powerCyclePort(d, port.idx)}
                                  disabled={pendingPort === port.idx}
                                  className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[11.5px] font-semibold text-slate-700 disabled:opacity-50"
                                >
                                  {pendingPort === port.idx ? 'Executando…' : 'Power cycle'}
                                </button>
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          ))}

        {!loading && devices.length === 0 && (
          <div className="px-5 py-8 text-center text-sm text-slate-400">Nenhum dispositivo encontrado.</div>
        )}
      </div>

      {pagination && (
        <div className="mt-4 flex items-center justify-between">
          <span className="text-[12.5px] text-slate-500">
            {pagination.total === 0
              ? 'Nenhum dispositivo'
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
