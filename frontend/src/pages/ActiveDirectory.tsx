import { AlertTriangle, KeyRound, Lock, Monitor, Search, ShieldAlert, Users as UsersIcon } from 'lucide-react';
import { useCallback, useEffect, useState } from 'react';
import { Badge } from '../components/Badge';
import { Layout } from '../components/Layout';
import { StatCard } from '../components/StatCard';
import { usePolling } from '../hooks/usePolling';
import { ApiError, api, type AdComputer, type AdGroup, type AdUser } from '../lib/api';

const POLL_INTERVAL_MS = 60_000;

type Aba = 'usuarios' | 'grupos' | 'computadores';

// Os três estados de `enabled`/`isDomainController` que vêm do backend são
// TRÊS, não dois. `null` significa "não foi possível ler o
// userAccountControl deste objeto" — não "desabilitado". O backend recusa
// escrever nesse caso justamente para não afirmar o que não sabe; se a tela
// colapsasse `null` em "desabilitado" (ou pior, em "ativo"), desfaria essa
// honestidade no último metro, que é onde a pessoa decide.
function seloAtivo(enabled: boolean | null) {
  if (enabled === null) return <Badge tone="warning">Não foi possível ler</Badge>;
  return enabled ? <Badge tone="success">Ativa</Badge> : <Badge tone="neutral">Desabilitada</Badge>;
}

export function ActiveDirectory() {
  const [aba, setAba] = useState<Aba>('usuarios');

  return (
    <Layout title="Active Directory">
      <div className="mb-5 flex gap-1 border-b border-slate-200">
        {(
          [
            ['usuarios', 'Usuários', UsersIcon],
            ['grupos', 'Grupos', ShieldAlert],
            ['computadores', 'Computadores', Monitor],
          ] as const
        ).map(([id, label, Icon]) => (
          <button
            key={id}
            type="button"
            onClick={() => setAba(id)}
            className={`-mb-px flex items-center gap-1.5 border-b-2 px-3.5 py-2 text-sm font-medium ${
              aba === id
                ? 'border-slate-900 text-slate-900'
                : 'border-transparent text-slate-500 hover:text-slate-700'
            }`}
          >
            <Icon size={15} />
            {label}
          </button>
        ))}
      </div>

      {aba === 'usuarios' && <AbaUsuarios />}
      {aba === 'grupos' && <AbaGrupos />}
      {aba === 'computadores' && <AbaComputadores />}
    </Layout>
  );
}

// --- Usuários -------------------------------------------------------------

