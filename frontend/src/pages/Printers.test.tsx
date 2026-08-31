import { render, screen, waitFor, within } from '@testing-library/react';
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
      getPrinterConsumables: vi.fn(),
      setClientAlias: vi.fn(),
    },
    getAccessToken: () => null,
  };
});

import { api } from '../lib/api';

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

describe('Printers page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    mockSites();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders the printer list with the right network indicator for integration/classic/unknown sources', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION, PRINTER_CLASSIC, PRINTER_UNKNOWN]);

    renderPrinters();

    expect(await screen.findByText('HPLaserMFP135w')).toBeInTheDocument();
    expect(screen.getByText('HLL2360DWVENDAS')).toBeInTheDocument();
    expect(screen.getByText('BRW849E567E0445')).toBeInTheDocument();

    expect(screen.getByText(/Online · 172\.16\.0\.89/)).toBeInTheDocument();
    expect(screen.getByText(/Conhecida pelo controller · 172\.16\.0\.222/)).toBeInTheDocument();
    expect(screen.getByText('Status de rede desconhecido')).toBeInTheDocument();
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
    // Em v3 o campo `community` não é renderizado: os campos de senha são a
    // senha de autenticação e a de privacidade, nessa ordem.
    const v3PasswordFields = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
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
});
