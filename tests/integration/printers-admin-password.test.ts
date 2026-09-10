import { rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

// POST /printers/:id/admin-password — troca a senha de admin do painel SWS
// (HP), a ação de MAIOR RISCO do projeto: mexe na credencial mestra de um
// equipamento de produção real, sem forma de ler a senha de volta se algo
// der errado.
//
// NENHUMA CHAMADA DE REDE REAL: `printer-hp-sws.service.ts` é mockado na
// CAMADA DE SERVIÇO (mesmo padrão de printers-reboot.test.ts), nunca a
// implementação interna da rota. A HP real (172.16.0.89) já teve essa troca
// testada ao vivo numa sessão anterior (senha revertida ao valor original
// depois) — aqui só a integração da ROTA é exercitada.
process.env.RATE_LIMIT_CLIENT_ACTION_MAX = '3';

vi.mock('../../src/services/unifi.service.js', () => ({
  unifiService: {
    listClients: vi.fn(async () => ({ data: [] })),
  },
  UniFiApiError: class UniFiApiError extends Error {},
}));

vi.mock('../../src/services/unifi-classic.service.js', () => ({
  unifiClassicService: {
    isConfigured: vi.fn(() => false),
    getKnownClientsNetworkInfo: vi.fn(async () => new Map()),
    getConnectedMacs: vi.fn(async () => new Set()),
    blockClient: vi.fn(async () => undefined),
    unblockClient: vi.fn(async () => undefined),
  },
  UniFiClassicApiError: class UniFiClassicApiError extends Error {
    constructor(
      public status: number,
      message: string,
    ) {
      super(message);
      this.name = 'UniFiClassicApiError';
    }
  },
  ClassicApiNotConfiguredError: class ClassicApiNotConfiguredError extends Error {},
}));

// As classes de erro precisam ser as MESMAS que a rota usa no `instanceof`,
// então vêm do módulo real via `importOriginal` — mesmo padrão de
// printers-reboot.test.ts.
const changePasswordMock =
  vi.fn<
    (
      ip: string,
      currentCredentials: { username: string; password: string },
      newUsername: string,
      newPassword: string,
    ) => Promise<void>
  >(async () => undefined);
const rebootMock = vi.fn<(ip: string, mac: string, credentials: { username: string; password: string }) => Promise<void>>(
  async () => undefined,
);

vi.mock('../../src/services/printer-hp-sws.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/services/printer-hp-sws.service.js')>();
  return {
    ...actual,
    changeHpAdminPassword: (
      ip: string,
      currentCredentials: { username: string; password: string },
      newUsername: string,
      newPassword: string,
    ) => changePasswordMock(ip, currentCredentials, newUsername, newPassword),
    rebootHpPrinter: (ip: string, mac: string, credentials: { username: string; password: string }) =>
      rebootMock(ip, mac, credentials),
  };
});

const tmpDir = mkdtempSync(join(tmpdir(), 'printers-admin-password-test-'));
process.env.PRINTERS_DB_FILE = join(tmpDir, 'printers.db');

const { buildApp } = await import('../../src/app.js');
const { printersRepository } = await import('../../src/routes/printers.routes.js');
const {
  PrinterSwsAuthenticationError,
  PrinterSwsRequestError,
  PrinterSwsUnreachableError,
  PrinterSwsPasswordVerificationError,
} = await import('../../src/services/printer-hp-sws.service.js');
const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
const { unifiService } = await import('../../src/services/unifi.service.js');

const PRINTER_IP = '10.99.99.99';
const PANEL_PASSWORD = 'senha-do-painel-super-secreta';
const SNMP_SECRET = 'community-super-secreta';

afterAll(() => {
  printersRepository.close();
  rmSync(tmpDir, { recursive: true, force: true });
});

async function authedApp() {
  const app = await buildApp();
  const token = app.jwt.sign({ sub: 'admin' });
  return { app, token, auth: { authorization: `Bearer ${token}` } };
}

