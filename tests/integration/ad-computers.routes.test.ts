import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdComputer } from '../../src/services/ad.service.js';

// Onda 3, subtarefa 4 (computadores). Mesmo padrão de
// tests/integration/ad-groups.routes.test.ts: mock na camada de SERVIÇO
// (nunca a implementação interna da rota), classes de erro vindas do módulo
// real via `importOriginal` porque o error handler central (src/app.ts) faz
// `instanceof` contra elas.
//
// O caminho contra o PROTOCOLO LDAP de verdade está em
// tests/integration/ad-fake-ldap.test.ts — este arquivo cobre só o que é
// responsabilidade da ROTA: validação de parâmetro, mapeamento de status e
// rate limit.
vi.mock('../../src/services/ad.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/ad.service.js')>();
  return {
    ...actual,
    searchComputers: vi.fn(),
    getComputer: vi.fn(),
    setComputerEnabled: vi.fn(),
  };
});

const { buildApp } = await import('../../src/app.js');
const { searchComputers, getComputer, setComputerEnabled, AdComputerNotFoundError, AdNotConfiguredError, AdRequestError } =
  await import('../../src/services/ad.service.js');

// mockReset() (não mockClear()) — mesmo achado já documentado no CLAUDE.md:
// mockClear() não limpa uma rejeição enfileirada com *Once que ficou sem ser
// consumida, e ela vazaria para o próximo teste que invocasse o mock.
beforeEach(() => {
  vi.mocked(searchComputers).mockReset();
  vi.mocked(getComputer).mockReset();
  vi.mocked(setComputerEnabled).mockReset();
});

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token, headers: { authorization: `Bearer ${token}` } };
}

const SAMPLE: AdComputer = {
  dn: 'CN=EA-PC-TESTE01,CN=Computers,DC=test,DC=local',
  name: 'EA-PC-TESTE01',
  sAMAccountName: 'EA-PC-TESTE01$',
  dnsHostName: 'ea-pc-teste01.test.local',
  operatingSystem: 'Windows 11 Pro',
  operatingSystemVersion: '10.0 (26200)',
  description: 'Estação de teste',
  enabled: true,
  isDomainController: false,
};

describe('GET /ad/computers', () => {
  it('devolve a lista em `data`', async () => {
    vi.mocked(searchComputers).mockResolvedValue([SAMPLE]);
    const { app, headers } = await authedApp();

    const res = await app.inject({ method: 'GET', url: '/ad/computers', headers });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ data: [SAMPLE] });
    await app.close();
  });

  it('repassa `query` para o serviço', async () => {
    vi.mocked(searchComputers).mockResolvedValue([]);
    const { app, headers } = await authedApp();

    await app.inject({ method: 'GET', url: '/ad/computers?query=teste', headers });

    expect(searchComputers).toHaveBeenCalledWith('teste');
    await app.close();
  });

  it('sem AD configurado -> 503, e o resto do app segue de pé', async () => {
    vi.mocked(searchComputers).mockRejectedValue(new AdNotConfiguredError());
    const { app, headers } = await authedApp();

    const res = await app.inject({ method: 'GET', url: '/ad/computers', headers });

    expect(res.statusCode).toBe(503);
    await app.close();
  });

  it('exige autenticação', async () => {
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/ad/computers' });
    expect(res.statusCode).toBe(401);
    await app.close();
  });
});

describe('GET /ad/computers/:computerName', () => {
  it('devolve o computador', async () => {
    vi.mocked(getComputer).mockResolvedValue(SAMPLE);
    const { app, headers } = await authedApp();

    const res = await app.inject({ method: 'GET', url: '/ad/computers/EA-PC-TESTE01', headers });

    expect(res.statusCode).toBe(200);
    expect(res.json().sAMAccountName).toBe('EA-PC-TESTE01$');
    await app.close();
  });

  // Sem este mapeamento o 404 vira 500 genérico. Foi o que de fato aconteceu
  // durante a implementação: `withClient` reembrulhava a classe nova porque
  // decidia por uma LISTA de instanceof — ver `AdError` em ad.service.ts.
  it('computador inexistente -> 404 (não 500)', async () => {
    vi.mocked(getComputer).mockRejectedValue(new AdComputerNotFoundError('EA-PC-XXX'));
    const { app, headers } = await authedApp();

    const res = await app.inject({ method: 'GET', url: '/ad/computers/EA-PC-XXX', headers });

    expect(res.statusCode).toBe(404);
    await app.close();
  });
});

