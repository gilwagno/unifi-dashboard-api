import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { RemoteAccess } from './RemoteAccess';
import type { RemoteAccessComputer } from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: {
      listSites: vi.fn(async () => ({ data: [] })),
      listRemoteAccessComputers: vi.fn(async () => ({ data: [] })),
      syncRemoteAccess: vi.fn(),
      openRemoteSession: vi.fn(),
    },
    getAccessToken: () => null,
  };
});

const { api } = await import('../lib/api');

const TOKEN_DA_PESSOA = 'TOKEN-QUE-NAO-PODE-VAZAR';
const URL_DA_SESSAO = `http://guacamole.test/guacamole/#/client/MTA=?token=${TOKEN_DA_PESSOA}`;

const PC: RemoteAccessComputer = {
  name: 'EA-PC-COR01',
  objectGuid: '3be39b9e-4f29-4349-a008-b7fbcac6f35c',
  dnsHostName: 'ea-pc-cor01.evokaudio.local',
  operatingSystem: 'Windows 11 Pro',
  enabled: true,
  hasAccess: true,
  connectionIdentifier: '10',
  activeSessions: 0,
};

const PC_SEM_ACESSO: RemoteAccessComputer = {
  ...PC,
  name: 'EA-PC-SEM',
  // dnsHostName PRÓPRIO: herdando o do PC pelo spread, o filtro por "COR01"
  // casava nos dois e o teste de busca falhava por bug do fixture, não do
  // código. Vale como lembrete de que o spread copia o que não se pensou.
  dnsHostName: 'ea-pc-sem.evokaudio.local',
  objectGuid: 'df268070-22ab-4781-8465-7eb4bc790a2b',
  hasAccess: false,
  connectionIdentifier: null,
};

/** O botão da LINHA de um computador — há um por linha, então buscar
 * globalmente por papel encontraria mais de um. */
function botaoAbrir(nome: string) {
  const linha = screen.getByText(nome).closest('li')!;
  return within(linha).getByRole('button', { name: /abrir sessão/i });
}

function renderPage() {
  return render(
    <MemoryRouter>
      <AuthProvider>
        <RemoteAccess />
      </AuthProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.mocked(api.listRemoteAccessComputers).mockReset();
  vi.mocked(api.openRemoteSession).mockReset();
  vi.mocked(api.syncRemoteAccess).mockReset();
  vi.mocked(api.listRemoteAccessComputers).mockResolvedValue({ data: [PC, PC_SEM_ACESSO] });
  vi.mocked(api.openRemoteSession).mockResolvedValue({
    connectionIdentifier: '10',
    connectionName: 'EA-PC-COR01',
    guacamoleUser: 'dash-admin',
    url: URL_DA_SESSAO,
  });
});

describe('lista de computadores', () => {
  it('mostra os computadores e quem tem acesso configurado', async () => {
    renderPage();

    expect(await screen.findByText('EA-PC-COR01')).toBeInTheDocument();
    expect(screen.getByText('Disponível')).toBeInTheDocument();
    expect(screen.getByText('Sem acesso configurado')).toBeInTheDocument();
  });

  it('o botão fica desabilitado para quem não tem conexão no Guacamole', async () => {
    renderPage();
    await screen.findByText('EA-PC-SEM');

    const linha = screen.getByText('EA-PC-SEM').closest('li')!;
    expect(within(linha).getByRole('button', { name: /abrir sessão/i })).toBeDisabled();
  });

  it('filtra pela busca', async () => {
    renderPage();
    await screen.findByText('EA-PC-COR01');

    await userEvent.type(screen.getByLabelText('Buscar computador'), 'COR01');

    expect(screen.getByText('EA-PC-COR01')).toBeInTheDocument();
    expect(screen.queryByText('EA-PC-SEM')).not.toBeInTheDocument();
  });
});

describe('transparência de sessão ativa', () => {
  // Acesso à tela de outra máquina não pode ser discreto. Estes testes
  // travam o aviso: sem eles, alguém poderia "limpar" a interface removendo
  // o alerta e nada quebraria.
  it('sinaliza na lista quando já há sessão ativa numa máquina', async () => {
    vi.mocked(api.listRemoteAccessComputers).mockResolvedValue({
      data: [{ ...PC, activeSessions: 2 }],
    });

    renderPage();

    expect(await screen.findByText('2 sessões ativas')).toBeInTheDocument();
  });

  it('ao abrir a sessão, mostra um aviso destacado com a máquina e a conta auditada', async () => {
    renderPage();
    await screen.findByText('EA-PC-COR01');

    await userEvent.click(botaoAbrir('EA-PC-COR01'));

    const aviso = await screen.findByRole('alert');
    expect(aviso).toHaveTextContent(/sessão remota ativa/i);
    expect(aviso).toHaveTextContent('EA-PC-COR01');
    expect(aviso).toHaveTextContent('dash-admin');
    // O papel `alert` é parte da garantia: um aviso neutro (`status`) não
    // carrega a mesma urgência para leitor de tela.
    expect(aviso).toBeInTheDocument();
  });

  it('a sessão só é aberta no clique — nunca junto do carregamento da lista', async () => {
    // Cada abertura emite um token e grava auditoria. Pré-carregar sessões
    // para a lista inteira produziria uma enxurrada de linhas de auditoria
    // de acessos que nunca aconteceram.
    renderPage();
    await screen.findByText('EA-PC-COR01');

    expect(api.openRemoteSession).not.toHaveBeenCalled();
  });

  it('encerrar a sessão remove o iframe da tela', async () => {
    renderPage();
    await screen.findByText('EA-PC-COR01');
    await userEvent.click(botaoAbrir('EA-PC-COR01'));
    await screen.findByRole('alert');

    await userEvent.click(screen.getByRole('button', { name: /encerrar sessão/i }));

    await waitFor(() => {
      expect(document.querySelector('iframe')).toBeNull();
    });
  });
});