async function createPrinter(
  app: Awaited<ReturnType<typeof buildApp>>,
  auth: Record<string, string>,
  options: { mac: string; ipOverride?: string; withCredentials?: boolean; password?: string },
) {
  const res = await app.inject({
    method: 'POST',
    url: '/printers',
    headers: auth,
    payload: {
      name: 'HP SWS test',
      mac: options.mac,
      ipOverride: options.ipOverride,
      snmp: { version: 'v2c', community: SNMP_SECRET },
      wbmCredentials:
        options.withCredentials === false
          ? undefined
          : { username: 'admin', password: options.password ?? PANEL_PASSWORD },
    },
  });
  expect(res.statusCode).toBe(201);
  return res.json();
}

beforeEach(() => {
  // `mockReset` (não só `mockClear`) — um teste cujo request falha ANTES de
  // chamar o serviço (ex: 400 de validação) pode deixar um
  // `mockRejectedValueOnce` na fila sem consumir; `mockClear` sozinho não
  // limpa essa fila, e o valor vaza pro PRÓXIMO teste que chamar o mock,
  // trocando o resultado dele silenciosamente. `mockReset` limpa a fila
  // também — daí rearmar a implementação padrão logo em seguida.
  changePasswordMock.mockReset();
  changePasswordMock.mockImplementation(async () => undefined);
  rebootMock.mockReset();
  rebootMock.mockImplementation(async () => undefined);
  vi.mocked(unifiClassicService.isConfigured).mockReturnValue(false);
  vi.mocked(unifiClassicService.getKnownClientsNetworkInfo).mockResolvedValue(new Map());
  vi.mocked(unifiService.listClients).mockResolvedValue({ data: [] } as never);
});

