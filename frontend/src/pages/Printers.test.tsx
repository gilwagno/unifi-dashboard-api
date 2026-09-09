import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { Printers } from './Printers';
import type { PrinterConsumablesResponse, PrinterWithNetwork } from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: {
      listSites: vi.fn(),
      listPrinters: vi.fn(),
      getPrinter: vi.fn(),
      createPrinter: vi.fn(),
      updatePrinter: vi.fn(),
      deletePrinter: vi.fn(),
      reconnectPrinter: vi.fn(),
      rebootPrinter: vi.fn(),
      getPrinterConsumables: vi.fn(),
      setClientAlias: vi.fn(),
    },
    getAccessToken: () => null,
  };
});

import { api, ApiError } from '../lib/api';

function renderPrinters() {
  return render(
    <AuthProvider>
      <MemoryRouter>
        <Printers />
      </MemoryRouter>
    </AuthProvider>,
  );
}

const PRINTER_INTEGRATION: PrinterWithNetwork = {
  id: 'p1',
  name: 'HPLaserMFP135w',
  mac: '50:81:40:d8:6c:7e',
  ipOverride: null,
  snmpVersion: 'v2c',
  maintenance: { intervalDays: null, intervalPages: null, consumableLowThresholdPct: null },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  network: { source: 'integration', online: true, ipAddress: '172.16.0.89', connectionType: 'WIRED' },
};

