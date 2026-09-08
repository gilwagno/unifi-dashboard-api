import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '../components/Badge';
import { Layout } from '../components/Layout';
import { usePolling } from '../hooks/usePolling';
import { api, ApiError, type Pagination, type UniFiClient } from '../lib/api';

const PAGE_SIZE = 8;
const POLL_INTERVAL_MS = 60_000;

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

  const [fixedIpMac, setFixedIpMac] = useState<string | null>(null);
  const [fixedIpDraft, setFixedIpDraft] = useState('');
  const [pendingFixedIpMac, setPendingFixedIpMac] = useState<string | null>(null);

  // Contador monotônico de requisições de listagem: só a resposta da requisição MAIS RECENTE
  // é aplicada ao estado. Sem isso, um refresh silencioso do polling que já estava em voo
  // quando o usuário troca de página/filtro resolve depois da carga nova e reverte a lista
  // (e o rótulo de paginação) pro estado anterior — errada até o próximo ciclo de 60s. Também
  // descarta respostas que chegam depois do unmount (usuário navegou pra outra tela).
  const requestSeqRef = useRef(0);

  // `silent = true` é usado pelo polling em segundo plano: recarrega a MESMA página que o
  // usuário está vendo (não reseta `page`) e nunca ativa `loading` — senão a lista inteira
  // pisca "Carregando…" a cada minuto. Se o refresh silencioso falhar (ex.: controller fora do
  // ar nesse ciclo), só loga no console e mantém os dados antigos na tela — substituir a lista
  // por uma mensagem de erro a cada minuto seria pior do que simplesmente tentar de novo no
  // próximo ciclo.
  const load = useCallback(
    (silent = false) => {
      if (!silent) {
        setLoading(true);
        setError(null);
      }
      const seq = (requestSeqRef.current += 1);
      api
        .listClients({
          page,
          pageSize: PAGE_SIZE,
          type: typeFilter,
          blocked: blockedFilter === 'ALL' ? undefined : blockedFilter === 'BLOCKED',
        })
        .then((res) => {
          // Só a resposta mais recente escreve no estado. `loading`/`error` seguem
          // desguardados de propósito: quem ligou o `loading` foi uma ação do usuário e
          // precisa poder desligá-lo mesmo se sua resposta chegou atrasada, senão a tela
          // trava em "Carregando…" quando um tick do polling passa no meio.
          if (seq !== requestSeqRef.current) return;
          setClients(res.data);
          setPagination(res.pagination);
        })
        .catch((err) => {
          if (silent) {
            console.error('Falha ao atualizar clientes em segundo plano', err);
            return;
          }
          setError(err instanceof Error ? err.message : 'Erro ao carregar clientes');
        })
        .finally(() => {
          if (!silent) setLoading(false);
        });
    },
    [page, typeFilter, blockedFilter],
  );

  useEffect(() => {
    load();
  }, [load]);

  // Pausa o polling enquanto o editor inline de IP fixo está aberto: ele é renderizado DENTRO
  // da linha do cliente (`key={c.id}`), então um refresh que remova aquele cliente da página
  // atual (cliente que saiu da rede, ou a fronteira da paginação deslocando com PAGE_SIZE=8)
  // desmonta o editor e joga fora o IP que o usuário estava digitando, sem nenhuma explicação
  // na tela. Mesma proteção que Printers.tsx já aplica ao formulário de cadastro.
  usePolling(() => load(true), POLL_INTERVAL_MS, { enabled: fixedIpMac === null });

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

  function startFixedIp(client: UniFiClient) {
    setFixedIpMac(client.macAddress);
    setFixedIpDraft(client.ipAddress ?? '');
  }

  async function submitFixedIp(client: UniFiClient) {
    const ipv4 = /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
    if (!ipv4.test(fixedIpDraft)) {
      setError('Informe um IPv4 válido para o IP fixo');
      return;
    }
    setPendingFixedIpMac(client.macAddress);
    setError(null);
    try {
      await api.setClientFixedIp(client.macAddress, { enabled: true, ip: fixedIpDraft });
      setFixedIpMac(null);
      setFixedIpDraft('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao definir o IP fixo');
    } finally {
      setPendingFixedIpMac(null);
    }
  }

  async function removeFixedIp(client: UniFiClient) {
    if (!confirm(`Remover o IP fixo de "${client.name ?? client.hostname ?? client.macAddress}"?`)) return;
    setPendingFixedIpMac(client.macAddress);
    setError(null);
    try {
      await api.setClientFixedIp(client.macAddress, { enabled: false });
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao remover o IP fixo');
    } finally {
      setPendingFixedIpMac(null);
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
        <div className="grid grid-cols-[2fr_1.5fr_1.2fr_0.8fr_1.2fr_2.1fr] bg-slate-50 px-5 py-2.75 text-[11px] font-bold uppercase tracking-wide text-slate-500">
          <span>Cliente</span>
          <span>MAC</span>
          <span>IP</span>
          <span>Tipo</span>
          <span>Status</span>
          <span className="text-right">Ações</span>
        </div>

        {loading && <div className="px-5 py-8 text-center text-sm text-slate-400">Carregando…</div>}

        {!loading &&
          clients.map((c) => (
            <div key={c.id} className="border-t border-slate-100">
              <div className="grid grid-cols-[2fr_1.5fr_1.2fr_0.8fr_1.2fr_2.1fr] items-center px-5 py-3">
                <span className="truncate text-[13px] font-semibold text-slate-800">{c.name ?? c.hostname ?? 'Sem nome'}</span>
                <span className="font-mono text-xs text-slate-500">{c.macAddress}</span>
                <span className="font-mono text-xs text-slate-500">{c.ipAddress ?? '—'}</span>
                <span className="text-xs text-slate-600">{c.type === 'WIRED' ? 'Cabo' : 'Wi-Fi'}</span>
                <Badge tone={c.blocked ? 'danger' : 'success'}>{c.blocked ? 'Bloqueado' : 'Ativo'}</Badge>
                <div className="flex justify-end gap-2">
                  <button
                    onClick={() => startFixedIp(c)}
                    disabled={pendingFixedIpMac === c.macAddress}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[11.5px] font-semibold text-slate-700 disabled:opacity-50"
                  >
                    IP fixo
                  </button>
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

              {fixedIpMac === c.macAddress && (
                <div className="flex items-center gap-2 border-t border-slate-100 bg-slate-50 px-5 py-3">
                  <span className="text-[12px] text-slate-500">
                    Reserva de DHCP para este cliente (o controller sempre atribui este IP a ele):
                  </span>
                  <input
                    autoFocus
                    type="text"
                    value={fixedIpDraft}
                    onChange={(e) => setFixedIpDraft(e.target.value)}
                    placeholder="172.16.0.50"
                    className="w-36 rounded-md border border-slate-300 px-2 py-1 font-mono text-xs"
                  />
                  <button
                    onClick={() => submitFixedIp(c)}
                    disabled={pendingFixedIpMac === c.macAddress}
                    className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[11.5px] font-semibold text-slate-700 disabled:opacity-50"
                  >
                    Ativar IP fixo
                  </button>
                  <button
                    onClick={() => removeFixedIp(c)}
                    disabled={pendingFixedIpMac === c.macAddress}
                    className="rounded-md border border-[oklch(87%_0.06_25)] bg-white px-3 py-1.5 text-[11.5px] font-semibold text-[oklch(48%_0.16_25)] disabled:opacity-50"
                  >
                    Remover IP fixo
                  </button>
                  <button
                    onClick={() => setFixedIpMac(null)}
                    className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[11.5px] font-semibold text-slate-500"
                  >
                    Fechar
                  </button>
                </div>
              )}
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
