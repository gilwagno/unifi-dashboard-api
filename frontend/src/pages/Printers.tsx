import { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Pencil, Power, Printer as PrinterIcon, RefreshCw, Trash2 } from 'lucide-react';
import { Badge } from '../components/Badge';
import { Layout } from '../components/Layout';
import { usePolling } from '../hooks/usePolling';
import {
  api,
  ApiError,
  type ConsumableSupplyStatus,
  type CreatePrinterBody,
  type PrinterConsumablesResponse,
  type PrinterSnmpInput,
  type PrinterSnmpVersion,
  type PrinterWbmCredentialsInput,
  type PrinterWithNetwork,
  type UpdatePrinterBody,
} from '../lib/api';

const POLL_INTERVAL_MS = 60_000;

// Rótulo/tom/explicação de cada status de suprimento (ver
// resolveSupplyStatus em src/routes/printers.routes.ts — os status além de
// 'ok'/'low' não são erro de UI, são estados legítimos vindos do SNMP/RFC
// 3805, por isso ganham um tom neutro com texto explicando o motivo em vez
// de parecer uma falha do dashboard).
const SUPPLY_STATUS_INFO: Record<ConsumableSupplyStatus, { label: string; tone: 'success' | 'danger' | 'neutral'; hint: string }> = {
  ok: { label: 'OK', tone: 'success', hint: 'Nível dentro do esperado.' },
  low: { label: 'Baixo', tone: 'danger', hint: 'Abaixo do limite configurado para esta impressora.' },
  unknown: { label: 'Desconhecido', tone: 'neutral', hint: 'O valor não pôde ser determinado via SNMP neste modelo.' },
  'not-measured': {
    label: 'Sem medição',
    tone: 'neutral',
    hint: 'Valor lido, mas não foi possível calcular um percentual confiável.',
  },
  partial: {
    label: 'Parcial',
    tone: 'neutral',
    hint: 'Ainda há suprimento, mas a quantidade exata não é reportada por este modelo.',
  },
  unsupported: { label: 'Não suportado', tone: 'neutral', hint: 'Este modelo não expõe esse dado via SNMP.' },
  error: { label: 'Erro de leitura', tone: 'neutral', hint: 'Falha pontual ao ler este campo — tente novamente mais tarde.' },
};

function networkBadge(printer: PrinterWithNetwork) {
  const { network } = printer;
  if (network.source === 'integration') {
    return (
      <Badge tone="success">Online · {network.ipAddress ?? 'IP desconhecido'} ({network.connectionType ?? '—'})</Badge>
    );
  }
  if (network.source === 'classic') {
    return (
      <Badge tone="neutral">
        Conhecida pelo controller · {network.ipAddress ?? 'IP desconhecido'} (online desconhecido)
      </Badge>
    );
  }
  return <Badge tone="neutral">Status de rede desconhecido</Badge>;
}

interface FormState {
  name: string;
  mac: string;
  ipOverride: string;
  snmpVersion: PrinterSnmpVersion;
  community: string;
  v3Username: string;
  v3AuthProtocol: 'MD5' | 'SHA' | '';
  v3AuthPassword: string;
  v3PrivProtocol: 'DES' | 'AES' | '';
  v3PrivPassword: string;
  wbmUsername: string;
  wbmPassword: string;
  intervalDays: string;
  intervalPages: string;
  consumableLowThresholdPct: string;
}

const EMPTY_FORM: FormState = {
  name: '',
  mac: '',
  ipOverride: '',
  snmpVersion: 'v2c',
  community: '',
  v3Username: '',
  v3AuthProtocol: '',
  v3AuthPassword: '',
  v3PrivProtocol: '',
  v3PrivPassword: '',
  wbmUsername: '',
  wbmPassword: '',
  intervalDays: '',
  intervalPages: '',
  consumableLowThresholdPct: '',
};

function toMaintenance(form: FormState) {
  const maintenance: { intervalDays?: number; intervalPages?: number; consumableLowThresholdPct?: number } = {};
  if (form.intervalDays.trim()) maintenance.intervalDays = Number(form.intervalDays);
  if (form.intervalPages.trim()) maintenance.intervalPages = Number(form.intervalPages);
  if (form.consumableLowThresholdPct.trim()) maintenance.consumableLowThresholdPct = Number(form.consumableLowThresholdPct);
  return Object.keys(maintenance).length > 0 ? maintenance : undefined;
}