function AbaUsuarios() {
  const [usuarios, setUsuarios] = useState<AdUser[]>([]);
  const [busca, setBusca] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const carregar = useCallback(
    async (silencioso = false) => {
      if (!silencioso) setCarregando(true);
      try {
        const { data } = await api.listAdUsers(busca.trim() || undefined);
        setUsuarios(data);
        setErro(null);
      } catch (err) {
        if (silencioso) return;
        setErro(err instanceof ApiError ? err.message : 'Falha ao consultar o Active Directory');
      } finally {
        if (!silencioso) setCarregando(false);
      }
    },
    [busca],
  );

  useEffect(() => {
    void carregar();
  }, [carregar]);

  usePolling(() => void carregar(true), POLL_INTERVAL_MS);

  async function acao(username: string, fn: () => Promise<unknown>, mensagem: string) {
    setOcupado(username);
    setErro(null);
    setAviso(null);
    try {
      await fn();
      setAviso(mensagem);
      await carregar(true);
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : 'Falha na operação');
    } finally {
      setOcupado(null);
    }
  }

  const ilegiveis = usuarios.filter((u) => u.enabled === null).length;

  return (
    <>
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Usuários listados"
          value={String(usuarios.length)}
          icon={<UsersIcon className="h-3.5 w-3.5 text-accent" strokeWidth={2} />}
          iconBg="oklch(95% 0.03 255 / 0.6)"
        />
        <StatCard
          label="Bloqueados"
          value={String(usuarios.filter((u) => u.lockedOut).length)}
          icon={<Lock className="h-3.5 w-3.5 text-[oklch(55%_0.18_25)]" strokeWidth={2} />}
          iconBg="oklch(95% 0.05 25 / 0.5)"
        />
        <StatCard
          label="Estado ilegível"
          value={String(ilegiveis)}
          trend={ilegiveis > 0 ? 'userAccountControl não pôde ser lido' : undefined}
          trendTone={ilegiveis > 0 ? 'danger' : undefined}
          icon={<AlertTriangle className="h-3.5 w-3.5 text-[oklch(50%_0.13_80)]" strokeWidth={2} />}
          iconBg="oklch(95% 0.08 80 / 0.6)"
        />
      </div>

      <CampoBusca valor={busca} onChange={setBusca} placeholder="Buscar por nome, login ou e-mail…" />

      {erro && (
        <p role="alert" className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {erro}
        </p>
      )}
      {aviso && (
        <p role="status" className="mb-3 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">
          {aviso}
        </p>
      )}

      {carregando ? (
        <p className="text-sm text-slate-500">Carregando…</p>
      ) : usuarios.length === 0 ? (
        <p className="text-sm text-slate-500">Nenhum usuário encontrado.</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {usuarios.map((u) => (
            <li key={u.dn} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-48 flex-1">
                <p className="text-sm font-medium text-slate-900">{u.displayName ?? u.sAMAccountName}</p>
                <p className="text-xs text-slate-500">
                  {u.sAMAccountName}
                  {u.department ? ` · ${u.department}` : ''}
                  {u.mail ? ` · ${u.mail}` : ''}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {seloAtivo(u.enabled)}
                {u.lockedOut && <Badge tone="danger">Bloqueada</Badge>}
              </div>
              <div className="flex gap-2">
                {u.lockedOut && (
                  <button
                    type="button"
                    disabled={ocupado === u.sAMAccountName}
                    onClick={() =>
                      void acao(
                        u.sAMAccountName,
                        () => api.unlockAdUser(u.sAMAccountName),
                        `Conta de ${u.sAMAccountName} desbloqueada.`,
                      )
                    }
                    className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                  >
                    Desbloquear
                  </button>
                )}
                {/* `enabled === null` desabilita a ação de propósito: o backend
                    recusaria a escrita (não conseguiu ler o estado atual), e um
                    botão que só existe para dar erro é pior que nenhum botão. */}
                <button
                  type="button"
                  disabled={ocupado === u.sAMAccountName || u.enabled === null}
                  title={u.enabled === null ? 'Estado da conta não pôde ser lido — ação indisponível' : undefined}
                  onClick={() =>
                    void acao(
                      u.sAMAccountName,
                      () => api.setAdUserEnabled(u.sAMAccountName, !u.enabled),
                      `Conta de ${u.sAMAccountName} ${u.enabled ? 'desabilitada' : 'habilitada'}.`,
                    )
                  }
                  className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
                >
                  {u.enabled ? 'Desabilitar' : 'Habilitar'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// --- Grupos ---------------------------------------------------------------

function AbaGrupos() {
  const [busca, setBusca] = useState('');
  const [grupos, setGrupos] = useState<AdGroup[]>([]);
  const [detalhe, setDetalhe] = useState<AdGroup | null>(null);
  const [buscando, setBuscando] = useState(false);
  const [erro, setErro] = useState<string | null>(null);

  // A busca NUNCA dispara sozinha com o campo vazio. `searchGroups()` sem
  // filtro devolve o domínio inteiro — 68 grupos no domínio real, incluindo
  // `Admins. do domínio`, `Administradores de esquema` e todo o
  // `CN=Builtin`. Não há paginação no backend. Uma tela que lista tudo por
  // padrão despeja a estrutura de privilégios do domínio numa página só.
  async function buscar() {
    const termo = busca.trim();
    // Cinto e suspensório: hoje o botão já fica desabilitado sem termo, e
    // um Enter no campo não submete o formulário justamente porque não há
    // botão de submit habilitado — então esta linha é INALCANÇÁVEL pela UI
    // atual, e um mutante que a remova sobrevive. Registrada como tal, em
    // vez de "coberta" por um teste que passaria de qualquer jeito. Ela
    // existe porque a consequência de perder a guarda não é um bug de
    // tela: é despejar a estrutura de privilégios do domínio inteiro.
    if (!termo) return;
    setBuscando(true);
    setErro(null);
    try {
      const { data } = await api.listAdGroups(termo);
      setGrupos(data);
      setDetalhe(null);
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : 'Falha ao buscar grupos');
    } finally {
      setBuscando(false);
    }
  }

  async function abrir(nome: string) {
    setErro(null);
    try {
      setDetalhe(await api.getAdGroup(nome));
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : 'Falha ao abrir o grupo');
    }
  }

  return (
    <>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void buscar();
        }}
        className="mb-4 flex gap-2"
      >
        <div className="relative flex-1">
          <Search size={15} className="absolute top-2.5 left-3 text-slate-400" />
          <input
            value={busca}
            onChange={(e) => setBusca(e.target.value)}
            placeholder="Buscar grupo por nome ou descrição…"
            aria-label="Buscar grupo"
            className="w-full rounded-md border border-slate-300 py-2 pr-3 pl-9 text-sm"
          />
        </div>
        <button
          type="submit"
          disabled={!busca.trim() || buscando}
          className="rounded-md bg-slate-900 px-4 py-2 text-sm font-medium text-white disabled:opacity-40"
        >
          Buscar
        </button>
      </form>

      <p className="mb-4 text-xs text-slate-500">
        A busca exige um termo de propósito: sem filtro, o diretório devolve todos os grupos do domínio, inclusive os
        administrativos.
      </p>

      {erro && (
        <p role="alert" className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {erro}
        </p>
      )}

      {grupos.length > 0 && (
        <ul className="mb-5 divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {grupos.map((g) => (
            <li key={g.dn} className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="text-sm font-medium text-slate-900">{g.cn}</p>
                <p className="text-xs text-slate-500">{g.description ?? g.dn}</p>
              </div>
              <button
                type="button"
                onClick={() => void abrir(g.cn)}
                className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
              >
                Ver membros
              </button>
            </li>
          ))}
        </ul>
      )}

      {detalhe && <DetalheGrupo grupo={detalhe} />}
    </>
  );
}

