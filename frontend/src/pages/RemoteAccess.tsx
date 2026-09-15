import { AlertTriangle, Monitor, MonitorPlay, RefreshCw, Search, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Badge } from '../components/Badge';
import { Layout } from '../components/Layout';
import { StatCard } from '../components/StatCard';
import { usePolling } from '../hooks/usePolling';
import { ApiError, api, type RemoteAccessComputer, type RemoteSession } from '../lib/api';

const POLL_INTERVAL_MS = 60_000;

// ────────────────────────────────────────────────────────────────────────
// ONDE O TOKEN DA SESSÃO VIVE — e por que isto é aceitável
// ────────────────────────────────────────────────────────────────────────
// A URL devolvida por `openRemoteSession` carrega, na query string, o token
// da conta Guacamole DA PESSOA. O navegador É o cliente do Guacamole, então
// o token precisa chegar até ele; a pergunta honesta não é "como esconder",
// é "onde ele pode parar e quem o alcança".
//
//   - NÃO é o token do usuário de serviço. Isso foi medido, não suposto: o
//     token do serviço carrega CREATE_CONNECTION, e entregá-lo ao navegador
//     seria escalação de privilégio. O token daqui não tem permissão de
//     sistema nenhuma e dá READ em UMA conexão — é a credencial da própria
//     pessoa, para um acesso que ela já tem. Vê-lo no DevTools dela não lhe
//     concede nada de novo.
//   - NUNCA vai para `window.location`: iria parar no histórico do
//     navegador, que sobrevive à sessão e é compartilhado com quem usar
//     aquele perfil depois. Por isso é `src` de um iframe, não navegação.
//   - NUNCA é persistido: nada de localStorage/sessionStorage. Vive só no
//     estado do React e some no `encerrarSessao` e no unmount.
//   - NUNCA é logado nem colocado em texto visível na tela.
//   - É buscado no CLIQUE, nunca em lote junto da lista: cada chamada emite
//     um token e grava uma linha de auditoria.
//
// O que tiraria o token do DOM de vez é um proxy reverso same-origin que
// injetasse a autenticação do lado do servidor — infraestrutura própria,
// fora do escopo desta onda. Registrado como a saída, não como pendência
// esquecida.

function seloAcesso(computer: RemoteAccessComputer) {
  if (computer.activeSessions > 0) {
    return (
      <Badge tone="warning">
        {computer.activeSessions === 1 ? 'Sessão ativa' : `${computer.activeSessions} sessões ativas`}
      </Badge>
    );
  }
  if (computer.hasAccess) return <Badge tone="success">Disponível</Badge>;
  return <Badge tone="neutral">Sem acesso configurado</Badge>;
}

