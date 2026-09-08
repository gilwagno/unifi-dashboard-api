import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { Networks } from './Networks';

vi.mock('../lib/api', () => ({
  api: {
    listSites: vi.fn(),
    listWifi: vi.fn(),
    listNetworks: vi.fn(),
    listFirewallZones: vi.fn(),
    listRadiusProfiles: vi.fn(),
    createWifi: vi.fn(),
    setWifiPassword: vi.fn(),
    setWifiEnabled: vi.fn(),
    deleteWifi: vi.fn(),
    createNetwork: vi.fn(),
    deleteNetwork: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
  getAccessToken: () => null,
}));

import { api } from '../lib/api';

function renderNetworks() {
  return render(
    <AuthProvider>
      <MemoryRouter>
        <Networks />
      </MemoryRouter>
    </AuthProvider>,
  );
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

const WIFI = { id: 'w1', name: 'Escritorio', enabled: true };
const VLAN_IOT = { id: 'n1', name: 'IOT', vlanId: 10, ipv4Configuration: { hostIpAddress: '10.30.0.1', prefixLength: 24 } };

function mockLists(networks: unknown[]) {
  vi.mocked(api.listWifi).mockResolvedValue({ data: [WIFI] } as never);
  vi.mocked(api.listNetworks).mockResolvedValue({ data: networks } as never);
  vi.mocked(api.listFirewallZones).mockResolvedValue({ data: [{ id: 'z1', name: 'Internal' }] } as never);
  vi.mocked(api.listRadiusProfiles).mockResolvedValue({ data: [] } as never);
}

describe('Networks page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listSites).mockResolvedValue({ data: [{ id: 's1', name: 'Site 1' }] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('refreshes the lists after the polling interval passes, without re-showing "Carregando…"', async () => {
    mockLists([VLAN_IOT]);
    vi.useFakeTimers();

    renderNetworks();
    await flushMicrotasks();
    expect(screen.getByText('IOT')).toBeInTheDocument();

    vi.mocked(api.listNetworks).mockResolvedValue({ data: [VLAN_IOT, { ...VLAN_IOT, id: 'n2', name: 'CFTV' }] } as never);
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(screen.getByText('CFTV')).toBeInTheDocument();
    expect(screen.queryByText('Carregando…')).not.toBeInTheDocument();
  });

  // Regressão: remover uma VLAN dispara `load()`; se um refresh silencioso do polling já
  // estava em voo com o retrato ANTERIOR, a resposta atrasada dele não pode ressuscitar a
  // VLAN removida na tela (ficaria mentindo por até 60s, até o ciclo seguinte).
  it('does not resurrect a just-deleted VLAN with a stale in-flight poll response', async () => {
    mockLists([VLAN_IOT]);
    vi.useFakeTimers();

    renderNetworks();
    await flushMicrotasks();
    expect(screen.getByText('IOT')).toBeInTheDocument();

    // Tick do polling: a listagem de VLANs fica PENDENTE, ainda com a VLAN presente.
    let resolveStaleNetworks: (value: unknown) => void = () => {};
    vi.mocked(api.listNetworks).mockImplementationOnce(
      () => new Promise((resolve) => { resolveStaleNetworks = resolve; }) as never,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    // Com o refresh em voo, o usuário remove a VLAN; o `load()` da mutação responde primeiro.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(api.deleteNetwork).mockResolvedValue(undefined as never);
    vi.mocked(api.listNetworks).mockResolvedValue({ data: [] } as never);
    await act(async () => {
      fireEvent.click(screen.getAllByRole('button', { name: 'Remover' })[1]);
      await flushMicrotasks();
    });
    expect(screen.getByText('Nenhuma VLAN encontrada.')).toBeInTheDocument();

    // Só agora a resposta atrasada (de antes da remoção) chega.
    await act(async () => {
      resolveStaleNetworks({ data: [VLAN_IOT] });
      await flushMicrotasks();
    });

    expect(screen.queryByText('IOT')).not.toBeInTheDocument();
    expect(screen.getByText('Nenhuma VLAN encontrada.')).toBeInTheDocument();
  });

  // Regressão: o editor inline de senha do Wi-Fi vive dentro da linha da rede, então um
  // refresh que reordene/remova a linha desmonta o campo e joga fora a passphrase digitada.
  it('does not poll while the inline Wi-Fi password editor is open', async () => {
    mockLists([VLAN_IOT]);
    vi.useFakeTimers();

    renderNetworks();
    await flushMicrotasks();
    expect(api.listWifi).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Trocar senha' }));
    });
    act(() => {
      fireEvent.change(screen.getByPlaceholderText('nova senha'), { target: { value: 'senha-parcialmente-digi' } });
    });

    await vi.advanceTimersByTimeAsync(180_000);
    await flushMicrotasks();

    expect(api.listWifi).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText('nova senha')).toHaveValue('senha-parcialmente-digi');

    // Cancelar fecha o editor e o polling volta a rodar.
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Cancelar' }));
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(api.listWifi).toHaveBeenCalledTimes(2);
  });
});
