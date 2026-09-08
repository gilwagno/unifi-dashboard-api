import { act, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { Devices } from './Devices';

vi.mock('../lib/api', () => ({
  api: {
    listSites: vi.fn(),
    listDevices: vi.fn(),
    getDevice: vi.fn(),
    restartDevice: vi.fn(),
    powerCyclePort: vi.fn(),
  },
  ApiError: class ApiError extends Error {},
  getAccessToken: () => null,
}));

import { api } from '../lib/api';

function renderDevices() {
  return render(
    <AuthProvider>
      <MemoryRouter>
        <Devices />
      </MemoryRouter>
    </AuthProvider>,
  );
}

// Mesmo helper das outras páginas: com fake timers ativos, a carga inicial passa
// por mais de um `.then()` em cadeia (Layout carregando sites + a página
// carregando a lista), e uma única volta de `advanceTimersByTimeAsync(0)` só
// libera um nível da cadeia por vez.
async function flushMicrotasks() {
  for (let i = 0; i < 10; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

function device(id: string, name: string) {
  return { id, name, model: 'U6-Lite', macAddress: `aa:bb:cc:00:00:0${id}`, ipAddress: '172.16.0.10', state: 'ONLINE' };
}

function pageOf(page: number) {
  return { page, pageSize: 8, total: 16, totalPages: 2 };
}

describe('Devices page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(api.listSites).mockResolvedValue({ data: [{ id: 's1', name: 'Site 1' }] });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('refreshes the device list after the polling interval passes, without re-showing "Carregando…"', async () => {
    vi.mocked(api.listDevices).mockResolvedValueOnce({ data: [device('1', 'AP-ANTIGO')], pagination: pageOf(1) });
    vi.useFakeTimers();

    renderDevices();
    await flushMicrotasks();
    expect(screen.getByText('AP-ANTIGO')).toBeInTheDocument();

    vi.mocked(api.listDevices).mockResolvedValueOnce({ data: [device('1', 'AP-RENOMEADO')], pagination: pageOf(1) });
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(screen.getByText('AP-RENOMEADO')).toBeInTheDocument();
    expect(screen.queryByText('Carregando…')).not.toBeInTheDocument();
  });

  // Cenário do vazamento entre páginas: o usuário sai de Dispositivos (navega pra outra tela)
  // enquanto um refresh do polling está em voo. Nem o timer nem o listener de visibilidade
  // podem sobreviver ao unmount, e a resposta atrasada não pode gerar aviso do React nem
  // qualquer escrita de estado em componente desmontado.
  it('leaves nothing behind when unmounted with a poll request still in flight', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(api.listDevices).mockResolvedValueOnce({ data: [device('1', 'AP-1')], pagination: pageOf(1) });
    vi.useFakeTimers();

    const { unmount } = renderDevices();
    await flushMicrotasks();

    let resolveInFlight: (value: unknown) => void = () => {};
    vi.mocked(api.listDevices).mockImplementationOnce(
      () => new Promise((resolve) => { resolveInFlight = resolve; }) as never,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(api.listDevices).toHaveBeenCalledTimes(2);

    unmount();

    // A resposta atrasada chega depois do unmount, e a aba volta do segundo plano depois
    // disso: nenhuma requisição nova, nenhum aviso do React.
    await act(async () => {
      resolveInFlight({ data: [device('1', 'AP-1')], pagination: pageOf(1) });
      await flushMicrotasks();
    });
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(120_000);
    await flushMicrotasks();

    expect(api.listDevices).toHaveBeenCalledTimes(2);
    expect(consoleError).not.toHaveBeenCalled();
  });

  // Regressão: um refresh silencioso do polling que já estava EM VOO quando o
  // usuário troca de página não pode aplicar sua resposta atrasada por cima da
  // página nova — senão a lista (e o rótulo de paginação) volta pra página
  // anterior sozinha e fica errada até o próximo ciclo de 60s.
  it('discards a stale in-flight poll response when the user changes page while it is pending', async () => {
    vi.mocked(api.listDevices).mockResolvedValueOnce({ data: [device('1', 'DA-PAGINA-1')], pagination: pageOf(1) });
    vi.useFakeTimers();

    renderDevices();
    await flushMicrotasks();
    expect(screen.getByText('DA-PAGINA-1')).toBeInTheDocument();

    // O tick de 60s dispara um refresh silencioso da página 1 que fica PENDENTE.
    let resolveStalePoll: (value: unknown) => void = () => {};
    vi.mocked(api.listDevices).mockImplementationOnce(
      () => new Promise((resolve) => { resolveStalePoll = resolve; }) as never,
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    // Com o refresh em voo, o usuário avança pra página 2, que responde primeiro.
    vi.mocked(api.listDevices).mockResolvedValueOnce({ data: [device('2', 'DA-PAGINA-2')], pagination: pageOf(2) });
    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Próximo' }));
    });
    await flushMicrotasks();
    expect(screen.getByText('DA-PAGINA-2')).toBeInTheDocument();

    // Só agora a resposta atrasada da página 1 chega.
    await act(async () => {
      resolveStalePoll({ data: [device('1', 'DA-PAGINA-1')], pagination: pageOf(1) });
      await flushMicrotasks();
    });

    expect(screen.getByText('DA-PAGINA-2')).toBeInTheDocument();
    expect(screen.queryByText('DA-PAGINA-1')).not.toBeInTheDocument();
    expect(screen.getByText(/Página 2 de 2/)).toBeInTheDocument();
  });
});