export function RemoteAccess() {
  const [computers, setComputers] = useState<RemoteAccessComputer[]>([]);
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [busca, setBusca] = useState('');
  const [sincronizando, setSincronizando] = useState(false);
  const [abrindo, setAbrindo] = useState<string | null>(null);
  const [sessao, setSessao] = useState<RemoteSession | null>(null);

  // Contador monotônico de requisição: só a resposta MAIS RECENTE escreve no
  // estado. Sem isso, um refresh de 60s em voo no momento em que a pessoa
  // sincroniza pode responder depois e repintar a tela com o retrato antigo
  // — a mesma corrida já corrigida em 4 páginas na Onda 2.
  const requisicaoAtual = useRef(0);

  const carregar = useCallback(async (silencioso = false) => {
    const id = ++requisicaoAtual.current;
    if (!silencioso) setCarregando(true);
    try {
      const { data } = await api.listRemoteAccessComputers();
      if (id !== requisicaoAtual.current) return;
      setComputers(data);
      setErro(null);
    } catch (err) {
      if (id !== requisicaoAtual.current) return;
      // Ciclo silencioso que falha mantém o dado antigo na tela em vez de
      // apagá-lo — padrão de polling do projeto.
      if (!silencioso) setErro(err instanceof ApiError ? err.message : 'Falha ao carregar computadores');
    } finally {
      if (id === requisicaoAtual.current && !silencioso) setCarregando(false);
    }
  }, []);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  // O polling para enquanto há sessão aberta: recarregar a lista por baixo de
  // uma sessão em andamento não traz informação nova e só gera ruído.
  usePolling(() => void carregar(true), POLL_INTERVAL_MS, { enabled: sessao === null });

  async function sincronizar() {
    setSincronizando(true);
    setErro(null);
    try {
      const { resumo } = await api.syncRemoteAccess();
      setAviso(
        `Sincronizado: ${resumo.criadas} criada(s), ${resumo.atualizadas} atualizada(s), ` +
          `${resumo.removidas} removida(s), ${resumo.inalteradas} sem mudança.`,
      );
      await carregar(true);
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : 'Falha ao sincronizar');
    } finally {
      setSincronizando(false);
    }
  }

  async function abrirSessao(computer: RemoteAccessComputer) {
    if (!computer.objectGuid) return;
    setAbrindo(computer.objectGuid);
    setErro(null);
    try {
      const nova = await api.openRemoteSession(computer.objectGuid);
      setSessao(nova);
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : 'Falha ao abrir a sessão');
    } finally {
      setAbrindo(null);
    }
  }

  function encerrarSessao() {
    // Descarta a URL (e com ela o token) do estado. O iframe é desmontado
    // junto, então nada do token permanece no DOM.
    setSessao(null);
    void carregar(true);
  }

  const filtrados = computers.filter((c) => {
    const alvo = `${c.name} ${c.dnsHostName ?? ''} ${c.operatingSystem ?? ''}`.toLowerCase();
    return alvo.includes(busca.trim().toLowerCase());
  });

  const comAcesso = computers.filter((c) => c.hasAccess).length;
  const sessoesAtivas = computers.reduce((total, c) => total + c.activeSessions, 0);

  if (sessao) {
    return (
      <Layout title="Acesso Remoto">
        {/* Aviso de sessão ativa: acesso à tela de outra máquina não pode ser
            discreto. Fica no topo, colorido, com o nome da máquina e a conta
            usada — e o botão de encerrar sempre visível. */}
        <div
          role="alert"
          className="mb-4 flex flex-wrap items-center justify-between gap-3 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3"
        >
          <div className="flex items-center gap-2 text-sm text-amber-900">
            <MonitorPlay size={18} />
            <span>
              <strong>Sessão remota ativa</strong> em <strong>{sessao.connectionName}</strong> — você está vendo e
              controlando a tela desta máquina. Acesso registrado em auditoria como{' '}
              <code className="rounded bg-amber-100 px-1">{sessao.guacamoleUser}</code>.
            </span>
          </div>
          <button
            type="button"
            onClick={encerrarSessao}
            className="flex items-center gap-1.5 rounded-md bg-amber-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-amber-800"
          >
            <X size={15} />
            Encerrar sessão
          </button>
        </div>

        <iframe
          // A URL carrega o token da pessoa — ver a nota no topo do arquivo.
          // É `src` de iframe (e não navegação) justamente para não entrar no
          // histórico do navegador.
          src={sessao.url}
          title={`Sessão remota em ${sessao.connectionName}`}
          className="h-[70vh] w-full rounded-lg border border-slate-300 bg-slate-900"
        />
      </Layout>
    );
  }

  return (
    <Layout title="Acesso Remoto">
      <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-4">
        <StatCard
          label="Computadores"
          value={String(computers.length)}
          icon={<Monitor className="h-3.5 w-3.5 text-accent" strokeWidth={2} />}
          iconBg="oklch(95% 0.03 255 / 0.6)"
        />
        <StatCard
          label="Com acesso"
          value={String(comAcesso)}
          icon={<MonitorPlay className="h-3.5 w-3.5 text-[oklch(50%_0.13_150)]" strokeWidth={2} />}
          iconBg="oklch(94% 0.05 150 / 0.5)"
        />
        <StatCard
          label="Sessões ativas"
          value={String(sessoesAtivas)}
          trend={sessoesAtivas > 0 ? 'alguém está vendo a tela de uma máquina agora' : undefined}
          trendTone={sessoesAtivas > 0 ? 'danger' : undefined}
          icon={<MonitorPlay className="h-3.5 w-3.5 text-[oklch(50%_0.13_80)]" strokeWidth={2} />}
          iconBg="oklch(95% 0.08 80 / 0.6)"
        />
        <StatCard
          label="Sem acesso"
          value={String(computers.length - comAcesso)}
          icon={<AlertTriangle className="h-3.5 w-3.5 text-[oklch(50%_0.13_80)]" strokeWidth={2} />}
          iconBg="oklch(95% 0.08 80 / 0.6)"
        />
      </div>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[200px]">
          <Search size={15} className="absolute left-2.5 top-2.5 text-slate-400" />
          <input
            type="search"
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar computador"
            aria-label="Buscar computador"
            className="w-full rounded-md border border-slate-300 py-1.5 pl-8 pr-3 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={sincronizar}
          disabled={sincronizando}
          className="flex items-center gap-1.5 rounded-md border border-slate-300 px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
        >
          <RefreshCw size={15} className={sincronizando ? 'animate-spin' : undefined} />
          {sincronizando ? 'Sincronizando…' : 'Sincronizar com o AD'}
        </button>
      </div>

      {erro && (
        <div role="alert" className="mb-4 rounded-md border border-red-300 bg-red-50 px-3 py-2 text-sm text-red-800">
          {erro}
        </div>
      )}
      {aviso && (
        <div role="status" className="mb-4 rounded-md border border-slate-300 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          {aviso}
        </div>
      )}

      {carregando ? (
        <p className="text-sm text-slate-500">Carregando…</p>
      ) : filtrados.length === 0 ? (
        <p className="text-sm text-slate-500">Nenhum computador encontrado.</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {filtrados.map((computer) => (
            <li key={computer.objectGuid ?? computer.name} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm font-medium text-slate-900">{computer.name}</p>
                <p className="truncate text-xs text-slate-500">
                  {computer.dnsHostName ?? 'sem FQDN'}
                  {computer.operatingSystem ? ` · ${computer.operatingSystem}` : ''}
                </p>
              </div>
              {seloAcesso(computer)}
              <button
                type="button"
                onClick={() => void abrirSessao(computer)}
                disabled={!computer.hasAccess || abrindo !== null}
                title={
                  computer.hasAccess
                    ? undefined
                    : 'Sem conexão no Guacamole para este computador — sincronize com o AD.'
                }
                className="rounded-md bg-slate-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {abrindo === computer.objectGuid ? 'Abrindo…' : 'Abrir sessão'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </Layout>
  );
}
