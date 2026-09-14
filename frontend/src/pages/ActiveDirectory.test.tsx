import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { ActiveDirectory } from './ActiveDirectory';
import type { AdComputer, AdGroup, AdUser } from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: {
      listSites: vi.fn(async () => ({ data: [] })),
      listAdUsers: vi.fn(async () => ({ data: [] })),
      setAdUserEnabled: vi.fn(),
      unlockAdUser: vi.fn(),
      listAdGroups: vi.fn(async () => ({ data: [] })),
      getAdGroup: vi.fn(),
      listAdComputers: vi.fn(async () => ({ data: [] })),
      setAdComputerEnabled: vi.fn(),
    },
    getAccessToken: () => null,
  };
});

const { api } = await import('../lib/api');

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <ActiveDirectory />
      </AuthProvider>
    </MemoryRouter>,
  );
}

const USUARIO: AdUser = {
  dn: 'CN=jsilva,OU=Users,DC=test,DC=local',
  sAMAccountName: 'jsilva',
  displayName: 'João Silva',
  mail: 'joao@test.local',
  department: 'TI',
  title: 'Analista',
  enabled: true,
  lockedOut: false,
  userWorkstations: [],
};

const COMPUTADOR: AdComputer = {
  dn: 'CN=EA-PC-01,CN=Computers,DC=test,DC=local',
  name: 'EA-PC-01',
  sAMAccountName: 'EA-PC-01$',
  dnsHostName: 'ea-pc-01.test.local',
  operatingSystem: 'Windows 11 Pro',
  operatingSystemVersion: '10.0',
  description: null,
  enabled: true,
  isDomainController: false,
};

beforeEach(() => {
  vi.mocked(api.listAdUsers).mockReset().mockResolvedValue({ data: [] });
  vi.mocked(api.listAdGroups).mockReset().mockResolvedValue({ data: [] });
  vi.mocked(api.listAdComputers).mockReset().mockResolvedValue({ data: [] });
  vi.mocked(api.getAdGroup).mockReset();
  vi.mocked(api.setAdUserEnabled).mockReset().mockResolvedValue({ ok: true });
  vi.mocked(api.setAdComputerEnabled).mockReset().mockResolvedValue({ ok: true });
});

