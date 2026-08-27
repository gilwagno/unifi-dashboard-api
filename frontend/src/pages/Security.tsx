import { AlertTriangle, KeyRound, ShieldAlert, ShieldCheck, UserCog } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Badge } from '../components/Badge';
import { Layout } from '../components/Layout';
import { StatCard } from '../components/StatCard';
import { api, type Admin, type AdminRole, type CriticalEvent, type SecuritySummary, type SshInfo } from '../lib/api';

// O formato exato de cada evento crítico não é conhecido (o endpoint
// /security/events nunca teve um evento real pra observar no ambiente de
// teste) — tenta achar campos comuns (msg/message/key/type) e cai pra um
// JSON resumido quando nenhum existe, no mesmo espírito de Events.tsx.
function summarizeEvent(ev: CriticalEvent): string {
  const candidate = ev.msg ?? ev.message ?? ev.key ?? ev.type;
  if (typeof candidate === 'string') return candidate;
  return JSON.stringify(ev).slice(0, 160);
}

function summarizePermissions(role: AdminRole): string {
  const perms = role.permissions;
  if (Array.isArray(perms)) return perms.join(', ');
  if (typeof perms === 'string') return perms;
  if (perms) return JSON.stringify(perms);
  return '—';
}

export function Security() {
  const [summary, setSummary] = useState<SecuritySummary | null>(null);
  const [events, setEvents] = useState<CriticalEvent[] | null>(null);
  const [admins, setAdmins] = useState<Admin[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const [sshInfo, setSshInfo] = useState<SshInfo | null>(null);
  const [sshError, setSshError] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  // Guardada SÓ no estado deste componente (nunca em localStorage/sessionStorage
  // nem em nenhum lugar persistente) — some ao trocar de página ou recarregar,
  // igual ao aviso mostrado na tela.
  const [newPassword, setNewPassword] = useState<{ username: string; password: string } | null>(null);

  function loadSshInfo() {
    api
      .getSshInfo()
      .then(setSshInfo)
      .catch((err) => setSshError(err instanceof Error ? err.message : 'Erro ao carregar credencial SSH'));
  }

  useEffect(() => {
    Promise.all([api.getSecuritySummary(), api.getSecurityEvents(), api.getAdmins()])
      .then(([s, e, a]) => {
        setSummary(s);
        setEvents(e.data);
        setAdmins(a.data);
      })
      .catch((err) => setError(err instanceof Error ? err.message : 'Erro ao carregar dados de segurança'));

    loadSshInfo();
  }, []);

  async function handleRotateSsh() {
    const confirmed = window.confirm(
      'Isso vai trocar a senha de SSH em TODOS os APs/switches adotados deste site de uma vez só. ' +
        'A senha nova vai aparecer nesta tela UMA ÚNICA VEZ — depois de sair daqui não tem como recuperá-la ' +
        '(só trocando de novo). Copie e guarde num lugar seguro assim que aparecer. Continuar?',
    );
    if (!confirmed) return;

    setSshError(null);
    setRotating(true);
    try {
      const result = await api.rotateSshCredentials();
      setNewPassword({ username: result.sshUsername, password: result.sshPassword });
      loadSshInfo();
    } catch (err) {
      setSshError(err instanceof Error ? err.message : 'Erro ao trocar a senha de SSH');
    } finally {
      setRotating(false);
    }
  }

  return (
    <Layout title="Segurança">
      {error && (
        <div className="mb-5 rounded-lg border border-[oklch(88%_0.06_25)] bg-[oklch(97%_0.03_25)] px-4 py-3 text-sm text-[oklch(40%_0.15_25)]">
          {error}
        </div>
      )}

      <div className="mb-5.5 grid grid-cols-3 gap-4">
        <StatCard
          label="Ameaças detectadas (24h)"
          value={summary ? summary.threatsDetected : '—'}
          trend={summary ? `${summary.signaturesActive} assinaturas ativas` : undefined}
          trendTone={summary && summary.threatsDetected > 0 ? 'danger' : 'success'}
          icon={<ShieldAlert className="h-3.5 w-3.5 text-[oklch(55%_0.18_25)]" strokeWidth={2} />}
          iconBg="oklch(95% 0.05 25 / 0.5)"
        />
        <StatCard
          label="IPS/Threat Management"
          value={summary ? (summary.ipsEnabled ? 'Ativo' : 'Inativo') : '—'}
          trendTone={summary?.ipsEnabled ? 'success' : 'danger'}
          icon={<ShieldCheck className="h-3.5 w-3.5 text-[oklch(50%_0.13_150)]" strokeWidth={2} />}
          iconBg="oklch(94% 0.05 150 / 0.5)"
        />
        <StatCard
          label="Dispositivos com firmware desatualizado"
          value={summary ? summary.upgradableDeviceCount : '—'}
          trendTone={summary && summary.upgradableDeviceCount > 0 ? 'danger' : 'success'}
          icon={<AlertTriangle className="h-3.5 w-3.5 text-accent" strokeWidth={2} />}
          iconBg="oklch(95% 0.03 255 / 0.6)"
        />
      </div>

      <div className="grid grid-cols-[1.3fr_1fr] items-start gap-4">
        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center justify-between border-b border-slate-100 px-5 py-4">
            <span className="text-[13.5px] font-bold text-slate-900">Eventos críticos</span>
          </div>
          <div>
            {events?.map((ev, i) => (
              <div key={i} className="flex items-start gap-3.5 border-t border-slate-50 px-5 py-3.5 first:border-t-0">
                <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[oklch(55%_0.18_25)]" />
                <span className="text-[13px] text-slate-700">{summarizeEvent(ev)}</span>
              </div>
            ))}
            {events?.length === 0 && (
              <div className="px-5 py-10 text-center text-sm text-slate-400">Nenhum evento crítico no momento.</div>
            )}
            {events === null && !error && (
              <div className="px-5 py-10 text-center text-sm text-slate-400">Carregando…</div>
            )}
          </div>
        </div>

        <div className="overflow-hidden rounded-xl border border-slate-200 bg-white">
          <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4">
            <UserCog className="h-4 w-4 text-slate-500" strokeWidth={2} />
            <span className="text-[13.5px] font-bold text-slate-900">Administradores</span>
          </div>
          <div>
            {admins?.map((admin, i) => (
              <div key={i} className="flex flex-col gap-1.5 border-t border-slate-50 px-5 py-3.5 first:border-t-0">
                <div className="flex flex-col">
                  <span className="text-[13px] font-semibold text-slate-800">{admin.name ?? admin.email ?? 'Admin'}</span>
                  {admin.email && admin.name && (
                    <span className="text-[11.5px] text-slate-500">{admin.email}</span>
                  )}
                </div>
                <div className="flex flex-wrap gap-1.5">
                  {admin.roles?.length ? (
                    admin.roles.map((role, j) => (
                      <Badge key={j} tone="neutral">
                        {(role.site_name ?? 'site')}: {role.role ?? '—'}
                        {role.permissions ? ` (${summarizePermissions(role)})` : ''}
                      </Badge>
                    ))
                  ) : (
                    <span className="text-[11.5px] text-slate-400">Sem papéis informados</span>
                  )}
                </div>
              </div>
            ))}
            {admins?.length === 0 && (
              <div className="px-5 py-10 text-center text-sm text-slate-400">Nenhum administrador encontrado.</div>
            )}
            {admins === null && !error && (
              <div className="px-5 py-10 text-center text-sm text-slate-400">Carregando…</div>
            )}
          </div>
        </div>
      </div>

      <div className="mt-4 overflow-hidden rounded-xl border border-slate-200 bg-white">
        <div className="flex items-center gap-2 border-b border-slate-100 px-5 py-4">
          <KeyRound className="h-4 w-4 text-slate-500" strokeWidth={2} />
          <span className="text-[13.5px] font-bold text-slate-900">Credencial SSH dos equipamentos</span>
        </div>

        <div className="px-5 py-4">
          <p className="mb-3 text-[12.5px] text-slate-500">
            Credencial ÚNICA por site — se aplica a TODOS os APs/switches adotados deste site de uma vez. Não existe
            senha de SSH separada por dispositivo no UniFi.
          </p>

          {sshError && (
            <div className="mb-3 rounded-lg border border-[oklch(88%_0.06_25)] bg-[oklch(97%_0.03_25)] px-4 py-3 text-sm text-[oklch(40%_0.15_25)]">
              {sshError}
            </div>
          )}

          {sshInfo === null && !sshError && <div className="py-6 text-center text-sm text-slate-400">Carregando…</div>}

          {sshInfo && (
            <div className="flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-col gap-1.5">
                <span className="text-[13px] text-slate-700">
                  Usuário atual: <span className="font-mono font-semibold text-slate-900">{sshInfo.sshUsername || '—'}</span>
                </span>
                <div className="flex gap-1.5">
                  <Badge tone={sshInfo.sshEnabled ? 'success' : 'neutral'}>
                    SSH {sshInfo.sshEnabled ? 'habilitado' : 'desabilitado'}
                  </Badge>
                  <Badge tone={sshInfo.passwordAuthEnabled ? 'success' : 'neutral'}>
                    Autenticação por senha {sshInfo.passwordAuthEnabled ? 'ativa' : 'inativa'}
                  </Badge>
                </div>
              </div>

              <button
                type="button"
                onClick={handleRotateSsh}
                disabled={rotating}
                className="rounded-lg bg-slate-900 px-4 py-2 text-[13px] font-semibold text-white transition hover:bg-slate-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {rotating ? 'Gerando…' : 'Gerar nova senha'}
              </button>
            </div>
          )}

          {newPassword && (
            <div className="mt-4 rounded-lg border border-[oklch(85%_0.12_90)] bg-[oklch(97%_0.06_90)] px-4 py-3.5">
              <div className="mb-2 text-[12.5px] font-bold text-[oklch(40%_0.12_90)]">
                Copie agora — essa senha não vai aparecer de novo.
              </div>
              <div className="flex flex-col gap-1 font-mono text-[13px] text-slate-900">
                <div>
                  usuário: <span className="font-semibold">{newPassword.username}</span>
                </div>
                <div className="break-all">
                  senha: <span className="font-semibold">{newPassword.password}</span>
                </div>
              </div>
              <div className="mt-2 text-[11.5px] text-[oklch(45%_0.1_90)]">
                Essa senha não é guardada por este dashboard — se você sair desta página sem copiá-la, a única forma
                de recuperar o acesso é gerar outra senha nova.
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="mt-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-2.5 text-[12.5px] text-slate-500">
        Log de login de administrador não é suportado nesta versão do controller — nenhum endpoint confiável foi
        encontrado para isso.
      </div>
    </Layout>
  );
}
