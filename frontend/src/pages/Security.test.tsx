import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { Security } from './Security';

vi.mock('../lib/api', () => ({
  api: {
    listSites: vi.fn(),
    getSecuritySummary: vi.fn(),
    getSecurityEvents: vi.fn(),
    getAdmins: vi.fn(),
    getSshInfo: vi.fn(),
    rotateSshCredentials: vi.fn(),
  },
  getAccessToken: () => null,
}));

import { api } from '../lib/api';

function renderSecurity() {
  return render(
    <AuthProvider>
      <MemoryRouter>
        <Security />
      </MemoryRouter>
    </AuthProvider>,
  );
}

function mockHappyPathDefaults() {
  vi.mocked(api.listSites).mockResolvedValue({ data: [{ id: 's1', name: 'Site 1' }] });
  vi.mocked(api.getSecuritySummary).mockResolvedValue({
    threatsDetected: 0,
    ipsEnabled: true,
    signaturesActive: 10,
    upgradableDeviceCount: 0,
  });
  vi.mocked(api.getSecurityEvents).mockResolvedValue({ data: [] });
  vi.mocked(api.getAdmins).mockResolvedValue({ data: [] });
  vi.mocked(api.getSshInfo).mockResolvedValue({
    sshEnabled: true,
    sshUsername: 'admin-ssh',
    passwordAuthEnabled: true,
  });
}