describe('POST /ad/computers/:computerName/enable|disable', () => {
  it('enable chama o serviço com `true`', async () => {
    vi.mocked(setComputerEnabled).mockResolvedValue(undefined);
    const { app, headers } = await authedApp();

    const res = await app.inject({ method: 'POST', url: '/ad/computers/EA-PC-TESTE01/enable', headers });

    expect(res.statusCode).toBe(200);
    expect(setComputerEnabled).toHaveBeenCalledWith('EA-PC-TESTE01', true);
    await app.close();
  });

  // O par enable/disable é o lugar clássico de um booleano trocado passar
  // despercebido: as duas rotas respondem 200 e o corpo é idêntico. Sem
  // afirmar o ARGUMENTO, trocar `false` por `true` aqui não produziria
  // nenhuma linha vermelha — e o efeito real seria habilitar uma conta que
  // o operador mandou desabilitar.
  it('disable chama o serviço com `false`', async () => {
    vi.mocked(setComputerEnabled).mockResolvedValue(undefined);
    const { app, headers } = await authedApp();

    const res = await app.inject({ method: 'POST', url: '/ad/computers/EA-PC-TESTE01/disable', headers });

    expect(res.statusCode).toBe(200);
    expect(setComputerEnabled).toHaveBeenCalledWith('EA-PC-TESTE01', false);
    await app.close();
  });

  it('recusa de escrita com UAC ilegível chega como 502, não como sucesso', async () => {
    vi.mocked(setComputerEnabled).mockRejectedValue(new AdRequestError('não foi possível ler userAccountControl'));
    const { app, headers } = await authedApp();

    const res = await app.inject({ method: 'POST', url: '/ad/computers/EA-PC-TESTE01/disable', headers });

    expect(res.statusCode).toBe(502);
    await app.close();
  });

  it('nome com caractere proibido pelo AD -> 400, sem chegar no serviço', async () => {
    const { app, headers } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: `/ad/computers/${encodeURIComponent('EA-PC,OU=Servidores')}/disable`,
      headers,
    });

    expect(res.statusCode).toBe(400);
    expect(setComputerEnabled).not.toHaveBeenCalled();
    await app.close();
  });

  it('nome acima do limite do AD -> 400, sem chegar no serviço', async () => {
    const { app, headers } = await authedApp();

    const res = await app.inject({
      method: 'POST',
      url: `/ad/computers/${'A'.repeat(20)}/disable`,
      headers,
    });

    expect(res.statusCode).toBe(400);
    expect(setComputerEnabled).not.toHaveBeenCalled();
    await app.close();
  });

  // Desabilitar a conta de um computador quebra o canal seguro dele com o
  // domínio — é a mutação mais destrutiva do módulo de AD. Tem que estar no
  // rate limit RESTRITO, não no global.
  it('está no rate limit restrito (RATE_LIMIT_CLIENT_ACTION_MAX), não no global', async () => {
    vi.mocked(setComputerEnabled).mockResolvedValue(undefined);
    const { app, headers } = await authedApp();

    const limite = Number(process.env.RATE_LIMIT_CLIENT_ACTION_MAX ?? 10);
    let bloqueado = false;
    for (let i = 0; i < limite + 2; i++) {
      const res = await app.inject({ method: 'POST', url: '/ad/computers/EA-PC-TESTE01/disable', headers });
      if (res.statusCode === 429) {
        bloqueado = true;
        break;
      }
    }

    expect(bloqueado).toBe(true);
    await app.close();
  });
});
