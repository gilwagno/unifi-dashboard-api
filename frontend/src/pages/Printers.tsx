import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  Calendar,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Copy,
  Gauge,
  Hash,
  KeyRound,
  Package,
  Pencil,
  Power,
  Printer as PrinterIcon,
  RefreshCw,
  Trash2,
  WifiOff,
} from 'lucide-react';
import { Badge } from '../components/Badge';
import { Layout } from '../components/Layout';
import { StatCard } from '../components/StatCard';
import { usePolling } from '../hooks/usePolling';
import {
  api,
  AdminPasswordAmbiguousError,
  ApiError,
  type ConsumableSupplyStatus,
  type CreatePrinterBody,
  type PrinterAdminPasswordResult,
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

// O nome do suprimento vem cru do SNMP (`hrDeviceDescr` do fabricante, ex.:
// "Black Toner Cartridge", "Cartucho de toner preto", "Waste Toner Box") —
// sem um enum fechado do backend pra mapear, a cor é inferida por palavra-
// -chave (pt/en) no nome, só pra dar o mesmo feedback visual que o próprio
// painel da impressora já mostra (cartucho colorido, ver print da SWS real).
// Suprimentos sem cor associada (fusor, correia, coletor de resíduo, rolo)
// ficam neutros de propósito — inventar uma cor pra eles seria enganoso.
const SUPPLY_COLOR_RULES: { pattern: RegExp; fill: string }[] = [
  { pattern: /preto|black|k(?:\b|toner)/i, fill: '#27272a' },
  { pattern: /ciano|cyan/i, fill: '#06b6d4' },
  { pattern: /magenta/i, fill: '#db2777' },
  { pattern: /amarel|yellow/i, fill: '#eab308' },
];
const NEUTRAL_SUPPLY_FILL = '#94a3b8'; // slate-400 — suprimento sem cor de toner associada (fusor, rolo, correia…)

function supplyFillColor(name: string): string {
  const match = SUPPLY_COLOR_RULES.find((rule) => rule.pattern.test(name));
  return match?.fill ?? NEUTRAL_SUPPLY_FILL;
}

// Achado real do usuário testando ao vivo: nesta impressora, os rolos do
// ADF (alimentador automático de documentos — só usado pra ESCANEAR, não
// afeta impressão nenhuma) tinham percentual conhecido (100%) enquanto o
// toner de verdade estava em 0% — e os dois apareciam juntos no medidor
// compacto, sem rótulo visível, dando a impressão de "a maioria está bem"
// quando na verdade o único suprimento que importa pra IMPRIMIR já tinha
// acabado. O número não estava errado (é o que o SNMP reporta mesmo), mas
// misturar peça de scanner com toner no mesmo relance é enganoso.
function isPrintPathSupply(name: string): boolean {
  return !/\bADF\b/i.test(name);
}

// Medidor visual de toner na LINHA DA LISTA (fora do "Ver consumíveis") —
// pedido do usuário: ver de cara, com cor, se cada cartucho "está cheio ou
// precisa trocar", sem expandir o card (mesma ideia de um app de fabricante
// mostrando os cartuchos coloridos). Um "tubo" vertical por suprimento com
// percentual conhecido, preenchido de baixo pra cima na cor do toner
// (`supplyFillColor`, já usada no detalhe expandido — cor por palavra-chave
// no nome; sem cor identificada, cinza neutro, ex.: fusor/rolo/correia).
// Nunca inventa um número quando não há leitura confiável (sentinela/não
// suportado/nunca coletado) — esses suprimentos simplesmente não entram no
// medidor; o "Ver consumíveis" continua sendo a fonte da explicação. Peças
// do ADF (`isPrintPathSupply`) também ficam de fora do relance compacto,
// mesmo quando medidas — só aparecem no detalhe expandido, junto do rótulo
// que deixa claro o que são.
function tonerLevelsGauge(c: PrinterConsumablesResponse | undefined) {
  if (!c) return null;
  const measured = c.supplies.filter(
    (s): s is typeof s & { levelPercent: number } => s.levelPercent !== null && isPrintPathSupply(s.name),
  );
  if (measured.length === 0) return null;

  return (
    <div className="flex items-end gap-1.5" title="Níveis de suprimentos">
      {measured.map((supply, i) => {
        const pct = Math.max(0, Math.min(100, supply.levelPercent));
        const fill = supplyFillColor(supply.name);
        const isLow = supply.status === 'low';
        return (
          <div key={i} className="flex flex-col items-center gap-0.5" title={`${supply.name}: ${pct}%`}>
            <div
              className={`relative h-7 w-3 overflow-hidden rounded-[3px] bg-slate-100 ring-1 ${isLow ? 'ring-[oklch(70%_0.18_25)]' : 'ring-slate-200'}`}
            >
              <div
                className="absolute inset-x-0 bottom-0 transition-[height]"
                style={{ height: `${pct}%`, backgroundColor: fill }}
              />
            </div>
            <span className={`text-[8.5px] font-semibold ${isLow ? 'text-[oklch(45%_0.18_25)]' : 'text-slate-500'}`}>
              {pct}%
            </span>
          </div>
        );
      })}
    </div>
  );
}

function formatCollectedAt(iso: string | null): string {
  if (!iso) return 'nunca coletado';
  return new Date(iso).toLocaleString('pt-BR');
}

function networkBadge(printer: PrinterWithNetwork) {
  const { network } = printer;
  if (network.source === 'unknown') {
    return <Badge tone="neutral">Status de rede desconhecido</Badge>;
  }

  // `source` 'integration' e 'classic' compartilham o mesmo shape desde a
  // melhoria que cruza a API clássica com stat/sta (conectados agora de
  // verdade) — `online` já vem true/false/null calculado pelo backend nos
  // dois casos, não é mais "sempre true na Integration API, sempre
  // desconhecido na clássica". A UI só precisa decidir o texto/tom pelo
  // valor de `online`, sem se importar com a origem.
  const originLabel = network.source === 'integration' ? undefined : 'Conhecida pelo controller';
  const ipText = `${network.ipAddress ?? 'IP desconhecido'} (${network.connectionType ?? '—'})`;

  if (network.online === true) {
    return (
      <Badge tone="success">
        {originLabel ? `${originLabel} · ` : ''}Online · {ipText}
      </Badge>
    );
  }
  if (network.online === false) {
    return (
      <Badge tone="warning">
        {originLabel ? `${originLabel} · ` : ''}Offline · {ipText}
      </Badge>
    );
  }
  return (
    <Badge tone="neutral">
      {originLabel ? `${originLabel} · ` : ''}Online desconhecido · {ipText}
    </Badge>
  );
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

  // Record por id, não um único valor global: uma ação em OUTRA impressora não
  // pode reabilitar os botões de uma ação ainda em voo nesta.
  const [pendingIds, setPendingIds] = useState<Record<string, boolean>>({});

  const [aliasEditingId, setAliasEditingId] = useState<string | null>(null);
  const [aliasDraft, setAliasDraft] = useState('');
  const [aliasSubmitting, setAliasSubmitting] = useState(false);

  // Painel de troca de senha de admin do painel web (HP/SWS) — mesma
  // disciplina do apelido (um só aberto por vez), mas com estado próprio
  // porque a credencial nova aparece na tela e não pode ser perdida se o
  // polling recarregar a lista (ver `usePolling` abaixo: desligado enquanto
  // este painel está aberto, mesmo padrão do editor de IP fixo/senha Wi-Fi).
  const [adminPasswordEditingId, setAdminPasswordEditingId] = useState<string | null>(null);
  const [adminPasswordUsernameDraft, setAdminPasswordUsernameDraft] = useState('');
  const [adminPasswordDraft, setAdminPasswordDraft] = useState('');
  const [adminPasswordSubmitting, setAdminPasswordSubmitting] = useState(false);
  const [adminPasswordError, setAdminPasswordError] = useState<Record<string, string>>({});
  // Resultado bem-sucedido OU o estado AMBÍGUO (ver AdminPasswordAmbiguousError)
  // — os dois mostram a credencial em texto puro, só o tom visual muda.
  const [adminPasswordResult, setAdminPasswordResult] = useState<
    Record<string, PrinterAdminPasswordResult & { ambiguous: boolean }>
  >({});

  const requestSeqRef = useRef(0);
  // IDs já buscados (ou em busca) via fetchConsumablesFor — evita refazer a
  // chamada a cada ciclo de polling da lista (a cada 60s), já que o próprio
  // poller SNMP do backend só atualiza a cada 15min. Removido do Set numa
  // falha, para uma tentativa futura (próximo `load()`) poder tentar de novo.
  const consumablesFetchedRef = useRef<Set<string>>(new Set());

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
  usePolling(() => load(true), POLL_INTERVAL_MS, {
    enabled: !showForm && aliasEditingId === null && adminPasswordEditingId === null,
  });

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
    // Mesmo achado das duas edições acima: o formulário de cadastro/edição também é
    // um único estado global — "Editar" em outra linha, com um cadastro/edição já
    // aberto (inclusive "Nova impressora"), sobrescrevia tudo sem aviso.
    if (showForm && editingId !== printer.id) {
      const confirmed = window.confirm(
        'Já há um formulário de impressora aberto (cadastro ou edição de outra impressora). Trocar agora descarta o que não foi salvo. Continuar?',
      );
      if (!confirmed) return;
    }
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
    setPendingIds((prev) => ({ ...prev, [printer.id]: true }));
    setError(null);
    try {
      await api.deletePrinter(printer.id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao remover impressora');
    } finally {
      setPendingIds((prev) => {
        const next = { ...prev };
        delete next[printer.id];
        return next;
      });
    }
  }

  async function handleReconnect(printer: PrinterWithNetwork) {
    const confirmed = window.confirm(
      `Reconectar "${printer.name}" à rede? Isso bloqueia e desbloqueia o cliente no controller UniFi para forçar ` +
        'uma nova associação. NÃO reinicia nem desliga o equipamento — é só uma reconexão de rede.',
    );
    if (!confirmed) return;
    setPendingIds((prev) => ({ ...prev, [printer.id]: true }));
    setError(null);
    try {
      await api.reconnectPrinter(printer.id);
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao reconectar impressora');
    } finally {
      setPendingIds((prev) => {
        const next = { ...prev };
        delete next[printer.id];
        return next;
      });
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
    setPendingIds((prev) => ({ ...prev, [printer.id]: true }));
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
      setPendingIds((prev) => {
        const next = { ...prev };
        delete next[printer.id];
        return next;
      });
    }
  }

  // Compartilhada entre o clique em "Ver consumíveis" (toggleConsumables) e o
  // carregamento antecipado (useEffect abaixo). O ref evita SÓ chamadas
  // concorrentes pro mesmo id (nunca duas em voo ao mesmo tempo) — é
  // removido do Set assim que a chamada termina, sucesso ou falha, pra não
  // travar pra sempre: o poller SNMP do backend roda a cada 15min, e a
  // lista de impressoras já recarrega sozinha a cada 60s (usePolling) — sem
  // liberar o ref aqui, o medidor de toner da linha (tonerLevelsGauge)
  // ficaria PRESO no retrato da primeiríssima busca pra sempre, nunca
  // refletindo uma coleta nova do poller (achado real do usuário: o medidor
  // não aparecia porque a única busca tinha acontecido ANTES da primeira
  // coleta bem-sucedida do poller, e nunca mais era refeita).
  function fetchConsumablesFor(printer: PrinterWithNetwork) {
    if (consumablesFetchedRef.current.has(printer.id)) return;
    consumablesFetchedRef.current.add(printer.id);
    setConsumablesLoading((prev) => ({ ...prev, [printer.id]: true }));
    setConsumablesError((prev) => {
      const next = { ...prev };
      delete next[printer.id];
      return next;
    });
    api
      .getPrinterConsumables(printer.id)
      .then((data) => setConsumables((prev) => ({ ...prev, [printer.id]: data })))
      .catch((err) => {
        setConsumablesError((prev) => ({
          ...prev,
          [printer.id]: err instanceof Error ? err.message : 'Falha ao carregar consumíveis',
        }));
      })
      .finally(() => {
        consumablesFetchedRef.current.delete(printer.id);
        setConsumablesLoading((prev) => ({ ...prev, [printer.id]: false }));
      });
  }

  function toggleConsumables(printer: PrinterWithNetwork) {
    if (expandedId === printer.id) {
      setExpandedId(null);
      return;
    }
    setExpandedId(printer.id);
    // Clique manual só busca se AINDA não tem nenhum dado — o refresh
    // periódico já é coberto pelo carregamento antecipado abaixo (a cada
    // ciclo de polling da lista); um clique não deve forçar uma chamada
    // extra se os dados já estão em memória, mesmo que sejam de um poll
    // anterior (a próxima atualização automática já está a caminho).
    if (consumables[printer.id]) return;
    fetchConsumablesFor(printer);
  }

  // Carregamento ANTECIPADO dos consumíveis de toda impressora da lista —
  // antes desta mudança, só existiam depois do usuário clicar em "Ver
  // consumíveis" de cada uma. Necessário para o badge de toner
  // (tonerSummaryBadge) aparecer direto na linha da lista, sem exigir clique.
  useEffect(() => {
    if (!printers) return;
    for (const printer of printers) fetchConsumablesFor(printer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [printers]);

  // Achado real do usuário testando ao vivo: o rascunho pré-preenchia com
  // `printer.name` (o nome do CADASTRO LOCAL deste módulo — campo
  // diferente), então o usuário achava que o Apelido no UniFi já era
  // aquele valor quando podia ser completamente outro (confirmado: uma
  // impressora com cadastro local "HP Laser MFP 135w (Financeiro)" tinha
  // Apelido real no UniFi "HP Laser MFP 135w (Comercial)"). Agora parte do
  // valor REAL (`printer.network.alias`, exposto pelo backend nesta
  // subtarefa) — string vazia só quando o UniFi realmente não tem apelido
  // configurado pra esse cliente.
  function startAliasEdit(printer: PrinterWithNetwork) {
    // Achado real: o rascunho é um único estado global — trocar de impressora com um
    // editor já aberto em OUTRA sobrescrevia o rascunho em andamento sem aviso nenhum.
    if (aliasEditingId !== null && aliasEditingId !== printer.id) {
      const confirmed = window.confirm(
        'Já há uma edição de apelido em andamento em outra impressora. Trocar agora descarta o que não foi salvo. Continuar?',
      );
      if (!confirmed) return;
    }
    setAliasEditingId(printer.id);
    setAliasDraft(printer.network.alias ?? '');
  }

  async function submitAlias(printer: PrinterWithNetwork) {
    if (!aliasDraft.trim()) return;
    setAliasSubmitting(true);
    setError(null);
    try {
      await api.setClientAlias(printer.mac, aliasDraft.trim());
      setAliasEditingId(null);
      setAliasDraft('');
      setNotice(`Apelido no UniFi de "${printer.name}" atualizado.`);
      // Sem isto, a tela continuava mostrando o apelido ANTIGO até o
      // próximo ciclo de polling (até 60s depois) — o mesmo tipo de achado
      // já corrigido no medidor de toner (ver fetchConsumablesFor acima):
      // uma ação de escrita bem-sucedida precisa refletir na tela na hora,
      // não só esperar o próximo poll.
      load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Falha ao renomear apelido no UniFi');
    } finally {
      setAliasSubmitting(false);
    }
  }

  function startAdminPasswordEdit(printer: PrinterWithNetwork) {
    // Mesmo achado do apelido acima, agravado aqui: o rascunho é uma credencial de
    // admin do painel web — perdê-la em silêncio ao trocar de impressora é pior do
    // que perder um nome.
    if (
      adminPasswordEditingId !== null &&
      adminPasswordEditingId !== printer.id &&
      (adminPasswordUsernameDraft.trim() || adminPasswordDraft)
    ) {
      const confirmed = window.confirm(
        'Já há um usuário/senha de admin digitados para outra impressora. Trocar agora descarta essa credencial. Continuar?',
      );
      if (!confirmed) return;
    }
    setAdminPasswordEditingId(printer.id);
    setAdminPasswordUsernameDraft('');
    setAdminPasswordDraft('');
    setAdminPasswordError((prev) => {
      const next = { ...prev };
      delete next[printer.id];
      return next;
    });
  }

  function cancelAdminPasswordEdit() {
    // Achado real: cancelar fechava o painel de edição mas deixava a mensagem de
    // erro de uma tentativa já abandonada visível indefinidamente, sem nenhum
    // botão para descartá-la — só desaparecia ao reabrir o mesmo editor.
    if (adminPasswordEditingId !== null) {
      const closingId = adminPasswordEditingId;
      setAdminPasswordError((prev) => {
        const next = { ...prev };
        delete next[closingId];
        return next;
      });
    }
    setAdminPasswordEditingId(null);
    setAdminPasswordUsernameDraft('');
    setAdminPasswordDraft('');
  }

  // AÇÃO DE MAIOR RISCO desta tela: mexe na credencial mestra do painel admin
  // de um equipamento de produção real. O `confirm` explica que a senha nova
  // (gerada por nós se o campo ficar em branco) só aparece UMA VEZ na tela —
  // mesmo espírito do aviso já usado pro reboot/reconectar, mas mais forte
  // porque aqui não dá pra simplesmente tentar de novo sem risco (ver o
  // estado AMBÍGUO tratado abaixo).
  async function submitAdminPassword(printer: PrinterWithNetwork) {
    // Achado real: validar o tamanho DEPOIS do confirm fazia o usuário passar pelo
    // aviso grave de uma ação destrutiva/irreversível para uma senha que nem chegaria
    // a ser enviada (o backend exige 8-18 caracteres) — a checagem precisa vir antes.
    if (adminPasswordDraft && adminPasswordDraft.length < 8) {
      setAdminPasswordError((prev) => ({
        ...prev,
        [printer.id]: 'A nova senha precisa ter entre 8 e 18 caracteres (ou deixe em branco para gerar uma automaticamente).',
      }));
      return;
    }

    const confirmed = window.confirm(
      `Trocar a senha de admin do painel web de "${printer.name}"?\n\n` +
        'Isso reescreve a credencial MESTRA do painel administrativo da própria impressora (não é a senha ' +
        'do Wi-Fi nem do UniFi). A senha nova só aparece nesta tela UMA VEZ — copie antes de fechar.',
    );
    if (!confirmed) return;

    setAdminPasswordSubmitting(true);
    setAdminPasswordError((prev) => {
      const next = { ...prev };
      delete next[printer.id];
      return next;
    });
    setAdminPasswordResult((prev) => {
      const next = { ...prev };
      delete next[printer.id];
      return next;
    });
    try {
      const result = await api.changeAdminPassword(printer.id, {
        username: adminPasswordUsernameDraft.trim() || undefined,
        password: adminPasswordDraft || undefined,
      });
      setAdminPasswordResult((prev) => ({ ...prev, [printer.id]: { ...result, ambiguous: false } }));
      setAdminPasswordEditingId(null);
      setAdminPasswordUsernameDraft('');
      setAdminPasswordDraft('');
    } catch (err) {
      if (err instanceof AdminPasswordAmbiguousError) {
        // Estado AMBÍGUO: o dispositivo pode ou não ter aceitado a troca real
        // — a credencial TENTADA é a única cópia que existe, então ela some
        // do formulário e vira o resultado exibido (mesmo lugar do sucesso,
        // com um tom visual bem mais alarmante — ver renderização abaixo).
        setAdminPasswordResult((prev) => ({
          ...prev,
          [printer.id]: {
            username: err.attemptedUsername,
            password: err.attemptedPassword,
            ipAddress: err.ipAddress,
            ipOrigin: err.ipOrigin,
            ambiguous: true,
          },
        }));
        setAdminPasswordEditingId(null);
        setAdminPasswordUsernameDraft('');
        setAdminPasswordDraft('');
      } else {
        setAdminPasswordError((prev) => ({
          ...prev,
          [printer.id]: err instanceof ApiError ? err.message : 'Falha ao trocar a senha de admin',
        }));
      }
    } finally {
      setAdminPasswordSubmitting(false);
    }
  }

  // Painel de saúde da frota — visão de conjunto que ninguém tinha antes
  // (cada impressora só existia como card isolado na lista). Cruza a lista
  // (`printers`, status de rede) com os consumíveis já buscados
  // antecipadamente para o medidor da linha (`tonerLevelsGauge` acima) —
  // nenhuma chamada nova, só agregação do que já está em memória.
  //
  // "Precisa de atenção" identifica CADA impressora com pelo menos um dos 3
  // sinais (offline, toner baixo, nunca coletada) e guarda o(s) motivo(s)
  // por impressora — achado do próprio usuário testando ao vivo: um número
  // sozinho ("1") sem dizer QUAL impressora e POR QUÊ obriga a abrir cada
  // card pra descobrir, o oposto do que um painel de resumo deveria fazer.
  const fleetStats = useMemo(() => {
    if (!printers) return null;
    const online = printers.filter((p) => p.network.online === true).length;
    const offline = printers.filter((p) => p.network.online === false).length;

    const attentionDetails = printers
      .map((printer) => {
        const reasons: string[] = [];
        if (printer.network.online === false) reasons.push('offline');
        if (consumables[printer.id]?.supplies.some((s) => s.status === 'low')) reasons.push('toner baixo');
        if (consumables[printer.id] && consumables[printer.id]!.collectedAt === null) reasons.push('sem leitura SNMP');
        return reasons.length > 0 ? { name: printer.name, reasons } : null;
      })
      .filter((detail): detail is { name: string; reasons: string[] } => detail !== null);

    const totalPages = printers.reduce((sum, p) => sum + (consumables[p.id]?.pageCount ?? 0), 0);
    const pagesKnownFor = printers.filter((p) => consumables[p.id]?.pageCount !== undefined && consumables[p.id]?.pageCount !== null).length;
    return { total: printers.length, online, offline, attentionDetails, totalPages, pagesKnownFor };
  }, [printers, consumables]);

  // Texto do StatCard "Precisa de atenção" — nome(s) + motivo(s), não um
  // aviso genérico. Lista até 2 impressoras por extenso; com mais, resume
  // ("+N impressoras") pra não estourar o card, mas o número no valor do
  // card já conta o total certo em qualquer caso.
  const attentionTrend = (() => {
    if (!fleetStats || fleetStats.attentionDetails.length === 0) return 'tudo em dia';
    const named = fleetStats.attentionDetails
      .slice(0, 2)
      .map((d) => `${d.name} (${d.reasons.join(', ')})`)
      .join(' · ');
    const extra = fleetStats.attentionDetails.length - 2;
    return extra > 0 ? `${named} +${extra} impressora${extra > 1 ? 's' : ''}` : named;
  })();

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

      {fleetStats && fleetStats.total > 0 && (
        <div className="mb-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <StatCard
            label="Impressoras"
            value={fleetStats.total}
            icon={<PrinterIcon className="h-3.5 w-3.5 text-accent" strokeWidth={2} />}
            iconBg="oklch(94% 0.03 255 / 0.6)"
          />
          <StatCard
            label="Online"
            value={`${fleetStats.online}/${fleetStats.total}`}
            trend={fleetStats.offline === 0 ? 'todas operacionais' : `${fleetStats.offline} offline`}
            trendTone={fleetStats.offline === 0 ? 'success' : 'danger'}
            icon={
              fleetStats.offline === 0 ? (
                <CheckCircle2 className="h-3.5 w-3.5 text-[oklch(50%_0.13_150)]" strokeWidth={2} />
              ) : (
                <WifiOff className="h-3.5 w-3.5 text-[oklch(55%_0.18_25)]" strokeWidth={2} />
              )
            }
            iconBg={fleetStats.offline === 0 ? 'oklch(94% 0.05 150 / 0.5)' : 'oklch(95% 0.05 25 / 0.5)'}
          />
          <StatCard
            label="Precisa de atenção"
            value={fleetStats.attentionDetails.length}
            trend={attentionTrend}
            trendTone={fleetStats.attentionDetails.length === 0 ? 'success' : 'danger'}
            icon={<AlertTriangle className="h-3.5 w-3.5 text-[oklch(55%_0.18_60)]" strokeWidth={2} />}
            iconBg="oklch(95% 0.06 60 / 0.5)"
          />
          <StatCard
            label="Páginas impressas"
            value={fleetStats.pagesKnownFor > 0 ? fleetStats.totalPages.toLocaleString('pt-BR') : '—'}
            trend={
              fleetStats.pagesKnownFor > 0
                ? `soma de ${fleetStats.pagesKnownFor} de ${fleetStats.total} impressora(s)`
                : 'aguardando o poller SNMP'
            }
            icon={<Copy className="h-3.5 w-3.5 text-accent" strokeWidth={2} />}
            iconBg="oklch(95% 0.03 255 / 0.6)"
          />
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
                    {/* Achado real do usuário: sem um rótulo sempre visível, um nome de
                        cadastro local diferente do Apelido no UniFi (linha abaixo) parecia
                        dado inconsistente — o único aviso existente era um tooltip, que
                        exige hover pra ser notado. */}
                    <div className="flex items-baseline gap-1.5">
                      <span className="text-[13.5px] font-bold text-slate-900">{printer.name}</span>
                      <span className="text-[9.5px] font-semibold uppercase tracking-wide text-slate-400">
                        cadastro local
                      </span>
                    </div>
                    <span className="font-mono text-[11.5px] text-slate-500">{printer.mac}</span>
                  </div>
                </div>

                <div className="flex items-center gap-2">
                  {networkBadge(printer)}
                  {tonerLevelsGauge(consumables[printer.id])}
                </div>

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
                    disabled={pendingIds[printer.id]}
                    title="Reconexão de REDE (bloqueia e desbloqueia o cliente no controller) — não reinicia o equipamento."
                    className="flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[11.5px] font-semibold text-slate-700 disabled:opacity-50"
                  >
                    <RefreshCw className="h-3.5 w-3.5" />
                    Reconectar
                  </button>
                  <button
                    type="button"
                    onClick={() => handleReboot(printer)}
                    disabled={pendingIds[printer.id]}
                    title="REINICIA o equipamento físico pelo painel web da impressora — diferente de Reconectar."
                    className="flex items-center gap-1 rounded-md border border-[oklch(87%_0.06_25)] bg-white px-3 py-1.5 text-[11.5px] font-semibold text-[oklch(48%_0.16_25)] disabled:opacity-50"
                  >
                    <Power className="h-3.5 w-3.5" />
                    Reiniciar remotamente
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      adminPasswordEditingId === printer.id ? cancelAdminPasswordEdit() : startAdminPasswordEdit(printer)
                    }
                    disabled={pendingIds[printer.id]}
                    title="Troca a senha de admin do PAINEL WEB da impressora (HP/SWS) — a credencial mestra do painel, não a do Wi-Fi/UniFi."
                    className="flex items-center gap-1 rounded-md border border-[oklch(85%_0.08_300)] bg-white px-3 py-1.5 text-[11.5px] font-semibold text-[oklch(45%_0.15_300)] disabled:opacity-50"
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    Trocar senha de admin
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
                    disabled={pendingIds[printer.id]}
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
                  <>
                    {/* Achado real do usuário: sem isto, não tinha como saber o
                        apelido atual sem sair pro painel do UniFi conferir. */}
                    <span className="text-[11.5px] text-slate-600">
                      {printer.network.source === 'unknown' ? (
                        // `alias: null` aqui não significa "sem apelido configurado" — significa
                        // que nem sabemos, porque a API clássica/Integration falhou ou o MAC não
                        // bateu com nenhum cliente conhecido (mesmo motivo do badge "Status de
                        // rede desconhecido" acima). Afirmar "sem apelido" seria uma alegação
                        // factual que pode ser falsa.
                        <span className="italic text-slate-400">apelido desconhecido (status de rede indisponível)</span>
                      ) : (
                        printer.network.alias ?? <span className="italic text-slate-400">sem apelido configurado</span>
                      )}
                    </span>
                    <button
                      onClick={() => startAliasEdit(printer)}
                      title="Renomeia o Apelido exibido no painel do UniFi — diferente do nome deste cadastro local."
                      className="rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11.5px] font-semibold text-slate-600"
                    >
                      Renomear apelido no UniFi
                    </button>
                  </>
                )}
              </div>

              {adminPasswordEditingId === printer.id && (
                <div className="flex flex-wrap items-end gap-2.5 border-t border-slate-50 bg-[oklch(98%_0.02_300)] px-5 py-3">
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-semibold text-slate-500">Novo usuário (opcional)</label>
                    <input
                      autoFocus
                      value={adminPasswordUsernameDraft}
                      onChange={(e) => setAdminPasswordUsernameDraft(e.target.value)}
                      maxLength={18}
                      placeholder="deixe em branco para manter o atual"
                      className="w-56 rounded-md border border-slate-300 px-2.5 py-1.5 text-[13px]"
                    />
                  </div>
                  <div className="flex flex-col gap-1">
                    <label className="text-[11px] font-semibold text-slate-500">Nova senha (opcional, 8–18 caracteres)</label>
                    <input
                      value={adminPasswordDraft}
                      onChange={(e) => setAdminPasswordDraft(e.target.value)}
                      type="text"
                      autoComplete="off"
                      maxLength={18}
                      placeholder="deixe em branco para gerar uma forte automaticamente"
                      className="w-72 rounded-md border border-slate-300 px-2.5 py-1.5 font-mono text-[13px]"
                    />
                  </div>
                  <button
                    onClick={() => submitAdminPassword(printer)}
                    disabled={adminPasswordSubmitting}
                    className="rounded-md bg-[oklch(45%_0.15_300)] px-3 py-1.5 text-[11.5px] font-semibold text-white disabled:opacity-50"
                  >
                    {adminPasswordSubmitting ? 'Trocando…' : 'Confirmar troca'}
                  </button>
                  <button
                    onClick={cancelAdminPasswordEdit}
                    className="rounded-md border border-slate-200 bg-white px-3 py-1.5 text-[11.5px] font-semibold text-slate-500"
                  >
                    Cancelar
                  </button>
                  <span className="w-full max-w-md text-[10.5px] text-slate-400">
                    Credencial do PAINEL WEB da própria impressora (HP/SWS) — diferente da senha do Wi-Fi ou do login
                    deste dashboard. Só funciona se a impressora já tiver uma credencial atual cadastrada.
                  </span>
                </div>
              )}

              {adminPasswordError[printer.id] && (
                <div className="flex items-center justify-between gap-3 border-t border-slate-50 bg-[oklch(97%_0.03_25)] px-5 py-2.5 text-[12.5px] text-[oklch(40%_0.15_25)]">
                  <span>{adminPasswordError[printer.id]}</span>
                  <button
                    onClick={() =>
                      setAdminPasswordError((prev) => {
                        const next = { ...prev };
                        delete next[printer.id];
                        return next;
                      })
                    }
                    className="shrink-0 rounded-md border border-[oklch(87%_0.06_25)] bg-white px-2.5 py-1 text-[11px] font-semibold text-[oklch(45%_0.15_25)]"
                  >
                    Fechar
                  </button>
                </div>
              )}

              {adminPasswordResult[printer.id] && (
                <div
                  className={`border-t border-slate-50 px-5 py-3.5 ${
                    adminPasswordResult[printer.id].ambiguous
                      ? 'bg-[oklch(96%_0.06_25)]'
                      : 'bg-[oklch(97%_0.05_150)]'
                  }`}
                >
                  <div
                    className={`mb-1.5 text-[12.5px] font-bold ${
                      adminPasswordResult[printer.id].ambiguous
                        ? 'text-[oklch(42%_0.15_25)]'
                        : 'text-[oklch(38%_0.1_150)]'
                    }`}
                  >
                    {adminPasswordResult[printer.id].ambiguous
                      ? 'NÃO FOI POSSÍVEL CONFIRMAR — copie esta credencial agora, ela pode já estar valendo no painel.'
                      : 'Senha trocada e confirmada — copie agora, ela não aparece de novo.'}
                  </div>
                  <div className="flex flex-col gap-0.5 font-mono text-[13px] text-slate-900">
                    <div>
                      usuário: <span className="font-semibold">{adminPasswordResult[printer.id].username}</span>
                    </div>
                    <div className="break-all">
                      senha: <span className="font-semibold">{adminPasswordResult[printer.id].password}</span>
                    </div>
                  </div>
                  <div className="mt-1.5 text-[10.5px] text-slate-500">
                    Endereço: {adminPasswordResult[printer.id].ipAddress} (origem do IP:{' '}
                    {adminPasswordResult[printer.id].ipOrigin})
                    {adminPasswordResult[printer.id].ambiguous &&
                      ' — o cadastro NÃO foi atualizado; confira manualmente o painel da impressora antes de tentar de novo.'}
                  </div>
                  <button
                    onClick={() =>
                      setAdminPasswordResult((prev) => {
                        const next = { ...prev };
                        delete next[printer.id];
                        return next;
                      })
                    }
                    className="mt-2 rounded-md border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-500"
                  >
                    Já copiei, fechar
                  </button>
                </div>
              )}

              {isExpanded && (
                <div className="border-t border-slate-100 bg-slate-50 px-5 py-4">
                  {cLoading && <div className="text-[12.5px] text-slate-400">Carregando consumíveis…</div>}
                  {cError && <div className="text-[12.5px] text-[oklch(45%_0.18_25)]">{cError}</div>}
                  {c && !cLoading && !cError && (
                    <>
                      <div className="mb-3 flex flex-wrap gap-2">
                        <div className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5">
                          <Calendar className="h-3.5 w-3.5 text-slate-400" strokeWidth={2} />
                          <span className="text-[11px] text-slate-400">Coletado em</span>
                          <span className="text-[11.5px] font-semibold text-slate-700">{formatCollectedAt(c.collectedAt)}</span>
                        </div>
                        <div className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5">
                          <Hash className="h-3.5 w-3.5 text-slate-400" strokeWidth={2} />
                          <span className="text-[11px] text-slate-400">Páginas impressas</span>
                          <span className="text-[11.5px] font-semibold text-slate-700">{c.pageCount ?? '—'}</span>
                        </div>
                        <div className="flex items-center gap-1.5 rounded-lg bg-white px-3 py-1.5">
                          <Gauge className="h-3.5 w-3.5 text-slate-400" strokeWidth={2} />
                          <span className="text-[11px] text-slate-400">Alerta de "baixo"</span>
                          <span className="text-[11.5px] font-semibold text-slate-700">
                            {c.lowThresholdPct !== null ? `${c.lowThresholdPct}%` : 'não configurado'}
                          </span>
                        </div>
                      </div>
                      {c.supplies.length === 0 && (
                        <div className="flex flex-col items-center gap-1.5 rounded-lg bg-white px-5 py-8 text-center">
                          <Package className="h-5 w-5 text-slate-300" strokeWidth={1.5} />
                          <span className="text-[12.5px] text-slate-400">Nenhum suprimento coletado ainda.</span>
                          <span className="text-[10.5px] text-slate-300">
                            O poller SNMP consulta a impressora a cada 15 minutos — aparece aqui após a primeira leitura.
                          </span>
                        </div>
                      )}
                      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
                        {c.supplies.map((supply, i) => {
                          const info = SUPPLY_STATUS_INFO[supply.status];
                          const fill = supplyFillColor(supply.name);
                          return (
                            <div key={i} className="rounded-lg bg-white px-3.5 py-3">
                              <div className="mb-1.5 flex items-center justify-between gap-2">
                                <div className="flex min-w-0 items-center gap-1.5">
                                  <span
                                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                                    style={{ backgroundColor: fill }}
                                    aria-hidden
                                  />
                                  <span className="truncate text-[12.5px] font-semibold text-slate-800">{supply.name}</span>
                                </div>
                                <Badge tone={info.tone}>{info.label}</Badge>
                              </div>
                              <div className="mb-1 flex items-baseline gap-1.5">
                                <span className="text-[19px] font-bold leading-none text-slate-900">
                                  {supply.levelPercent !== null ? `${supply.levelPercent}%` : 'sem dado'}
                                </span>
                                <span className="text-[10.5px] text-slate-400">restante</span>
                              </div>
                              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                                {supply.levelPercent !== null && (
                                  <div
                                    className="h-full rounded-full transition-[width]"
                                    style={{
                                      width: `${Math.max(0, Math.min(100, supply.levelPercent))}%`,
                                      backgroundColor: fill,
                                    }}
                                  />
                                )}
                              </div>
                              {info.tone === 'neutral' && (
                                <span className="mt-1.5 block text-[10.5px] text-slate-400">{info.hint}</span>
                              )}
                              {supply.serialNumber !== null && (
                                <span className="mt-1.5 block truncate text-[10.5px] text-slate-400">
                                  S/N: {supply.serialNumber}
                                </span>
                              )}
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
