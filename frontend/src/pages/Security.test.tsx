import { render, screen, waitFor } from '@testing-library/react';
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

describe('Security page - SSH password rotation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    mockHappyPathDefaults();
  });

  afterEach(() => {
    vi.restoreAllMocks();
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
});