// Só monta o bloco `snmp` quando o usuário de fato digitou um segredo novo —
// em edição, deixar em branco significa "manter o atual" (o backend nunca
// devolve o segredo pra popular o formulário de volta, então não há como
// reenviar o valor existente; omitir o campo é o único jeito correto).
function toSnmpInput(form: FormState): PrinterSnmpInput | undefined {
  if (form.snmpVersion === 'v3') {
    const hasV3Secret = Boolean(
      form.v3Username.trim() || form.v3AuthPassword.trim() || form.v3PrivPassword.trim(),
    );
    if (!hasV3Secret) return undefined;
    return {
      version: 'v3',
      v3Auth: {
        username: form.v3Username.trim(),
        authProtocol: form.v3AuthProtocol || undefined,
        authPassword: form.v3AuthPassword.trim() || undefined,
        privProtocol: form.v3PrivProtocol || undefined,
        privPassword: form.v3PrivPassword.trim() || undefined,
      },
    };
  }
  if (!form.community.trim()) return undefined;
  return { version: form.snmpVersion, community: form.community.trim() };
}

// Credencial do painel web: mesma disciplina do segredo SNMP — o backend
// nunca a devolve, então o formulário nunca a repopula, e deixar AMBOS os
// campos em branco na edição significa "manter a atual". Atenção: preencher
// só o usuário NÃO é "manter a senha" — grava senha vazia (ver a confirmação
// explícita no submit, achado do crítico).
//
// O gatilho é o USUÁRIO estar preenchido, não a senha: a HP real do
// Financeiro está com a senha de fábrica EM BRANCO (o backend aceita
// `password: ''` de propósito), então exigir senha digitada impediria de
// cadastrar exatamente a impressora que motivou a feature. A senha não passa
// por `.trim()` — ao contrário de nome/IP, um espaço pode fazer parte dela.
function toWbmCredentials(form: FormState): PrinterWbmCredentialsInput | undefined {
  if (!form.wbmUsername.trim()) return undefined;
  return { username: form.wbmUsername.trim(), password: form.wbmPassword };
}

// Senha do painel digitada sem usuário: sem isto, o `toWbmCredentials` acima
// descartaria a senha em silêncio e a tela reportaria sucesso sem ter salvo
// nada.
function wbmFormError(form: FormState): string | null {
  if (form.wbmPassword && !form.wbmUsername.trim()) {
    return 'Informe o usuário do painel web junto da senha (ou deixe os dois em branco).';
  }
  return null;
}

// Validações que espelham o que o backend REALMENTE exige, para transformar
// um 400 confuso do zod numa mensagem de campo legível:
//
// 1. `v3AuthSchema.username` é `z.string().min(1)` — OBRIGATÓRIO (ver
//    printers.routes.ts). Os demais campos v3 (authProtocol/authPassword/
//    privProtocol/privPassword) são todos `.optional()`, então não são
//    validados aqui de propósito: quem decide o que o dispositivo exige é o
//    poller, não esta tela. Como `toSnmpInput` monta o bloco v3 quando
//    QUALQUER um dos três campos de segredo foi preenchido, preencher só a
//    senha de autenticação enviaria `username: ''` e levaria um 400.
// 2. Trocar a versão de SNMP exige reenviar o segredo: o backend só grava
//    `snmpVersion` junto de `snmpSecret` (o PATCH omite os dois quando
//    `snmp` é omitido). Sem esta checagem, mudar o select de v2c para v3 e
//    salvar sem digitar nada retornaria 200 sem ter mudado nada — um
//    no-op silencioso que a tela reportaria como sucesso.
function snmpFormError(form: FormState, currentVersion: PrinterSnmpVersion | null): string | null {
  if (form.snmpVersion === 'v3') {
    const typedAnyV3Secret = Boolean(
      form.v3Username.trim() || form.v3AuthPassword.trim() || form.v3PrivPassword.trim(),
    );
    if (typedAnyV3Secret && !form.v3Username.trim()) {
      return 'O usuário SNMPv3 é obrigatório quando qualquer credencial v3 é informada.';
    }
  }
  if (currentVersion !== null && form.snmpVersion !== currentVersion && !toSnmpInput(form)) {
    return `Para mudar a versão de SNMP de ${currentVersion} para ${form.snmpVersion} é preciso informar o segredo correspondente novamente.`;
  }
  return null;
}