const PRINTER_CLASSIC: PrinterWithNetwork = {
  id: 'p2',
  name: 'HLL2360DWVENDAS',
  mac: 'e8:6f:38:ba:b9:32',
  ipOverride: null,
  snmpVersion: 'v1',
  maintenance: { intervalDays: null, intervalPages: null, consumableLowThresholdPct: 20 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  network: { source: 'classic', online: null, ipAddress: '172.16.0.222', connectionType: 'WIRED' },
};

const PRINTER_UNKNOWN: PrinterWithNetwork = {
  id: 'p3',
  name: 'BRW849E567E0445',
  mac: '84:9e:56:7e:04:45',
  ipOverride: null,
  snmpVersion: 'v2c',
  maintenance: { intervalDays: null, intervalPages: null, consumableLowThresholdPct: null },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  network: { source: 'unknown', online: null, ipAddress: null, connectionType: null },
};

function mockSites() {
  vi.mocked(api.listSites).mockResolvedValue({ data: [{ id: 's1', name: 'Site 1' }] });
}

// Flusha a fila de microtasks várias vezes seguidas — necessário com fake
// timers ativos, porque a carga inicial passa por mais de um `.then()` em
// cadeia (Layout carregando sites + Printers carregando a lista) e uma única
// volta de `advanceTimersByTimeAsync(0)` só libera um nível da cadeia por vez.
async function flushMicrotasks() {
  for (let i = 0; i < 10; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

describe('Printers page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    mockSites();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('renders the printer list with the right network indicator for integration/classic/unknown sources', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION, PRINTER_CLASSIC, PRINTER_UNKNOWN]);

    renderPrinters();

    expect(await screen.findByText('HPLaserMFP135w')).toBeInTheDocument();
    expect(screen.getByText('HLL2360DWVENDAS')).toBeInTheDocument();
    expect(screen.getByText('BRW849E567E0445')).toBeInTheDocument();

    expect(screen.getByText(/Online · 172\.16\.0\.89/)).toBeInTheDocument();
    // ACHADO AO VIVO (sessão de continuação): a melhoria que faz o backend
    // cruzar a API clássica com stat/sta (online/offline real, não mais
    // sempre desconhecido) tinha suíte verde nos dois lados (backend e
    // frontend) mas a tela continuava sempre mostrando "online desconhecido"
    // pra fontes "classic" de qualquer jeito — o componente nunca olhava pro
    // valor de `network.online`, só pro `network.source`. Sem este teste
    // (que usa `online: null` de propósito, único caso em que o texto
    // continua sendo "desconhecido"), o bug passava despercebido.
    expect(screen.getByText(/Conhecida pelo controller · Online desconhecido · 172\.16\.0\.222/)).toBeInTheDocument();
    expect(screen.getByText('Status de rede desconhecido')).toBeInTheDocument();
  });

  it('mostra Online/Offline de verdade pra fonte "classic" quando o backend já sabe (stat/sta)', async () => {
    const classicOnline: PrinterWithNetwork = {
      ...PRINTER_CLASSIC,
      id: 'p2-online',
      network: { ...PRINTER_CLASSIC.network, online: true },
    };
    const classicOffline: PrinterWithNetwork = {
      ...PRINTER_CLASSIC,
      id: 'p2-offline',
      name: 'DCP-1610NW',
      network: { ...PRINTER_CLASSIC.network, online: false },
    };
    vi.mocked(api.listPrinters).mockResolvedValue([classicOnline, classicOffline]);

    renderPrinters();

    expect(await screen.findByText(/Conhecida pelo controller · Online · 172\.16\.0\.222/)).toBeInTheDocument();
    expect(screen.getByText(/Conhecida pelo controller · Offline · 172\.16\.0\.222/)).toBeInTheDocument();
  });

  it('does not fetch consumables until the user expands a card, and never shows null levelPercent as 0% or NaN%', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    const consumablesResponse: PrinterConsumablesResponse = {
      printerId: 'p1',
      collectedAt: '2026-08-31T12:00:00.000Z',
      pageCount: 1234,
      lowThresholdPct: null,
      supplies: [
        { name: 'Black Toner', levelPercent: 42, status: 'ok' },
        { name: 'Waste Toner Box', levelPercent: null, status: 'unknown' },
        { name: 'Fuser', levelPercent: null, status: 'not-measured' },
      ],
    };
    vi.mocked(api.getPrinterConsumables).mockResolvedValue(consumablesResponse);

    const user = userEvent.setup();
    renderPrinters();

    await screen.findByText('HPLaserMFP135w');
    expect(api.getPrinterConsumables).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: /Ver consumíveis/ }));

    expect(await screen.findByText('Black Toner')).toBeInTheDocument();
    expect(api.getPrinterConsumables).toHaveBeenCalledWith('p1');
    expect(api.getPrinterConsumables).toHaveBeenCalledTimes(1);

    expect(screen.getByText('42%')).toBeInTheDocument();
    const supplyRows = screen.getAllByText('sem dado');
    expect(supplyRows).toHaveLength(2);
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.queryByText('NaN%')).not.toBeInTheDocument();
    expect(screen.getByText('Desconhecido')).toBeInTheDocument();
    expect(screen.getByText('Sem medição')).toBeInTheDocument();

    // Toggling again should not refetch (cached).
    await user.click(screen.getByRole('button', { name: /Ver consumíveis/ }));
    await user.click(screen.getByRole('button', { name: /Ver consumíveis/ }));
    expect(api.getPrinterConsumables).toHaveBeenCalledTimes(1);
  });

  it('creates a new printer with the correct snmp shape', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([]);
    vi.mocked(api.createPrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();

    await user.click(await screen.findByRole('button', { name: 'Nova impressora' }));

    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Nova Impressora');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '11:22:33:44:55:66');
    await user.type(screen.getByPlaceholderText('ex: public'), 'public');

    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));

    await waitFor(() =>
      expect(api.createPrinter).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Nova Impressora',
          mac: '11:22:33:44:55:66',
          snmp: { version: 'v2c', community: 'public' },
        }),
      ),
    );
  });

  it('calls reconnectPrinter only after confirming, never when the dialog is cancelled', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.reconnectPrinter).mockResolvedValue({ ok: true, note: 'ok' });

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(screen.getByRole('button', { name: /Reconectar/ }));
    expect(api.reconnectPrinter).not.toHaveBeenCalled();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: /Reconectar/ }));
    await waitFor(() => expect(api.reconnectPrinter).toHaveBeenCalledWith('p1'));
  });

  // O segredo SNMP (community/senhas v3) só pode viver no estado do
  // componente. Este teste cobre os TRÊS momentos em que ele existe na
  // página: logo após ser digitado, DEPOIS DE UM SUBMIT bem-sucedido (o
  // caminho onde o valor de fato passa por handleSubmit/toSnmpInput e é
  // serializado — é aqui que um `localStorage.setItem` de debug esquecido
  // vazaria) e depois de cancelar o formulário. Cobrir só "digitou" deixa
  // o caminho mais perigoso sem rede de proteção.
  function expectNoSecretInStorage(secret: string) {
    expect(JSON.stringify(localStorage)).not.toContain(secret);
    expect(JSON.stringify(sessionStorage)).not.toContain(secret);
    for (const storage of [localStorage, sessionStorage]) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i)!;
        expect(key).not.toContain(secret);
        expect(storage.getItem(key) ?? '').not.toContain(secret);
      }
    }
  }

  it('never persists a typed SNMP secret to storage — after typing, after submitting, or after cancelling', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([]);
    vi.mocked(api.createPrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();

    await user.click(await screen.findByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Nova Impressora');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '11:22:33:44:55:66');
    await user.type(screen.getByPlaceholderText('ex: public'), 'Unique-Community-Secret-77');

    expectNoSecretInStorage('Unique-Community-Secret-77');

    // Caminho crítico: o submit de verdade (o segredo é lido do estado,
    // montado em `snmp` e enviado). Nada disso pode encostar em storage.
    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));
    await waitFor(() => expect(api.createPrinter).toHaveBeenCalled());
    expectNoSecretInStorage('Unique-Community-Secret-77');

    // E o mesmo vale para o segredo do SNMPv3, que passa por outro ramo de
    // toSnmpInput (v3Auth) e nunca pelo campo `community`.
    await user.click(screen.getByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Impressora v3');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '22:33:44:55:66:77');
    await user.selectOptions(screen.getByDisplayValue('v2c'), 'v3');
    await user.type(screen.getByPlaceholderText('usuário'), 'snmpuser');
    // Em v3 o campo `community` não é renderizado: os campos de senha do
    // SNMP são a senha de autenticação e a de privacidade, nessa ordem. A
    // senha do PAINEL WEB (wbmCredentials) também é um input[type=password]
    // do mesmo formulário, mas é de outro domínio (credencial de admin da
    // impressora, não segredo SNMP) e tem cobertura própria mais abaixo —
    // filtramos por aria-label em vez de aumentar o número esperado, para
    // este teste continuar falhando se um campo de segredo SNMP aparecer ou
    // desaparecer.
    const v3PasswordFields = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
    ).filter((input) => input.getAttribute('aria-label') !== 'Senha do painel web');
    expect(v3PasswordFields).toHaveLength(2);
    await user.type(v3PasswordFields[0], 'Unique-V3-Auth-Secret-88');
    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));
    await waitFor(() => expect(api.createPrinter).toHaveBeenCalledTimes(2));
    expectNoSecretInStorage('Unique-V3-Auth-Secret-88');

    // E depois de cancelar o formulário (campo limpo).
    await user.click(screen.getByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: public'), 'Unique-Community-Secret-99');
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expectNoSecretInStorage('Unique-Community-Secret-99');
  });

  it('leaves the secret field empty when editing, and omits snmp from the PATCH when left blank', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.updatePrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    await user.click(screen.getByRole('button', { name: /Editar/ }));

    const communityInput = screen.getByPlaceholderText('deixe em branco para manter a atual') as HTMLInputElement;
    expect(communityInput.value).toBe('');

    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    await waitFor(() => expect(api.updatePrinter).toHaveBeenCalled());
    const [, body] = vi.mocked(api.updatePrinter).mock.calls[0];
    expect(body.snmp).toBeUndefined();
  });

  // `v3AuthSchema.username` é obrigatório no backend (z.string().min(1)).
  // Como o bloco v3 é montado quando QUALQUER credencial v3 é preenchida,
  // digitar só a senha de autenticação enviaria `username: ''` e o usuário
  // levaria um 400 do zod sem entender qual campo faltou.
  it('blocks submit with a clear message when a v3 secret is typed without the required username', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([]);

    const user = userEvent.setup();
    renderPrinters();

    await user.click(await screen.findByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Impressora v3');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '22:33:44:55:66:77');
    await user.selectOptions(screen.getByDisplayValue('v2c'), 'v3');

    const passwordFields = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    await user.type(passwordFields[0], 'segredo-sem-usuario');
    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));

    expect(await screen.findByText(/usuário SNMPv3 é obrigatório/)).toBeInTheDocument();
    expect(api.createPrinter).not.toHaveBeenCalled();
  });

  // O backend só grava `snmpVersion` junto de `snmpSecret`: um PATCH que
  // omite `snmp` não muda a versão. Trocar o select e salvar sem digitar o
  // segredo retornaria 200 sem mudar nada — precisa ser barrado, não
  // reportado como sucesso.
  it('does not silently no-op when the SNMP version changes without a new secret', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    await user.click(screen.getByRole('button', { name: /Editar/ }));
    await user.selectOptions(screen.getByDisplayValue('v2c'), 'v3');
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    expect(await screen.findByText(/mudar a versão de SNMP de v2c para v3/)).toBeInTheDocument();
    expect(api.updatePrinter).not.toHaveBeenCalled();
  });

  it('deletes a printer after confirming', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.deletePrinter).mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    await user.click(screen.getByRole('button', { name: /Remover/ }));
    await waitFor(() => expect(api.deletePrinter).toHaveBeenCalledWith('p1'));
  });

  it('renames the UniFi alias with the correct mac and value', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.setClientAlias).mockResolvedValue({ ok: true });

    const user = userEvent.setup();
    renderPrinters();
    const card = (await screen.findByText('HPLaserMFP135w')).closest('div.overflow-hidden') as HTMLElement;

    await user.click(within(card).getByRole('button', { name: 'Renomear apelido no UniFi' }));
    const input = within(card).getByDisplayValue('HPLaserMFP135w');
    await user.clear(input);
    await user.type(input, 'Impressora Financeiro');
    await user.click(within(card).getByRole('button', { name: 'Salvar' }));

    await waitFor(() =>
      expect(api.setClientAlias).toHaveBeenCalledWith('50:81:40:d8:6c:7e', 'Impressora Financeiro'),
    );
  });

  it('shows an error message instead of crashing when listPrinters rejects', async () => {
    vi.mocked(api.listPrinters).mockRejectedValue(new Error('Falha ao carregar impressoras'));

    renderPrinters();

    expect(await screen.findByText('Falha ao carregar impressoras')).toBeInTheDocument();
  });

  it('refreshes the printer list after the polling interval passes, without re-showing "Carregando…"', async () => {
    vi.mocked(api.listPrinters).mockResolvedValueOnce([PRINTER_INTEGRATION]);

    // Fake timers precisam estar ativos ANTES do render: o `setInterval` do
    // usePolling é criado no primeiro efeito, e trocar pra fake timers DEPOIS
    // não assume o controle de um timer real já agendado.
    vi.useFakeTimers();

    renderPrinters();
    await flushMicrotasks();
    expect(screen.getByText('HPLaserMFP135w')).toBeInTheDocument();
    expect(screen.queryByText('HLL2360DWVENDAS')).not.toBeInTheDocument();

    vi.mocked(api.listPrinters).mockResolvedValueOnce([PRINTER_INTEGRATION, PRINTER_CLASSIC]);

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(screen.getByText('HLL2360DWVENDAS')).toBeInTheDocument();
    expect(screen.queryByText('Carregando…')).not.toBeInTheDocument();
  });

  // Regressão: o polling fica desligado com o FORMULÁRIO aberto, mas não durante remover/
  // reconectar (que usam `window.confirm`). Nessas ações, um refresh silencioso que já estava
  // em voo não pode resolver depois do `load()` da remoção e ressuscitar na tela a impressora
  // que acabou de sair do cadastro.
  it('does not resurrect a just-deleted printer with a stale in-flight poll response', async () => {
    vi.mocked(api.listPrinters).mockResolvedValueOnce([PRINTER_INTEGRATION, PRINTER_CLASSIC]);
    vi.useFakeTimers();

    renderPrinters();
    await flushMicrotasks();
    expect(screen.getByText('HLL2360DWVENDAS')).toBeInTheDocument();

    // Tick do polling: a listagem fica PENDENTE, ainda com as duas impressoras.
    let resolveStalePoll: (value: PrinterWithNetwork[]) => void = () => {};
    vi.mocked(api.listPrinters).mockImplementationOnce(
      () => new Promise((resolve) => { resolveStalePoll = resolve; }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    // Com o refresh em voo, o usuário remove a segunda impressora; o `load()` da mutação
    // responde primeiro.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(api.deletePrinter).mockResolvedValue(undefined as never);
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    const card = screen.getByText('HLL2360DWVENDAS').closest('div.overflow-hidden') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Remover' }));
      await flushMicrotasks();
    });
    expect(screen.queryByText('HLL2360DWVENDAS')).not.toBeInTheDocument();

    // Só agora a resposta atrasada (de antes da remoção) chega.
    await act(async () => {
      resolveStalePoll([PRINTER_INTEGRATION, PRINTER_CLASSIC]);
      await flushMicrotasks();
    });

    expect(screen.queryByText('HLL2360DWVENDAS')).not.toBeInTheDocument();
    expect(screen.getByText('HPLaserMFP135w')).toBeInTheDocument();
  });

  it('does not poll while the create/edit form is open (avoids the list shifting under the user mid-edit)', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);

    // Usa `fireEvent` (síncrono) em vez de `userEvent` aqui: `userEvent`
    // agenda seus próprios timers internos que não convivem bem com fake
    // timers globais, o que travava este teste. `fireEvent.click` dispara o
    // handler de clique diretamente, sem depender de nenhum timer.
    vi.useFakeTimers();

    renderPrinters();
    await flushMicrotasks();
    expect(screen.getByText('HPLaserMFP135w')).toBeInTheDocument();
    expect(api.listPrinters).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Nova impressora' }));
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    // O polling ficou desligado o tempo todo com o formulário aberto — nenhuma
    // nova chamada de listagem aconteceu além da carga inicial.
    expect(api.listPrinters).toHaveBeenCalledTimes(1);
  });

  // --- Reboot remoto (HP/SWS) + credencial do painel web ---

  it('calls rebootPrinter only after confirming, with a warning that says it restarts the physical device', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.rebootPrinter).mockResolvedValue({ ok: true, ipAddress: '172.16.0.89', ipOrigin: 'override' });

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(screen.getByRole('button', { name: /Reiniciar remotamente/ }));
    expect(api.rebootPrinter).not.toHaveBeenCalled();

    // O texto do aviso é a única proteção contra confundir este botão com o
    // "Reconectar" vizinho, que NÃO desliga nada — se ele deixar de dizer
    // que reinicia o equipamento físico, este teste falha.
    const message = String(confirmSpy.mock.calls[0][0]);
    expect(message).toMatch(/REINICIA O EQUIPAMENTO FÍSICO/);
    expect(message).toMatch(/Reconectar/);
    expect(message).toContain('HPLaserMFP135w');

    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: /Reiniciar remotamente/ }));
    await waitFor(() => expect(api.rebootPrinter).toHaveBeenCalledWith('p1'));

    // Mostra o alvo real da ação (o IP pode ter vindo do histórico do
    // controller — ver ipOrigin).
    expect(await screen.findByText(/Comando de reinício enviado.*172\.16\.0\.89.*override/)).toBeInTheDocument();
  });

  it('mostra o erro da API quando o reboot falha (ex.: 409 sem credencial cadastrada)', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.rebootPrinter).mockRejectedValue(new ApiError(409, 'Credencial do painel web não configurada'));

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: /Reiniciar remotamente/ }));

    expect(await screen.findByText('Credencial do painel web não configurada')).toBeInTheDocument();
  });

  it('envia wbmCredentials no cadastro quando usuário e senha do painel são informados', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([]);
    vi.mocked(api.createPrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();

    await user.click(await screen.findByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Nova Impressora');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '11:22:33:44:55:66');
    await user.type(screen.getByPlaceholderText('ex: public'), 'public');
    await user.type(screen.getByPlaceholderText('ex: admin'), 'admin');
    await user.type(screen.getByLabelText('Senha do painel web'), 'senha-do-painel');

    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));

    await waitFor(() =>
      expect(api.createPrinter).toHaveBeenCalledWith(
        expect.objectContaining({
          wbmCredentials: { username: 'admin', password: 'senha-do-painel' },
        }),
      ),
    );
  });

  it('aceita usuário do painel com senha em branco (padrão de fábrica da HP real)', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([]);
    vi.mocked(api.createPrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();

    await user.click(await screen.findByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Nova Impressora');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '11:22:33:44:55:66');
    await user.type(screen.getByPlaceholderText('ex: public'), 'public');
    await user.type(screen.getByPlaceholderText('ex: admin'), 'admin');

    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));

    await waitFor(() =>
      expect(api.createPrinter).toHaveBeenCalledWith(
        expect.objectContaining({ wbmCredentials: { username: 'admin', password: '' } }),
      ),
    );
  });

  it('não envia wbmCredentials quando nenhum dos dois campos foi preenchido', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([]);
    vi.mocked(api.createPrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();

    await user.click(await screen.findByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Nova Impressora');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '11:22:33:44:55:66');
    await user.type(screen.getByPlaceholderText('ex: public'), 'public');
    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));

    await waitFor(() => expect(api.createPrinter).toHaveBeenCalled());
    // `undefined` (e não `null`): omitir é o que o backend interpreta como
    // "sem credencial" no POST.
    expect(vi.mocked(api.createPrinter).mock.calls[0][0].wbmCredentials).toBeUndefined();
  });

  it('recusa senha do painel sem usuário, sem chamar a API (a senha não pode ser descartada em silêncio)', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([]);

    const user = userEvent.setup();
    renderPrinters();

    await user.click(await screen.findByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Nova Impressora');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '11:22:33:44:55:66');
    await user.type(screen.getByPlaceholderText('ex: public'), 'public');
    await user.type(screen.getByLabelText('Senha do painel web'), 'senha-orfa');
    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));

    expect(await screen.findByText(/Informe o usuário do painel web/)).toBeInTheDocument();
    expect(api.createPrinter).not.toHaveBeenCalled();
  });

  it('na edição, os campos do painel web nascem VAZIOS e omitir mantém a credencial atual', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.updatePrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    await user.click(screen.getByRole('button', { name: /Editar/ }));

    // O backend nunca devolve a credencial, então não há como repopular —
    // os campos precisam estar vazios (e não com um valor falso qualquer).
    expect(screen.getByPlaceholderText('deixe em branco para manter o atual')).toHaveValue('');
    expect(screen.getByLabelText('Senha do painel web')).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    await waitFor(() => expect(api.updatePrinter).toHaveBeenCalled());
    expect(vi.mocked(api.updatePrinter).mock.calls[0][1].wbmCredentials).toBeUndefined();
  });

  // ACHADO DO CRÍTICO: na edição, preencher SÓ o usuário do painel mandava
  // `password: ''` e apagava em silêncio a senha guardada (o backend aceita
  // senha vazia de propósito, e nunca devolve a credencial em leitura, então
  // nada nem ninguém percebia — a falha só apareceria depois, como um 403 no
  // reboot). Agora exige confirmação explícita.
  it('na edição, preencher só o usuário do painel exige confirmação antes de gravar senha em branco', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.updatePrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');
    await user.click(screen.getByRole('button', { name: /Editar/ }));

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.type(screen.getByPlaceholderText('deixe em branco para manter o atual'), 'operador');
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    // Cancelou: nada foi salvo (nem o resto do formulário, para não deixar a
    // impressão de que só a credencial ficou de fora).
    expect(api.updatePrinter).not.toHaveBeenCalled();
    const message = String(confirmSpy.mock.calls[0][0]);
    expect(message).toMatch(/SENHA EM BRANCO/);
    expect(message).toMatch(/perdida/);

    // Confirmou: aí sim grava a senha vazia (caso legítimo — o painel da HP
    // real está sem senha de fábrica).
    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    await waitFor(() => expect(api.updatePrinter).toHaveBeenCalled());
    expect(vi.mocked(api.updatePrinter).mock.calls[0][1].wbmCredentials).toEqual({
      username: 'operador',
      password: '',
    });
  });

  it('na edição, trocar usuário E senha do painel salva direto, sem confirmação', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.updatePrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');
    await user.click(screen.getByRole('button', { name: /Editar/ }));

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.type(screen.getByPlaceholderText('deixe em branco para manter o atual'), 'operador');
    await user.type(screen.getByLabelText('Senha do painel web'), 'senha-nova');
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    await waitFor(() => expect(api.updatePrinter).toHaveBeenCalled());
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(vi.mocked(api.updatePrinter).mock.calls[0][1].wbmCredentials).toEqual({
      username: 'operador',
      password: 'senha-nova',
    });
  });

  it('no CADASTRO, senha em branco não pede confirmação (não há nada a sobrescrever)', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([]);
    vi.mocked(api.createPrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(await screen.findByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Nova Impressora');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '11:22:33:44:55:66');
    await user.type(screen.getByPlaceholderText('ex: public'), 'public');
    await user.type(screen.getByPlaceholderText('ex: admin'), 'admin');
    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));

    await waitFor(() => expect(api.createPrinter).toHaveBeenCalled());
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('SEGURANÇA: a senha do painel web nunca é gravada em localStorage/sessionStorage', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([]);
    vi.mocked(api.createPrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();

    await user.click(await screen.findByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Nova Impressora');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '11:22:33:44:55:66');
    await user.type(screen.getByPlaceholderText('ex: public'), 'public');
    await user.type(screen.getByPlaceholderText('ex: admin'), 'admin');
    await user.type(screen.getByLabelText('Senha do painel web'), 'senha-do-painel-secreta');
    expectNoSecretInStorage('senha-do-painel-secreta');

    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));
    await waitFor(() => expect(api.createPrinter).toHaveBeenCalled());
    expectNoSecretInStorage('senha-do-painel-secreta');
  });
});