describe('POST /printers/:id/admin-password', () => {
  it('caminho feliz com senha explícita: chama changeHpAdminPassword, persiste no cadastro e devolve a credencial nova', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:10:00:01', ipOverride: PRINTER_IP });

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/admin-password`,
      headers: auth,
      payload: { password: 'nova-senha-forte' },
    });

    expect(res.statusCode).toBe(200);
    // `ipAddress`/`ipOrigin` acompanham a resposta como nas outras rotas de
    // ESCRITA deste arquivo (/reboot, /sleep-time) — quem chama precisa saber
    // em qual endereço a troca caiu de fato.
    expect(res.json()).toEqual({
      username: 'admin',
      password: 'nova-senha-forte',
      ipAddress: PRINTER_IP,
      ipOrigin: 'override',
    });
    expect(changePasswordMock).toHaveBeenCalledWith(
      PRINTER_IP,
      { username: 'admin', password: PANEL_PASSWORD },
      'admin',
      'nova-senha-forte',
    );

    // A credencial persistida precisa refletir a senha NOVA -- reboot
    // seguinte usa ela automaticamente, sem reconfigurar nada.
    const reboot = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });
    expect(reboot.statusCode).toBe(200);
    expect(rebootMock).toHaveBeenCalledWith(PRINTER_IP, 'aa:bb:cc:10:00:01', {
      username: 'admin',
      password: 'nova-senha-forte',
    });

    await app.close();
  });

  it('sem senha no corpo, gera uma aleatória e a persiste (mesmo padrão de ssh-credentials/rotate)', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:10:00:02', ipOverride: PRINTER_IP });

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/admin-password`, headers: auth });

    expect(res.statusCode).toBe(200);
    const json = res.json();
    expect(json.username).toBe('admin');
    expect(typeof json.password).toBe('string');
    expect(json.password.length).toBeGreaterThanOrEqual(8);
    expect(json.password.length).toBeLessThanOrEqual(18);
    expect(json.password).not.toBe(PANEL_PASSWORD);
    expect(changePasswordMock).toHaveBeenCalledWith(
      PRINTER_IP,
      { username: 'admin', password: PANEL_PASSWORD },
      'admin',
      json.password,
    );

    await app.close();
  });

  it('aceita trocar o username junto (mantém o restante do formulário via changeHpAdminPassword)', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:10:00:03', ipOverride: PRINTER_IP });

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/admin-password`,
      headers: auth,
      payload: { username: 'operador', password: 'outra-senha-forte' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({
      username: 'operador',
      password: 'outra-senha-forte',
      ipAddress: PRINTER_IP,
      ipOrigin: 'override',
    });
    expect(changePasswordMock).toHaveBeenCalledWith(
      PRINTER_IP,
      { username: 'admin', password: PANEL_PASSWORD },
      'operador',
      'outra-senha-forte',
    );

    await app.close();
  });

  it('retorna 404 quando o id não existe, sem chamar o serviço', async () => {
    const { app, auth } = await authedApp();

    const res = await app.inject({ method: 'POST', url: '/printers/nao-existe/admin-password', headers: auth });

    expect(res.statusCode).toBe(404);
    expect(changePasswordMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('retorna 409 quando não há credencial ATUAL cadastrada (precisa dela pra logar e trocar)', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, {
      mac: 'aa:bb:cc:10:00:04',
      ipOverride: PRINTER_IP,
      withCredentials: false,
    });

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/admin-password`, headers: auth });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/credencial/i);
    expect(changePasswordMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('retorna 409 quando não há IP conhecido', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:10:00:05' });

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/admin-password`, headers: auth });

    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/IP/);
    expect(changePasswordMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('retorna 403 quando a credencial ATUAL é recusada no login inicial', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:10:00:06', ipOverride: PRINTER_IP });

    changePasswordMock.mockRejectedValueOnce(new PrinterSwsAuthenticationError(PRINTER_IP, 'admin'));
    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/admin-password`, headers: auth });

    expect(res.statusCode).toBe(403);
    // Cadastro não deve ter sido tocado -- reboot continua usando a credencial antiga.
    const reboot = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });
    expect(rebootMock).toHaveBeenCalledWith(PRINTER_IP, 'aa:bb:cc:10:00:06', {
      username: 'admin',
      password: PANEL_PASSWORD,
    });
    expect(reboot.statusCode).toBe(200);

    await app.close();
  });

  it('retorna 502 e NÃO PERSISTE quando a verificação por relogin falha (SetAdmin.jsp disse sucesso, mas a senha nova não loga)', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:10:00:07', ipOverride: PRINTER_IP });

    changePasswordMock.mockRejectedValueOnce(new PrinterSwsPasswordVerificationError(PRINTER_IP));
    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/admin-password`,
      headers: auth,
      payload: { password: 'senha-nao-verifica' },
    });

    expect(res.statusCode).toBe(502);

    // ACHADO DO CRÍTICO (2026-09-10) — não persistir está certo, mas
    // DESCARTAR o valor tentado não: neste estado a impressora pode já estar
    // exigindo a senha nova, e esta resposta é a única cópia dela que existe
    // fora do processo (a senha nunca vai pro log, por regra do projeto).
    // Sem estes campos, uma chamada sem `password` no corpo (senha gerada
    // pela rota) trancaria o operador fora de um equipamento de produção sem
    // recuperação a não ser reset de fábrica.
    expect(res.json()).toMatchObject({
      attemptedUsername: 'admin',
      attemptedPassword: 'senha-nao-verifica',
      persisted: false,
      ipAddress: PRINTER_IP,
      ipOrigin: 'override',
    });

    // A credencial ANTIGA precisa continuar sendo a usada -- é a garantia
    // central desta rota (ver DECISÃO em printer-hp-sws.service.ts).
    const reboot = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });
    expect(reboot.statusCode).toBe(200);
    expect(rebootMock).toHaveBeenCalledWith(PRINTER_IP, 'aa:bb:cc:10:00:07', {
      username: 'admin',
      password: PANEL_PASSWORD,
    });

    await app.close();
  });

  // O caso que motivou o achado: sem `password` no corpo, a senha é gerada
  // DENTRO da rota, então a resposta é a única cópia que existe. Se a
  // verificação falhar e a resposta não trouxer o valor, ele deixa de existir
  // em qualquer lugar do mundo — com a impressora possivelmente já exigindo
  // ele.
  it('no 502 ambíguo com senha GERADA, devolve o valor tentado (única cópia existente) e o cadastro segue com a antiga', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:10:00:10', ipOverride: PRINTER_IP });

    changePasswordMock.mockRejectedValueOnce(new PrinterSwsPasswordVerificationError(PRINTER_IP));
    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/admin-password`, headers: auth });

    expect(res.statusCode).toBe(502);
    const json = res.json();
    expect(typeof json.attemptedPassword).toBe('string');
    expect(json.attemptedPassword.length).toBeGreaterThanOrEqual(8);
    expect(json.persisted).toBe(false);
    // E é EXATAMENTE o valor que foi mandado pra impressora, não outro
    // gerado na hora de responder.
    expect(changePasswordMock).toHaveBeenCalledWith(
      PRINTER_IP,
      { username: 'admin', password: PANEL_PASSWORD },
      'admin',
      json.attemptedPassword,
    );

    const reboot = await app.inject({ method: 'POST', url: `/printers/${printer.id}/reboot`, headers: auth });
    expect(reboot.statusCode).toBe(200);
    expect(rebootMock).toHaveBeenCalledWith(PRINTER_IP, 'aa:bb:cc:10:00:10', {
      username: 'admin',
      password: PANEL_PASSWORD,
    });

    await app.close();
  });

  it('retorna 504 quando a impressora não responde', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:10:00:08', ipOverride: PRINTER_IP });

    changePasswordMock.mockRejectedValueOnce(new PrinterSwsUnreachableError(PRINTER_IP, 'AbortError'));
    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/admin-password`, headers: auth });

    expect(res.statusCode).toBe(504);

    await app.close();
  });

  it('retorna 502 quando o painel responde de forma inutilizável', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:10:00:09', ipOverride: PRINTER_IP });

    changePasswordMock.mockRejectedValueOnce(new PrinterSwsRequestError(PRINTER_IP, 'status 404', 404));
    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/admin-password`, headers: auth });

    expect(res.statusCode).toBe(502);

    await app.close();
  });

  it('propaga erro inesperado pro handler central (500)', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:10:00:0a', ipOverride: PRINTER_IP });

    changePasswordMock.mockRejectedValueOnce(new TypeError('algo totalmente inesperado'));
    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/admin-password`, headers: auth });

    expect(res.statusCode).toBe(500);

    await app.close();
  });

  it('retorna 400 quando a senha nova é muito curta ou muito longa', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:10:00:0b', ipOverride: PRINTER_IP });

    const curta = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/admin-password`,
      headers: auth,
      payload: { password: '1234567' },
    });
    expect(curta.statusCode).toBe(400);

    const longa = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/admin-password`,
      headers: auth,
      payload: { password: 'a'.repeat(19) },
    });
    expect(longa.statusCode).toBe(400);

    expect(changePasswordMock).not.toHaveBeenCalled();

    await app.close();
  });

  // ACHADO DO CRÍTICO (2026-09-10): o `min(1)` do username não tinha teste
  // nenhum — removê-lo deixava a suíte verde e permitia mandar um ID de logon
  // VAZIO pra credencial mestra do painel.
  it('retorna 400 quando o username é vazio ou maior que o limite do formulário', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:10:00:11', ipOverride: PRINTER_IP });

    for (const username of ['', 'u'.repeat(19)]) {
      const res = await app.inject({
        method: 'POST',
        url: `/printers/${printer.id}/admin-password`,
        headers: auth,
        payload: { username, password: 'senha-forte-ok' },
      });
      expect(res.statusCode).toBe(400);
    }
    expect(changePasswordMock).not.toHaveBeenCalled();

    await app.close();
  });

  // ACHADO DO CRÍTICO (2026-09-10): o login da SWS cifra `usuário\rsenha` —
  // CR é o SEPARADOR (ver buildLoginAuthentication). Um `\r` dentro da senha
  // seria aceito pelo SetAdmin.jsp (que cifra o campo sozinho) e depois
  // nenhum login montado por este projeto conseguiria reproduzir a senha: a
  // impressora ficaria com uma credencial que o dashboard nunca mais usa.
  // Tem que ser rejeitado ANTES de qualquer chamada de rede.
  it('retorna 400 para caractere de controle no usuário/senha, sem chamar o serviço', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:10:00:12', ipOverride: PRINTER_IP });

    const payloads = [
      // Exatamente 3 chamadas: o rate limit desta rota (onRequest, roda ANTES
      // da validacao) e RATE_LIMIT_CLIENT_ACTION_MAX=3 neste arquivo, entao uma
      // 4a viraria 429 e o teste passaria por motivo errado.
      { password: 'senha\rforte' },
      { password: 'senha\nforte' },
      { username: 'ad\rmin', password: 'senha-forte-ok' },
    ];
    for (const payload of payloads) {
      const res = await app.inject({
        method: 'POST',
        url: `/printers/${printer.id}/admin-password`,
        headers: auth,
        payload,
      });
      expect(res.statusCode).toBe(400);
    }
    expect(changePasswordMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('retorna 401 sem token, sem chamar o serviço', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:10:00:0c', ipOverride: PRINTER_IP });

    const res = await app.inject({ method: 'POST', url: `/printers/${printer.id}/admin-password` });

    expect(res.statusCode).toBe(401);
    expect(changePasswordMock).not.toHaveBeenCalled();

    await app.close();
  });

  it('está sob o rate limit de ação de cliente (RATE_LIMIT_CLIENT_ACTION_MAX)', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:10:00:0d', ipOverride: PRINTER_IP });

    for (let i = 0; i < 3; i += 1) {
      const ok = await app.inject({
        method: 'POST',
        url: `/printers/${printer.id}/admin-password`,
        headers: auth,
        payload: { password: `senha-forte-${i}` },
      });
      expect(ok.statusCode).toBe(200);
    }
    const limited = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/admin-password`,
      headers: auth,
      payload: { password: 'senha-forte-extra' },
    });

    expect(limited.statusCode).toBe(429);
    expect(changePasswordMock).toHaveBeenCalledTimes(3);

    await app.close();
  });

  // Vale para TODOS os erros em que se sabe que a escrita não aconteceu (403
  // aqui, 504, 502 de recusa). A ÚNICA exceção é deliberada e tem teste
  // próprio: o 502 AMBÍGUO devolve `attemptedPassword` de propósito, porque
  // sem ele o operador pode ficar trancado fora da impressora (ver o achado do
  // crítico no teste correspondente). Se algum dia esta asserção e a de lá
  // colidirem, é a distinção "escrita não aconteceu" vs "pode ter acontecido"
  // que precisa ser revista, não uma das duas apagada.
  it('SEGURANÇA: nem a senha ATUAL nem a NOVA aparecem em mensagens de erro', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:10:00:0e', ipOverride: PRINTER_IP });

    changePasswordMock.mockRejectedValueOnce(new PrinterSwsAuthenticationError(PRINTER_IP, 'admin'));
    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/admin-password`,
      headers: auth,
      payload: { password: 'senha-nao-vazar' },
    });

    expect(res.statusCode).toBe(403);
    expect(res.body).not.toContain(PANEL_PASSWORD);
    expect(res.body).not.toContain('senha-nao-vazar');

    await app.close();
  });

  it('marca aviso de IP histórico (classic) sem bloquear a troca', async () => {
    const { app, auth } = await authedApp();
    const printer = await createPrinter(app, auth, { mac: 'aa:bb:cc:10:00:0f' });

    vi.mocked(unifiClassicService.isConfigured).mockReturnValue(true);
    vi.mocked(unifiClassicService.getKnownClientsNetworkInfo).mockResolvedValue(
      new Map([['aa:bb:cc:10:00:0f', { ipAddress: '10.99.99.77', connectionType: 'WIRELESS' as const }]]),
    );

    const res = await app.inject({
      method: 'POST',
      url: `/printers/${printer.id}/admin-password`,
      headers: auth,
      payload: { password: 'senha-forte-clssc' },
    });

    expect(res.statusCode).toBe(200);
    expect(changePasswordMock).toHaveBeenCalledWith(
      '10.99.99.77',
      { username: 'admin', password: PANEL_PASSWORD },
      'admin',
      'senha-forte-clssc',
    );
    // O aviso de IP histórico não pode ficar só no log do servidor: quem
    // chamou precisa ver, na própria resposta, que a troca de senha caiu num
    // endereço vindo do `last_ip` HISTÓRICO da API clássica (que já foi de
    // outro dispositivo antes, ver CLAUDE.md) — mesmo contrato de /reboot e
    // /sleep-time.
    expect(res.json()).toMatchObject({ ipAddress: '10.99.99.77', ipOrigin: 'classic' });

    await app.close();
  });
});