describe('o token da sessão não vaza', () => {
  // A URL da sessão carrega o token da conta Guacamole da pessoa. Ele precisa
  // chegar ao navegador (o navegador É o cliente do Guacamole), mas não pode
  // sobreviver à sessão nem ser exposto além do necessário.
  it('o token vai para o src do iframe, não para texto visível da página', async () => {
    renderPage();
    await screen.findByText('EA-PC-COR01');

    await userEvent.click(botaoAbrir('EA-PC-COR01'));
    await screen.findByRole('alert');

    const iframe = document.querySelector('iframe')!;
    expect(iframe.getAttribute('src')).toBe(URL_DA_SESSAO);
    expect(document.body.textContent).not.toContain(TOKEN_DA_PESSOA);
  });

  it('NÃO persiste o token em localStorage nem sessionStorage', async () => {
    // Persistir sobreviveria ao logout e a quem usasse o mesmo perfil depois.
    renderPage();
    await screen.findByText('EA-PC-COR01');

    await userEvent.click(botaoAbrir('EA-PC-COR01'));
    await screen.findByRole('alert');

    expect(JSON.stringify(localStorage)).not.toContain(TOKEN_DA_PESSOA);
    expect(JSON.stringify(sessionStorage)).not.toContain(TOKEN_DA_PESSOA);
  });

  it('NÃO navega a janela para a URL com token (iria para o histórico)', async () => {
    const href = window.location.href;

    renderPage();
    await screen.findByText('EA-PC-COR01');
    await userEvent.click(botaoAbrir('EA-PC-COR01'));
    await screen.findByRole('alert');

    expect(window.location.href).toBe(href);
  });

  it('encerrar a sessão descarta o token do DOM', async () => {
    renderPage();
    await screen.findByText('EA-PC-COR01');
    await userEvent.click(botaoAbrir('EA-PC-COR01'));
    await screen.findByRole('alert');

    await userEvent.click(screen.getByRole('button', { name: /encerrar sessão/i }));

    await waitFor(() => {
      expect(document.body.innerHTML).not.toContain(TOKEN_DA_PESSOA);
    });
  });
});

describe('sincronização com o AD', () => {
  it('mostra o resumo do que mudou', async () => {
    vi.mocked(api.syncRemoteAccess).mockResolvedValue({
      resumo: { criadas: 3, atualizadas: 1, inalteradas: 40, removidas: 2, puladas: 0, ignoradas: 0 },
    });

    renderPage();
    await screen.findByText('EA-PC-COR01');

    await userEvent.click(screen.getByRole('button', { name: /sincronizar com o ad/i }));

    const status = await screen.findByRole('status');
    expect(status).toHaveTextContent('3 criada(s)');
    expect(status).toHaveTextContent('2 removida(s)');
  });

  it('falha de sincronização aparece como ERRO, nunca como aviso neutro', async () => {
    const { ApiError } = await import('../lib/api');
    vi.mocked(api.syncRemoteAccess).mockRejectedValue(new ApiError(502, 'Erro no acesso remoto'));

    renderPage();
    await screen.findByText('EA-PC-COR01');

    await userEvent.click(screen.getByRole('button', { name: /sincronizar com o ad/i }));

    const alerta = await screen.findByRole('alert');
    expect(alerta).toHaveTextContent(/erro no acesso remoto/i);
  });
});

describe('falha ao abrir sessão', () => {
  it('mostra o erro e não deixa a tela num estado de sessão aberta', async () => {
    const { ApiError } = await import('../lib/api');
    vi.mocked(api.openRemoteSession).mockRejectedValue(
      new ApiError(404, 'Nenhuma conexao de acesso remoto ancarada'),
    );

    renderPage();
    await screen.findByText('EA-PC-COR01');

    await userEvent.click(botaoAbrir('EA-PC-COR01'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/nenhuma conexao/i);
    expect(document.querySelector('iframe')).toBeNull();
  });
});