// Flusha a fila de microtasks várias vezes seguidas — necessário com fake
// timers ativos, porque a carga inicial passa por mais de um `.then()` em
// cadeia (Layout carregando sites + Security carregando summary/events/
// admins/ssh em paralelo) e uma única volta de `advanceTimersByTimeAsync(0)`
// só libera um nível da cadeia por vez.
async function flushMicrotasks() {
  for (let i = 0; i < 10; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

describe('Security page - SSH password rotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    mockHappyPathDefaults();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('shows the new password on screen after confirming rotation', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(api.rotateSshCredentials).mockResolvedValue({
      sshUsername: 'admin-ssh',
      sshPassword: 'S3cr3tP@ss-XYZ',
    });

    const user = userEvent.setup();
    renderSecurity();

    const button = await screen.findByRole('button', { name: 'Gerar nova senha' });
    await user.click(button);

    expect(await screen.findByText('S3cr3tP@ss-XYZ')).toBeInTheDocument();
    expect(screen.getByText('Copie agora — essa senha não vai aparecer de novo.')).toBeInTheDocument();
  });

  it('NEVER persists the generated password in localStorage or sessionStorage', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(api.rotateSshCredentials).mockResolvedValue({
      sshUsername: 'admin-ssh',
      sshPassword: 'Un1queSecretValue-42',
    });

    const user = userEvent.setup();
    renderSecurity();

    const button = await screen.findByRole('button', { name: 'Gerar nova senha' });
    await user.click(button);

    await screen.findByText('Un1queSecretValue-42');

    const localStorageDump = JSON.stringify(localStorage);
    const sessionStorageDump = JSON.stringify(sessionStorage);

    expect(localStorageDump).not.toContain('Un1queSecretValue-42');
    expect(sessionStorageDump).not.toContain('Un1queSecretValue-42');
  });

  it('does not show the password again after unmount + remount (nothing persisted to hydrate from)', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(api.rotateSshCredentials).mockResolvedValue({
      sshUsername: 'admin-ssh',
      sshPassword: 'GoneAfterUnmount-99',
    });

    const user = userEvent.setup();
    const { unmount } = renderSecurity();

    const button = await screen.findByRole('button', { name: 'Gerar nova senha' });
    await user.click(button);
    await screen.findByText('GoneAfterUnmount-99');

    unmount();

    renderSecurity();
    await screen.findByRole('button', { name: 'Gerar nova senha' });
    expect(screen.queryByText('GoneAfterUnmount-99')).not.toBeInTheDocument();
  });

  it('does not call rotateSshCredentials when the confirmation dialog is cancelled', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(false);

    const user = userEvent.setup();
    renderSecurity();

    const button = await screen.findByRole('button', { name: 'Gerar nova senha' });
    await user.click(button);

    await waitFor(() => expect(window.confirm).toHaveBeenCalled());
    expect(api.rotateSshCredentials).not.toHaveBeenCalled();
    expect(screen.queryByText('Copie agora — essa senha não vai aparecer de novo.')).not.toBeInTheDocument();
  });

  it('shows an error message instead of hanging when rotation fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(api.rotateSshCredentials).mockRejectedValue(new Error('Falha ao trocar a senha'));

    const user = userEvent.setup();
    renderSecurity();

    const button = await screen.findByRole('button', { name: 'Gerar nova senha' });
    await user.click(button);

    expect(await screen.findByText('Falha ao trocar a senha')).toBeInTheDocument();
    expect(screen.queryByText('Copie agora — essa senha não vai aparecer de novo.')).not.toBeInTheDocument();
  });

  // A senha SSH recém-gerada é mostrada UMA ÚNICA VEZ e não é recuperável. Um tick do polling
  // (que recarrega summary/events/admins E `sshInfo`) logo depois da rotação não pode fazer o
  // bloco com a senha desaparecer da tela nem virar uma mensagem de erro — o usuário perderia
  // a credencial dos APs sem entender por quê. Também cobre a falha da atualização silenciosa.
  it('keeps the just-generated SSH password on screen across polling ticks, even if the silent refresh fails', async () => {
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.mocked(api.rotateSshCredentials).mockResolvedValue({
      sshUsername: 'admin-ssh',
      sshPassword: 'Senha-Que-Nao-Pode-Sumir-77',
    });

    vi.useFakeTimers();
    renderSecurity();
    await flushMicrotasks();

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Gerar nova senha' }));
      await flushMicrotasks();
    });
    expect(screen.getByText('Senha-Que-Nao-Pode-Sumir-77')).toBeInTheDocument();

    // Dois ciclos de polling, o segundo com TODAS as chamadas falhando.
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();
    expect(screen.getByText('Senha-Que-Nao-Pode-Sumir-77')).toBeInTheDocument();

    vi.mocked(api.getSshInfo).mockRejectedValue(new Error('controller fora do ar'));
    vi.mocked(api.getSecuritySummary).mockRejectedValue(new Error('controller fora do ar'));
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(screen.getByText('Senha-Que-Nao-Pode-Sumir-77')).toBeInTheDocument();
    expect(screen.getByText('Copie agora — essa senha não vai aparecer de novo.')).toBeInTheDocument();
    expect(screen.queryByText('controller fora do ar')).not.toBeInTheDocument();
    // O usuário atual (dado já carregado) continua na tela, não é apagado pela falha
    // silenciosa — aparece nos dois lugares: "Usuário atual" e o bloco da senha nova.
    expect(screen.getAllByText('admin-ssh')).toHaveLength(2);
  });

  it('refreshes critical events/admins after the polling interval passes, without re-showing "Carregando…"', async () => {
    vi.mocked(api.getSecurityEvents).mockResolvedValueOnce({ data: [{ msg: 'Evento inicial' }] });

    // Fake timers precisam estar ativos ANTES do render: o `setInterval` do
    // usePolling é criado no primeiro efeito, e trocar pra fake timers DEPOIS
    // não assume o controle de um timer real já agendado.
    vi.useFakeTimers();

    renderSecurity();
    await flushMicrotasks();
    expect(screen.getByText('Evento inicial')).toBeInTheDocument();

    vi.mocked(api.getSecurityEvents).mockResolvedValueOnce({ data: [{ msg: 'Evento após polling' }] });

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(screen.getByText('Evento após polling')).toBeInTheDocument();
    expect(screen.queryByText('Evento inicial')).not.toBeInTheDocument();
    expect(screen.queryByText('Carregando…')).not.toBeInTheDocument();
  });
});