export function Printers() {
  const [printers, setPrinters] = useState<PrinterWithNetwork[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Confirmação de ação assíncrona sem retorno visível na lista (o reboot não
  // muda nenhum campo do cadastro), separada de `error` para não colorir um
  // sucesso de vermelho.
  const [notice, setNotice] = useState<string | null>(null);

  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [consumables, setConsumables] = useState<Record<string, PrinterConsumablesResponse>>({});
  const [consumablesLoading, setConsumablesLoading] = useState<Record<string, boolean>>({});
  const [consumablesError, setConsumablesError] = useState<Record<string, string>>({});

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<FormState>(EMPTY_FORM);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [pendingId, setPendingId] = useState<string | null>(null);

  const [aliasEditingId, setAliasEditingId] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState('');
  const [aliasSubmitting, setAliasSubmitting] = useState(false);

  const requestSeqRef = useRef(0);

  // `silent = true` (polling em segundo plano) nunca reseta `printers` pra `null` — é esse
  // `null` que a tela usa como sinal de "carregando". Falha silenciosa só loga no console e
  // mantém a lista antiga na tela, em vez de trocar por uma mensagem de erro a cada ciclo.
  const load = useCallback((silent = false) => {
    const seq = (requestSeqRef.current += 1);
    api
      .listPrinters()
      .then((data) => {
        // Só a resposta mais recente escreve no estado: o polling fica desligado enquanto o
        // formulário está aberto, mas NÃO durante remover/reconectar (que usam `confirm`), e
        // nessas ações um refresh silencioso em voo pode resolver depois do `load()` da
        // mutação e ressuscitar na tela a impressora que acabou de ser removida.
        if (seq !== requestSeqRef.current) return;
        setPrinters(data);
      })
      .catch((err) => {
        if (silent) {
          console.error('Falha ao atualizar impressoras em segundo plano', err);
          return;
        }
        setError(err instanceof Error ? err.message : 'Erro ao carregar impressoras');
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Enquanto o formulário de cadastro/edição está aberto OU a edição de apelido está em
  // andamento, desliga o polling desta página. O estado do formulário/apelido é tecnicamente
  // separado da lista (`printers`), então um refresh em segundo plano não afetaria os campos
  // preenchidos — mas evita qualquer risco de a lista trocar de posição/tamanho embaixo do
  // usuário no meio de um cadastro, o que seria confuso mesmo sem quebrar nada.
  usePolling(() => load(true), POLL_INTERVAL_MS, { enabled: !showForm && aliasEditingId === null });

  function resetForm() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setFormError(null);
    setShowForm(false);
  }

  function startCreate() {
    setForm(EMPTY_FORM);
    setEditingId(null);
    setFormError(null);
    setShowForm(true);
  }

  function startEdit(printer: PrinterWithNetwork) {
    setForm({
      name: printer.name,
      mac: printer.mac,
      ipOverride: printer.ipOverride ?? '',
      snmpVersion: printer.snmpVersion,
      // Segredo NUNCA vem do backend — campos ficam vazios de propósito.
      community: '',
      v3Username: '',
      v3AuthProtocol: '',
      v3AuthPassword: '',
      v3PrivProtocol: '',
      v3PrivPassword: '',
      // Credencial do painel web também nunca vem do backend.
      wbmUsername: '',
      wbmPassword: '',
      intervalDays: printer.maintenance.intervalDays !== null ? String(printer.maintenance.intervalDays) : '',
      intervalPages: printer.maintenance.intervalPages !== null ? String(printer.maintenance.intervalPages) : '',
      consumableLowThresholdPct:
        printer.maintenance.consumableLowThresholdPct !== null ? String(printer.maintenance.consumableLowThresholdPct) : '',
    });
    setEditingId(printer.id);
    setFormError(null);
    setShowForm(true);
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setFormError(null);

    const currentVersion = editingId ? printers?.find((p) => p.id === editingId)?.snmpVersion ?? null : null;
    const snmpError = snmpFormError(form, currentVersion);
    if (snmpError) {
      setFormError(snmpError);
      return;
    }

    const wbmError = wbmFormError(form);
    if (wbmError) {
      setFormError(wbmError);
      return;
    }

    // ACHADO DO CRÍTICO — sobrescrita SILENCIOSA da senha do painel na EDIÇÃO.
    // `toWbmCredentials` dispara com o USUÁRIO preenchido e manda
    // `password: ''` quando o campo de senha está em branco. Isso é o
    // comportamento certo no cadastro (a HP real tem senha de fábrica em
    // branco), mas na edição é destrutivo: quem preenche só o usuário — para
    // trocar `admin` por `operador`, por exemplo — APAGA a senha guardada sem
    // nenhum aviso. E como a credencial nunca é devolvida em leitura, não há
    // como perceber: o cadastro continua "com credencial", e a falha só
    // aparece depois, como um 403 no reboot.
    //
    // Não dá para simplesmente proibir (senha em branco é um caso legítimo
    // desta impressora), nem para distinguir no backend (`''` é um valor
    // válido). Então confirmamos de forma explícita, mesmo padrão dos outros
    // atos destrutivos desta tela (remover/reiniciar).
    if (editingId && form.wbmUsername.trim() && form.wbmPassword === '') {
      const confirmed = window.confirm(
        'Salvar a credencial do painel web com a SENHA EM BRANCO?\n\n' +
          'O campo de senha está vazio, e isso GRAVA uma senha vazia — a senha que estiver salva hoje ' +
          'é perdida. Se o painel desta impressora tem senha, o reinício remoto passa a falhar.\n\n' +
          'Para manter a credencial atual intacta, cancele e deixe TAMBÉM o campo de usuário em branco.',
      );
      if (!confirmed) return;
    }

    if (editingId) {
      const body: UpdatePrinterBody = {
        name: form.name,
        mac: form.mac,
        ipOverride: form.ipOverride.trim() || null,
        snmp: toSnmpInput(form),
        wbmCredentials: toWbmCredentials(form),
        maintenance: toMaintenance(form),
      };
      setSubmitting(true);
      try {
        await api.updatePrinter(editingId, body);
        resetForm();
        load();
      } catch (err) {
        setFormError(err instanceof ApiError ? err.message : 'Falha ao atualizar impressora');
      } finally {
        setSubmitting(false);
      }
      return;
    }

    const snmp = toSnmpInput(form);
    if (!snmp) {
      setFormError(
        form.snmpVersion === 'v3'
          ? 'Informe ao menos o usuário SNMPv3'
          : 'Informe a community SNMP',
      );
      return;
    }
    const body: CreatePrinterBody = {
      name: form.name,
      mac: form.mac,
      ipOverride: form.ipOverride.trim() || undefined,
      snmp,
      wbmCredentials: toWbmCredentials(form),
      maintenance: toMaintenance(form),
    };
    setSubmitting(true);
    try {
      await api.createPrinter(body);
      resetForm();
      load();
    } catch (err) {
      setFormError(err instanceof ApiError ? err.message : 'Falha ao cadastrar impressora');
    } finally {
      setSubmitting(false);
    }
  }

  async function handleDelete(printer: PrinterWithNetwork) {
    if (!window.confirm(`Remover a impressora "${printer.name}" do cadastro? Isso não afeta o equipamento físico.`)) return;
    setPendingId(printer.id);
    setError(null);
    try {
      await api.deletePrinter(printer.id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao remover impressora');
    } finally {
      setPendingId(null);
    }
  }

  async function handleReconnect(printer: PrinterWithNetwork) {
    const confirmed = window.confirm(
      `Reconectar "${printer.name}" à rede? Isso bloqueia e desbloqueia o cliente no controller UniFi para forçar ` +
        'uma nova associação. NÃO reinicia nem desliga o equipamento — é só uma reconexão de rede.',
    );
    if (!confirmed) return;
    setPendingId(printer.id);
    setError(null);
    try {
      await api.reconnectPrinter(printer.id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao reconectar impressora');
    } finally {
      setPendingId(null);
    }
  }

  // REINICIA O EQUIPAMENTO FÍSICO — o texto do confirm precisa deixar isso
  // óbvio, porque o botão vizinho ("Reconectar") parece parecido e NÃO
  // reinicia nada. Um clique errado aqui derruba a impressora do Financeiro
  // no meio de uma impressão.
  async function handleReboot(printer: PrinterWithNetwork) {
    const confirmed = window.confirm(
      `ATENÇÃO: reiniciar de verdade a impressora "${printer.name}"?\n\n` +
        'Isto REINICIA O EQUIPAMENTO FÍSICO (o firmware da impressora), pelo painel web dela. ' +
        'Qualquer impressão em andamento é perdida e a impressora fica indisponível por alguns minutos.\n\n' +
        'Não é a mesma coisa que "Reconectar", que só refaz a conexão de rede sem desligar nada.',
    );
    if (!confirmed) return;
    setPendingId(printer.id);
    setError(null);
    setNotice(null);
    try {
      const result = await api.rebootPrinter(printer.id);
      // Mostra o alvo REAL da ação: com `ipOrigin: 'classic'` o endereço veio
      // do histórico do controller e pode, em teoria, pertencer a outro
      // dispositivo hoje (mesmo alerta que o backend registra no log).
      setNotice(
        `Comando de reinício enviado para "${printer.name}" em ${result.ipAddress} (origem do IP: ${result.ipOrigin}).`,
      );
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao reiniciar impressora');
    } finally {
      setPendingId(null);
    }
  }

  async function toggleConsumables(printer: PrinterWithNetwork) {
    if (expandedId === printer.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(printer.id);
    if (consumables[printer.id]) return; // já buscado — não refaz a requisição
    setConsumablesLoading((prev) => ({ ...prev, [printer.id]: true }));
    setConsumablesError((prev) => {
      const next = { ...prev };
      delete next[printer.id];
      return next;
    });
    try {
      const data = await api.getPrinterConsumables(printer.id);
      setConsumables((prev) => ({ ...prev, [printer.id]: data }));
    } catch (err) {
      setConsumablesError((prev) => ({
        ...prev,
        [printer.id]: err instanceof Error ? err.message : 'Falha ao carregar consumíveis',
      }));
    } finally {
      setConsumablesLoading((prev) => ({ ...prev, [printer.id]: false }));
    }
  }

  function startAliasEdit(printer: PrinterWithNetwork) {
    setAliasEditingId(printer.id);
    setAliasDraft(printer.name);
  }

  async function submitAlias(printer: PrinterWithNetwork) {
    if (!aliasDraft.trim()) return;
    setAliasSubmitting(true);
    setError(null);
    try {
      await api.setClientAlias(printer.mac, aliasDraft.trim());
      setAliasEditingId(null);
      setAliasDraft('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao renomear apelido no UniFi');
    } finally {
      setAliasSubmitting(false);
    }
  }

  return (
    <Layout title="Manutenção">
      {error && (
        <div className="mb-4 rounded-lg border border-[oklch(88%_0.06_25)] bg-[oklch(97%_0.03_25)] px-4 py-3 text-sm text-[oklch(40%_0.15_25)]">
          {error}
        </div>
      )}

      {notice && (
        <div className="mb-4 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3 text-sm text-slate-700">
          {notice}
        </div>
      )}

      <div className="mb-3 flex items-center justify-between">
        <span className="text-[13.5px] font-bold text-slate-900">Impressoras cadastradas</span>
        {!showForm && (
          <button
            type="button"
            onClick={startCreate}
            className="rounded-md bg-accent px-3.5 py-1.75 text-[12.5px] font-semibold text-white"
          >
            Nova impressora
          </button>
        )}
      </div>

      {showForm && (
        <form
          onSubmit={handleSubmit}
          className="mb-4 flex flex-col gap-3 rounded-xl border border-slate-200 bg-white p-4"
        >
          <div className="flex flex-wrap items-end gap-2.5">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-slate-500">Nome</label>
              <input
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                required
                maxLength={64}
                className="rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px]"
                placeholder="ex: HPLaserMFP135w"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-slate-500">MAC</label>
              <input
                value={form.mac}
                onChange={(e) => setForm((f) => ({ ...f, mac: e.target.value }))}
                required
                className="rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-[13px]"
                placeholder="aa:bb:cc:dd:ee:ff"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-slate-500">IP fixo (opcional)</label>
              <input
                value={form.ipOverride}
                onChange={(e) => setForm((f) => ({ ...f, ipOverride: e.target.value }))}
                className="rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-[13px]"
                placeholder="172.16.0.89"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-slate-500">Versão SNMP</label>
              <select
                value={form.snmpVersion}
                onChange={(e) => setForm((f) => ({ ...f, snmpVersion: e.target.value as PrinterSnmpVersion }))}
                className="w-28 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[13px]"
              >
                <option value="v1">v1</option>
                <option value="v2c">v2c</option>
                <option value="v3">v3</option>
              </select>
            </div>
          </div>

          {form.snmpVersion !== 'v3' ? (
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-slate-500">
                Community SNMP {editingId ? '(deixe em branco para manter a atual)' : ''}
              </label>
              <input
                value={form.community}
                onChange={(e) => setForm((f) => ({ ...f, community: e.target.value }))}
                type="password"
                autoComplete="off"
                className="w-64 rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px]"
                placeholder={editingId ? 'deixe em branco para manter a atual' : 'ex: public'}
              />
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-2.5">
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-semibold text-slate-500">
                  Usuário SNMPv3 {editingId ? '(deixe em branco para manter o atual)' : ''}
                </label>
                <input
                  value={form.v3Username}
                  onChange={(e) => setForm((f) => ({ ...f, v3Username: e.target.value }))}
                  autoComplete="off"
                  className="rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px]"
                  placeholder={editingId ? 'deixe em branco para manter o atual' : 'usuário'}
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-semibold text-slate-500">Protocolo de autenticação</label>
                <select
                  value={form.v3AuthProtocol}
                  onChange={(e) => setForm((f) => ({ ...f, v3AuthProtocol: e.target.value as FormState['v3AuthProtocol'] }))}
                  className="w-32 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[13px]"
                >
                  <option value="">nenhum</option>
                  <option value="MD5">MD5</option>
                  <option value="SHA">SHA</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-semibold text-slate-500">Senha de autenticação</label>
                <input
                  value={form.v3AuthPassword}
                  onChange={(e) => setForm((f) => ({ ...f, v3AuthPassword: e.target.value }))}
                  type="password"
                  autoComplete="off"
                  className="rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px]"
                />
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-semibold text-slate-500">Protocolo de privacidade</label>
                <select
                  value={form.v3PrivProtocol}
                  onChange={(e) => setForm((f) => ({ ...f, v3PrivProtocol: e.target.value as FormState['v3PrivProtocol'] }))}
                  className="w-32 rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-[13px]"
                >
                  <option value="">nenhum</option>
                  <option value="DES">DES</option>
                  <option value="AES">AES</option>
                </select>
              </div>
              <div className="flex flex-col gap-1">
                <label className="text-[11px] font-semibold text-slate-500">Senha de privacidade</label>
                <input
                  value={form.v3PrivPassword}
                  onChange={(e) => setForm((f) => ({ ...f, v3PrivPassword: e.target.value }))}
                  type="password"
                  autoComplete="off"
                  className="rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px]"
                />
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-end gap-2.5">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-slate-500">Intervalo de manutenção (dias)</label>
              <input
                value={form.intervalDays}
                onChange={(e) => setForm((f) => ({ ...f, intervalDays: e.target.value }))}
                type="number"
                min={1}
                className="w-32 rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px]"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-slate-500">Intervalo de manutenção (páginas)</label>
              <input
                value={form.intervalPages}
                onChange={(e) => setForm((f) => ({ ...f, intervalPages: e.target.value }))}
                type="number"
                min={1}
                className="w-36 rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px]"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-slate-500">Limite de suprimento baixo (%)</label>
              <input
                value={form.consumableLowThresholdPct}
                onChange={(e) => setForm((f) => ({ ...f, consumableLowThresholdPct: e.target.value }))}
                type="number"
                min={0}
                max={100}
                className="w-32 rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px]"
              />
            </div>
          </div>

          <div className="flex flex-wrap items-end gap-2.5">
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-slate-500">
                Usuário do painel web (opcional) {editingId ? '(em branco = manter atual)' : ''}
              </label>
              <input
                value={form.wbmUsername}
                onChange={(e) => setForm((f) => ({ ...f, wbmUsername: e.target.value }))}
                autoComplete="off"
                maxLength={64}
                className="rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px]"
                placeholder={editingId ? 'deixe em branco para manter o atual' : 'ex: admin'}
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-[11px] font-semibold text-slate-500">Senha do painel web (opcional)</label>
              <input
                value={form.wbmPassword}
                onChange={(e) => setForm((f) => ({ ...f, wbmPassword: e.target.value }))}
                type="password"
                autoComplete="off"
                maxLength={128}
                className="rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px]"
                aria-label="Senha do painel web"
              />
            </div>
            <span className="max-w-72 text-[10.5px] text-slate-400">
              Credencial de administrador do painel da própria impressora (WBM/SWS) — necessária para
              reiniciá-la remotamente. Nunca é exibida de volta depois de salva.
            </span>
          </div>

          {formError && <div className="text-[12.5px] text-[oklch(45%_0.18_25)]">{formError}</div>}

          <div className="flex gap-2">
            <button
              type="submit"
              disabled={submitting}
              className="rounded-md bg-accent px-3.5 py-1.75 text-[12.5px] font-semibold text-white disabled:opacity-50"
            >
              {submitting ? 'Salvando…' : editingId ? 'Salvar alterações' : 'Cadastrar impressora'}
            </button>
            <button
              type="button"
              onClick={resetForm}
              className="rounded-md border border-slate-200 bg-white px-3.5 py-1.75 text-[12.5px] font-semibold text-slate-500"
            >
              Cancelar
            </button>
          </div>
        </form>
      )}

      {printers === null && !error && <div className="px-5 py-8 text-center text-sm text-slate-400">Carregando…</div>}

      {printers?.length === 0 && (
        <div className="rounded-xl border border-slate-200 bg-white px-5 py-10 text-center text-sm text-slate-400">
          Nenhuma impressora cadastrada.
        </div>
      )}

      <div className="flex flex-col gap-3">
        {printers?.map((printer) => {
          const isExpanded = expandedId === printer.id;
          const c = consumables[printer.id];
          const cLoading = consumablesLoading[printer.id];
          const cError = consumablesError[printer.id];

          return (
            <div key={printer.id} className="overflow-hidden rounded-xl border border-slate-200 bg-white">
              <div className="flex flex-wrap items-center justify-between gap-3 px-5 py-4">
                <div className="flex items-center gap-3">
                  <PrinterIcon className="h-4.5 w-4.5 text-slate-500" strokeWidth={2} />
                  <div className="flex flex-col">
                    <span className="text-[13.5px] font-bold text-slate-900">{printer.name}</span>
                    <span className="font-mono text-[11.5px] text-slate-500">{printer.mac}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">{networkBadge(printer)}</div>

                <div className="flex items-center gap-1.5">
                  <button
                    type="button"
                    onClick={() => toggleConsumables(printer)}
                    className="flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[11.5px] font-semibold text-slate-700"
                  >
                    Ver consumíveis
                    {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => handleReconnect(printer)}
                    disabled={pendingId === printer.id}
                    title="Reconexão de REDE (bloqueia e desbloqueia o cliente no controller) — não reinicia o equipamento."
                    className="flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[11.5px] font-semibold text-slate-700 disabled:opacity-50"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Reconectar
                  </button>
                  <button
                    type="button"
                    onClick={() => handleReboot(printer)}
                    disabled={pendingId === printer.id}
                    title="REINICIA o equipamento físico pelo painel web da impressora — diferente de Reconectar."
                    className="flex items-center gap-1 rounded-md border border-[oklch(87%_0.06_25)] bg-white px-3 py-1.5 text-[11.5px] font-semibold text-[oklch(48%_0.16_25)] disabled:opacity-50"
                  >
                    <Power className="h-3.5 w-3.5" />
                    Reiniciar remotamente
                  </button>
                  <button
                    type="button"
                    onClick={() => startEdit(printer)}
                    className="flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[11.5px] font-semibold text-slate-700"
                  >
                    <Pencil className="h-3.5 w-3.5" />
                    Editar
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(printer)}
                    disabled={pendingId === printer.id}
                    className="flex items-center gap-1 rounded-md border border-[oklch(87%_0.06_25)] bg-white px-3 py-1.5 text-[11.5px] font-semibold text-[oklch(48%_0.16_25)] disabled:opacity-50"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                    Remover
                  </button>
                </div>
              </div>

              <div className="flex items-center gap-2 border-t border-slate-50 px-5 py-2.5">
                <span className="text-[11.5px] font-semibold text-slate-500">Apelido no UniFi:</span>
                {aliasEditingId === printer.id ? (
                  <>
                    <input
                      autoFocus
                      value={aliasDraft}
                      onChange={(e) => setAliasDraft(e.target.value)}
                      maxLength={128}
                      className="w-48 rounded-md border border-slate-300 px-2 py-1 text-xs"
                    />
                    <button
                      onClick={() => submitAlias(printer)}
                      disabled={aliasSubmitting}
                      className="rounded-md border border-slate-300 bg-white px-2.5 py-1 text-[11.5px] font-semibold text-slate-700 disabled:opacity-50"
                    >
                      Salvar
                    </button>
                    <button
                      onClick={() => setAliasEditingId(null)}
                      className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11.5px] font-semibold text-slate-500"
                    >
                      Cancelar
                    </button>
                  </>
                ) : (
                  <button
                    onClick={() => startAliasEdit(printer)}
                    title="Renomeia o Apelido exibido no painel do UniFi — diferente do nome deste cadastro local."
                    className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11.5px] font-semibold text-slate-600"
                  >
                    Renomear apelido no UniFi
                  </button>
                )}
              </div>

              {isExpanded && (
                <div className="border-t border-slate-100 bg-slate-50 px-5 py-4">
                  {cLoading && <div className="text-[12.5px] text-slate-400">Carregando consumíveis…</div>}
                  {cError && <div className="text-[12.5px] text-[oklch(45%_0.18_25)]">{cError}</div>}
                  {c && !cLoading && !cError && (
                    <>
                      <div className="mb-2 flex flex-wrap gap-4 text-[11.5px] text-slate-500">
                        <span>Coletado em: {c.collectedAt ?? 'nunca coletado'}</span>
                        <span>Contador de páginas: {c.pageCount ?? '—'}</span>
                        <span>Limite de "baixo": {c.lowThresholdPct !== null ? `${c.lowThresholdPct}%` : 'não configurado'}</span>
                      </div>
                      {c.supplies.length === 0 && (
                        <div className="text-[12.5px] text-slate-400">Nenhum suprimento coletado ainda.</div>
                      )}
                      <div className="flex flex-col gap-2">
                        {c.supplies.map((supply, i) => {
                          const info = SUPPLY_STATUS_INFO[supply.status];
                          return (
                            <div key={i} className="flex items-center justify-between gap-3 rounded-lg bg-white px-3.5 py-2.5">
                              <span className="text-[13px] font-semibold text-slate-800">{supply.name}</span>
                              <div className="flex flex-1 items-center gap-2">
                                <div className="h-2 flex-1 overflow-hidden rounded-full bg-slate-100">
                                  {supply.levelPercent !== null && (
                                    <div
                                      className="h-full rounded-full bg-accent"
                                      style={{ width: `${Math.max(0, Math.min(100, supply.levelPercent))}%` }}
                                    />
                                  )}
                                </div>
                                <span className="w-12 text-right font-mono text-[11.5px] text-slate-500">
                                  {supply.levelPercent !== null ? `${supply.levelPercent}%` : 'sem dado'}
                                </span>
                              </div>
                              <div className="flex flex-col items-end gap-0.5">
                                <Badge tone={info.tone}>{info.label}</Badge>
                                {info.tone === 'neutral' && (
                                  <span className="max-w-52 text-right text-[10.5px] text-slate-400">{info.hint}</span>
                                )}
                              </div>
                            </div>
                          );
                        })}
                      </div>
                    </>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </Layout>
  );
}
