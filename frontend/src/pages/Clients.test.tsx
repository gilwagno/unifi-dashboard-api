import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { Clients } from './Clients';

vi.mock('../lib/api', () => ({
  api: {
    listSites: vi.fn(),
    listClients: vi.fn(),
    blockClient: vi.fn(),
    unblockClient: vi.fn(),
    setClientFixedIp: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
  getAccessToken: () => null,
}));

import { api, type UniFiClient } from '../lib/api';

function renderClients() {
  return render(
    <AuthProvider>
      <MemoryRouter>
        <Clients />
      </MemoryRouter>
    </AuthProvider>,
  );
}

async function flushMicrotasks() {
  for (let i = 0; i < 10; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

function client(id: string, name: string): UniFiClient {
  return {
    id,
    name,
    hostname: name,
    macAddress: `aa:bb:cc:00:00:0${id}`,
    ipAddress: '172.16.0.50',
    type: 'WIRELESS',
    blocked: false,
  };
}

function pageOf(page: number) {
  return { page, pageSize: 8, total: 16, totalPages: 2 };
}

describe('Clients page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listSites).mockResolvedValue({ data: [{ id: 's1', name: 'Site 1' }] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('refreshes the client list after the polling interval passes, without re-showing "Carregando…"', async () => {
    vi.mocked(api.listClients).mockResolvedValueOnce({ data: [client('1', 'NOME-ANTIGO')], pagination: pageOf(1) });
    vi.useFakeTimers();

    renderClients();
    await flushMicrotasks();
    expect(screen.getByText('NOME-ANTIGO')).toBeInTheDocument();

    vi.mocked(api.listClients).mockResolvedValueOnce({ data: [client('1', 'NOME-NOVO')], pagination: pageOf(1) });
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(screen.getByText('NOME-NOVO')).toBeInTheDocument();
    expect(screen.queryByText('Carregando…')).not.toBeInTheDocument();
  });

  // Regressão: a resposta atrasada de um refresh silencioso que já estava em voo não pode
  // sobrescrever a lista carregada por uma TROCA DE FILTRO feita depois dele.
  it('discards a stale in-flight poll response when the user changes the filter while it is pending', async () => {
    vi.mocked(api.listClients).mockResolvedValueOnce({ data: [client('1', 'TODOS')], pagination: pageOf(1) });
    vi.useFakeTimers();

    renderClients();
    await flushMicrotasks();
    expect(screen.getByText('TODOS')).toBeInTheDocument();

    let resolveStalePoll: (value: unknown) => void = () => {};
    vi.mocked(api.listClients).mockImplementationOnce(
      () => new Promise((resolve) => { resolveStalePoll = resolve; }) as never,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    vi.mocked(api.listClients).mockResolvedValueOnce({ data: [client('2', 'SO-CABO')], pagination: pageOf(1) });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Cabo' }));
    });
    await flushMicrotasks();
    expect(screen.getByText('SO-CABO')).toBeInTheDocument();

    await act(async () => {
      resolveStalePoll({ data: [client('1', 'TODOS')], pagination: pageOf(1) });
      await flushMicrotasks();
    });

    expect(screen.getByText('SO-CABO')).toBeInTheDocument();
    expect(screen.queryByText('TODOS')).not.toBeInTheDocument();
  });

  // Regressão: o editor inline de IP fixo vive dentro da linha do cliente, então um refresh
  // que remova/reordene aquela linha desmonta o campo e joga fora o IP digitado.
  it('does not poll while the inline fixed-IP editor is open', async () => {
    vi.mocked(api.listClients).mockResolvedValue({ data: [client('1', 'IMPRESSORA')], pagination: pageOf(1) });
    vi.useFakeTimers();

    renderClients();
    await flushMicrotasks();
    expect(api.listClients).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'IP fixo' }));
    });
    const editor = screen.getByPlaceholderText('172.16.0.50');
    act(() => {
      fireEvent.change(editor, { target: { value: '172.16.0.99' } });
    });

    await vi.advanceTimersByTimeAsync(180_000);
    await flushMicrotasks();

    // Nenhuma nova listagem enquanto o editor está aberto, e o IP digitado continua lá.
    expect(api.listClients).toHaveBeenCalledTimes(1);
    expect(screen.getByPlaceholderText('172.16.0.50')).toHaveValue('172.16.0.99');

    // Ao fechar o editor, o polling volta a rodar.
    act(() => {
      fireEvent.click(within(screen.getByText(/Reserva de DHCP/).parentElement as HTMLElement).getByRole('button', { name: 'Fechar' }));
    });
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(api.listClients).toHaveBeenCalledTimes(2);
  });
});