describe('ActiveDirectory — usuários', () => {
  it('lista os usuários do diretório', async () => {
    vi.mocked(api.listAdUsers).mockResolvedValue({ data: [USUARIO] });
    renderPage();

    expect(await screen.findByText('João Silva')).toBeInTheDocument();
  });

  // O backend devolve TRÊS estados e recusa escrever quando não conseguiu
  // ler o `userAccountControl`. Se a tela colapsasse `null` em
  // "desabilitada", desfaria essa honestidade no último metro — que é onde
  // a pessoa decide. E o botão ficaria oferecendo uma ação que o backend
  // recusaria.
  it('estado ILEGÍVEL não vira "desabilitada" — e a ação fica indisponível', async () => {
    vi.mocked(api.listAdUsers).mockResolvedValue({ data: [{ ...USUARIO, enabled: null }] });
    renderPage();

    expect(await screen.findByText('Não foi possível ler')).toBeInTheDocument();
    expect(screen.queryByText('Desabilitada')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Habilitar' })).toBeDisabled();
  });

  it('desabilitar chama o serviço com `false`', async () => {
    vi.mocked(api.listAdUsers).mockResolvedValue({ data: [USUARIO] });
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Desabilitar' }));

    await waitFor(() => expect(api.setAdUserEnabled).toHaveBeenCalledWith('jsilva', false));
  });

  it('falha da operação aparece como ERRO, não como aviso neutro', async () => {
    vi.mocked(api.listAdUsers).mockResolvedValue({ data: [USUARIO] });
    vi.mocked(api.setAdUserEnabled).mockRejectedValue(new Error('boom'));
    renderPage();

    await userEvent.click(await screen.findByRole('button', { name: 'Desabilitar' }));

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  });
});

describe('ActiveDirectory — grupos', () => {
  // Restrição não-negociável: `searchGroups()` sem filtro devolve o domínio
  // inteiro (68 grupos no domínio real, incluindo `Admins. do domínio` e
  // todo o `CN=Builtin`), e o backend não pagina. Uma tela que lista tudo ao
  // abrir despeja a estrutura de privilégios do domínio numa página só.
  it('NÃO busca nada ao abrir a aba — exige um termo', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Grupos/ }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Buscar' })).toBeDisabled());
    expect(api.listAdGroups).not.toHaveBeenCalled();
  });

  // Só espaços NÃO habilita a busca — sem o `.trim()`, "   " passaria pelo
  // `!busca.trim()` do botão e a requisição sairia com um termo em branco.
  it('campo com só espaços mantém a busca indisponível', async () => {
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Grupos/ }));

    await userEvent.type(screen.getByLabelText('Buscar grupo'), '   ');

    expect(screen.getByRole('button', { name: 'Buscar' })).toBeDisabled();
    expect(api.listAdGroups).not.toHaveBeenCalled();
  });

  it('busca só depois de um termo, e repassa o termo', async () => {
    const grupo: AdGroup = { dn: 'CN=Financeiro,DC=t', cn: 'Financeiro', description: null, members: [] };
    vi.mocked(api.listAdGroups).mockResolvedValue({ data: [grupo] });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Grupos/ }));

    await userEvent.type(screen.getByLabelText('Buscar grupo'), 'finan');
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));

    await waitFor(() => expect(api.listAdGroups).toHaveBeenCalledWith('finan'));
  });

  // O CORAÇÃO desta tela. Medido no domínio real: 69 pessoas com acesso à
  // rede, das quais o dashboard revogaria 8 — as outras 61 entram por grupos
  // aninhados e a remoção direta devolve SUCESSO sem revogar nada. Se a tela
  // mostrasse uma lista uniforme de "membros", o bug de produção seguiria
  // existindo na prática mesmo com o backend correto.
  it('distingue VISUALMENTE membro direto de acesso herdado por aninhamento', async () => {
    const grupo: AdGroup = { dn: 'CN=Acesso,DC=t', cn: 'Acesso', description: null, members: [] };
    vi.mocked(api.listAdGroups).mockResolvedValue({ data: [grupo] });
    vi.mocked(api.getAdGroup).mockResolvedValue({
      ...grupo,
      members: ['CN=jsilva,DC=t', 'CN=G-Comercial,DC=t'],
      memberDetails: [
        { dn: 'CN=jsilva,DC=t', name: 'jsilva', type: 'user' },
        { dn: 'CN=G-Comercial,DC=t', name: 'G-Comercial', type: 'group' },
      ],
    });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Grupos/ }));
    await userEvent.type(screen.getByLabelText('Buscar grupo'), 'acesso');
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Ver membros' }));

    // Os dois membros existem, mas com rótulos DIFERENTES — não uma lista
    // uniforme onde os dois parecem a mesma coisa.
    expect(await screen.findByText('Membro direto')).toBeInTheDocument();
    expect(screen.getByText('Grupo · acesso herdado')).toBeInTheDocument();
  });

  it('avisa explicitamente que remover não revoga o acesso herdado', async () => {
    const grupo: AdGroup = { dn: 'CN=Acesso,DC=t', cn: 'Acesso', description: null, members: [] };
    vi.mocked(api.listAdGroups).mockResolvedValue({ data: [grupo] });
    vi.mocked(api.getAdGroup).mockResolvedValue({
      ...grupo,
      members: ['CN=G-Comercial,DC=t'],
      memberDetails: [{ dn: 'CN=G-Comercial,DC=t', name: 'G-Comercial', type: 'group' }],
    });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Grupos/ }));
    await userEvent.type(screen.getByLabelText('Buscar grupo'), 'acesso');
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Ver membros' }));

    const aviso = await screen.findByRole('alert');
    expect(within(aviso).getByText(/não revoga esse acesso herdado/i)).toBeInTheDocument();
  });

  it('grupo SEM aninhamento não mostra o aviso — senão o alerta vira ruído', async () => {
    const grupo: AdGroup = { dn: 'CN=Acesso,DC=t', cn: 'Acesso', description: null, members: [] };
    vi.mocked(api.listAdGroups).mockResolvedValue({ data: [grupo] });
    vi.mocked(api.getAdGroup).mockResolvedValue({
      ...grupo,
      members: ['CN=jsilva,DC=t'],
      memberDetails: [{ dn: 'CN=jsilva,DC=t', name: 'jsilva', type: 'user' }],
    });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Grupos/ }));
    await userEvent.type(screen.getByLabelText('Buscar grupo'), 'acesso');
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Ver membros' }));

    expect(await screen.findByText('Membro direto')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('membro NÃO RESOLVIDO aparece como tal, nunca como pessoa comum', async () => {
    const grupo: AdGroup = { dn: 'CN=Acesso,DC=t', cn: 'Acesso', description: null, members: [] };
    vi.mocked(api.listAdGroups).mockResolvedValue({ data: [grupo] });
    vi.mocked(api.getAdGroup).mockResolvedValue({
      ...grupo,
      members: ['CN=Fantasma,DC=t'],
      memberDetails: [{ dn: 'CN=Fantasma,DC=t', name: 'Fantasma', type: 'unknown' }],
    });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Grupos/ }));
    await userEvent.type(screen.getByLabelText('Buscar grupo'), 'acesso');
    await userEvent.click(screen.getByRole('button', { name: 'Buscar' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Ver membros' }));

    expect(await screen.findByText('Não resolvido')).toBeInTheDocument();
    expect(screen.queryByText('Membro direto')).not.toBeInTheDocument();
  });
});