// O componente que carrega o peso desta tela.
//
// Um membro que é OUTRO GRUPO traz gente por HERANÇA — e essa gente não pode
// ser removida pela membership direta: o dashboard manda remover, o AD
// responde sucesso, e a pessoa continua com acesso. Foi medido no domínio
// real em 2026-09-14: 69 pessoas com acesso à rede, das quais o dashboard
// revogaria 8. Se esta tela mostrasse "12 membros" numa lista uniforme, o
// bug de produção seguiria existindo na prática mesmo com o backend
// corrigido — o operador continuaria achando que revogou.
function DetalheGrupo({ grupo }: { grupo: AdGroup }) {
  const membros = grupo.memberDetails ?? [];
  const aninhados = membros.filter((m) => m.type === 'group');
  const diretos = membros.filter((m) => m.type === 'user');
  const naoResolvidos = membros.filter((m) => m.type === 'unknown');

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h2 className="text-sm font-semibold text-slate-900">{grupo.cn}</h2>
      <p className="mb-3 text-xs text-slate-500">{grupo.dn}</p>

      {aninhados.length > 0 && (
        <div role="alert" className="mb-4 rounded-md border border-amber-300 bg-amber-50 px-3 py-2.5">
          <p className="flex items-center gap-1.5 text-sm font-semibold text-amber-900">
            <AlertTriangle size={15} />
            {aninhados.length === 1 ? 'Este grupo contém 1 grupo' : `Este grupo contém ${aninhados.length} grupos`}
          </p>
          <p className="mt-1 text-xs text-amber-900">
            Quem pertence a {aninhados.length === 1 ? 'ele' : 'eles'} herda o acesso e{' '}
            <strong>não aparece na lista abaixo</strong>. Remover um membro daqui não revoga esse acesso herdado — a
            operação retorna sucesso e a pessoa continua com acesso. Para revogar, é preciso removê-la do grupo de
            origem.
          </p>
        </div>
      )}

      {membros.length === 0 ? (
        <p className="text-sm text-slate-500">Este grupo não tem membros diretos.</p>
      ) : (
        <ul className="divide-y divide-slate-100">
          {membros.map((m) => (
            <li key={m.dn} className="flex items-center gap-2 py-2">
              <span className="flex-1 text-sm text-slate-800">{m.name}</span>
              {m.type === 'group' && <Badge tone="warning">Grupo · acesso herdado</Badge>}
              {m.type === 'user' && <Badge tone="neutral">Membro direto</Badge>}
              {m.type === 'unknown' && <Badge tone="danger">Não resolvido</Badge>}
            </li>
          ))}
        </ul>
      )}

      <p className="mt-3 text-xs text-slate-500">
        {diretos.length} membro(s) direto(s) · {aninhados.length} grupo(s) aninhado(s)
        {naoResolvidos.length > 0 && ` · ${naoResolvidos.length} não resolvido(s)`}
      </p>
    </section>
  );
}

// --- Computadores ---------------------------------------------------------