describe('ActiveDirectory — computadores', () => {
  it('lista os computadores', async () => {
    vi.mocked(api.listAdComputers).mockResolvedValue({ data: [COMPUTADOR] });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Computadores/ }));

    expect(await screen.findByText('EA-PC-01')).toBeInTheDocument();
  });

  it('marca visualmente o CONTROLADOR DE DOMÍNIO', async () => {
    vi.mocked(api.listAdComputers).mockResolvedValue({
      data: [{ ...COMPUTADOR, name: 'EA-SRV-AD01', isDomainController: true }],
    });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Computadores/ }));

    expect(await screen.findByText('Controlador de domínio')).toBeInTheDocument();
  });

  // Desabilitar a conta quebra o canal seguro da máquina com o domínio. Sem
  // confirmação, é um clique acidental entre "listar" e "derrubar máquina".
  it('desabilitar EXIGE confirmação — cancelar não chama o serviço', async () => {
    vi.mocked(api.listAdComputers).mockResolvedValue({ data: [COMPUTADOR] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Computadores/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Desabilitar conta' }));

    expect(confirm).toHaveBeenCalled();
    expect(api.setAdComputerEnabled).not.toHaveBeenCalled();
    confirm.mockRestore();
  });

  it('a confirmação de um DC avisa que derruba o domínio', async () => {
    vi.mocked(api.listAdComputers).mockResolvedValue({
      data: [{ ...COMPUTADOR, name: 'EA-SRV-AD01', isDomainController: true }],
    });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false);
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Computadores/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Desabilitar conta' }));

    expect(confirm.mock.calls[0][0]).toMatch(/CONTROLADOR DE DOMÍNIO/);
    confirm.mockRestore();
  });

  // HABILITAR não é destrutivo e não deve pedir confirmação — senão a
  // confirmação vira ritual e o operador clica em "ok" sem ler, inclusive
  // no caso que importa.
  it('habilitar NÃO pede confirmação', async () => {
    vi.mocked(api.listAdComputers).mockResolvedValue({ data: [{ ...COMPUTADOR, enabled: false }] });
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true);
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Computadores/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Habilitar conta' }));

    expect(confirm).not.toHaveBeenCalled();
    await waitFor(() => expect(api.setAdComputerEnabled).toHaveBeenCalledWith('EA-PC-01', true));
    confirm.mockRestore();
  });

  it('estado ilegível deixa a ação indisponível', async () => {
    vi.mocked(api.listAdComputers).mockResolvedValue({ data: [{ ...COMPUTADOR, enabled: null }] });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: /Computadores/ }));

    expect(await screen.findByRole('button', { name: 'Habilitar conta' })).toBeDisabled();
  });
});