function AbaComputadores() {
  const [computadores, setComputadores] = useState<AdComputer[]>([]);
  const [busca, setBusca] = useState('');
  const [carregando, setCarregando] = useState(true);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const carregar = useCallback(
    async (silencioso = false) => {
      if (!silencioso) setCarregando(true);
      try {
        const { data } = await api.listAdComputers(busca.trim() || undefined);
        setComputadores(data);
        setErro(null);
      } catch (err) {
        if (silencioso) return;
        setErro(err instanceof ApiError ? err.message : 'Falha ao consultar o Active Directory');
      } finally {
        if (!silencioso) setCarregando(false);
      }
    },
    [busca],
  );

  useEffect(() => {
    void carregar();
  }, [carregar]);

  usePolling(() => void carregar(true), POLL_INTERVAL_MS);

  async function alternar(c: AdComputer) {
    // Desabilitar a conta quebra o canal seguro da máquina com o domínio —
    // não é o mesmo que desligar o computador, e reverter costuma exigir
    // reingressar a máquina. A confirmação é distinta da de "reconectar" de
    // rede justamente por isso.
    const alvo = !c.enabled;
    if (!alvo) {
      const extra = c.isDomainController
        ? '\n\nATENÇÃO: este é um CONTROLADOR DE DOMÍNIO. Desabilitar a conta dele derruba o domínio inteiro.'
        : '';
      const ok = window.confirm(
        `Desabilitar a conta de "${c.name}" no domínio?\n\nIsso quebra o canal seguro entre a máquina e o domínio: logons novos com credencial de domínio param, e reverter costuma exigir reingressar a máquina no domínio.${extra}`,
      );
      if (!ok) return;
    }

    setOcupado(c.name);
    setErro(null);
    setAviso(null);
    try {
      await api.setAdComputerEnabled(c.name, alvo);
      setAviso(`Conta de ${c.name} ${alvo ? 'habilitada' : 'desabilitada'}.`);
      await carregar(true);
    } catch (err) {
      setErro(err instanceof ApiError ? err.message : 'Falha na operação');
    } finally {
      setOcupado(null);
    }
  }

  const dcs = computadores.filter((c) => c.isDomainController === true).length;

  return (
    <>
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard
          label="Computadores"
          value={String(computadores.length)}
          icon={<Monitor className="h-3.5 w-3.5 text-accent" strokeWidth={2} />}
          iconBg="oklch(95% 0.03 255 / 0.6)"
        />
        <StatCard
          label="Contas desabilitadas"
          value={String(computadores.filter((c) => c.enabled === false).length)}
          icon={<Lock className="h-3.5 w-3.5 text-[oklch(55%_0.18_25)]" strokeWidth={2} />}
          iconBg="oklch(95% 0.05 25 / 0.5)"
        />
        <StatCard
          label="Controladores de domínio"
          value={String(dcs)}
          trend={dcs > 0 ? 'desabilitar a conta derruba o domínio' : undefined}
          trendTone={dcs > 0 ? 'danger' : undefined}
          icon={<KeyRound className="h-3.5 w-3.5 text-[oklch(50%_0.13_80)]" strokeWidth={2} />}
          iconBg="oklch(95% 0.08 80 / 0.6)"
        />
      </div>

      <CampoBusca valor={busca} onChange={setBusca} placeholder="Buscar por nome, DNS ou descrição…" />

      {erro && (
        <p role="alert" className="mb-3 rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {erro}
        </p>
      )}
      {aviso && (
        <p role="status" className="mb-3 rounded-md bg-slate-100 px-3 py-2 text-sm text-slate-700">
          {aviso}
        </p>
      )}

      {carregando ? (
        <p className="text-sm text-slate-500">Carregando…</p>
      ) : computadores.length === 0 ? (
        <p className="text-sm text-slate-500">Nenhum computador encontrado.</p>
      ) : (
        <ul className="divide-y divide-slate-200 rounded-lg border border-slate-200 bg-white">
          {computadores.map((c) => (
            <li key={c.dn} className="flex flex-wrap items-center gap-3 px-4 py-3">
              <div className="min-w-48 flex-1">
                <p className="flex items-center gap-2 text-sm font-medium text-slate-900">
                  {c.name}
                  {c.isDomainController === true && <Badge tone="danger">Controlador de domínio</Badge>}
                </p>
                <p className="text-xs text-slate-500">
                  {c.operatingSystem ?? 'Sistema desconhecido'}
                  {c.dnsHostName ? ` · ${c.dnsHostName}` : ''}
                </p>
              </div>
              {seloAtivo(c.enabled)}
              <button
                type="button"
                disabled={ocupado === c.name || c.enabled === null}
                title={c.enabled === null ? 'Estado da conta não pôde ser lido — ação indisponível' : undefined}
                onClick={() => void alternar(c)}
                className="rounded-md border border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              >
                {c.enabled ? 'Desabilitar conta' : 'Habilitar conta'}
              </button>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}

// --- comum ----------------------------------------------------------------

function CampoBusca({
  valor,
  onChange,
  placeholder,
}: {
  valor: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <div className="relative mb-4">
      <Search size={15} className="absolute top-2.5 left-3 text-slate-400" />
      <input
        value={valor}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={placeholder}
        className="w-full rounded-md border border-slate-300 py-2 pr-3 pl-9 text-sm"
      />
    </div>
  );
}
