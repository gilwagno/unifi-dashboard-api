import { createDecipheriv, createHash } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildLoginAuthentication,
  fetchDeviceIdentity,
  loginToSws,
  opensslAesEncrypt,
  rebootHpPrinter,
  PrinterSwsAuthenticationError,
  PrinterSwsRequestError,
  PrinterSwsUnreachableError,
  type SwsDeviceIdentity,
} from '../../src/services/printer-hp-sws.service.js';

// Testes de src/services/printer-hp-sws.service.ts — login programático na
// SWS da HP + reboot remoto.
//
// NENHUMA CHAMADA DE REDE REAL: `global.fetch` é sempre mockado (mesmo padrão
// de printer-brother-wbm.service.test.ts). A impressora HP real
// (172.16.0.89) é a do Financeiro, em produção — um POST de reboot acidental
// aqui reiniciaria o equipamento de verdade, então nem o endereço real
// aparece nos testes: usamos um IP de laboratório fictício.
const IP = '10.99.99.99';

const IDENTITY: SwsDeviceIdentity = {
  productName: 'HP HP Laser MFP 135w',
  productSerial: 'BRBSQ2G13Q',
  csrfToken: 'QlJCU1EyRzEzUQAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
};

const CREDENTIALS = { username: 'admin', password: 'senha-do-painel' };

// Corpo típico do sws_data.js real (recortado: só as três atribuições que o
// serviço lê, no mesmo formato de atribuição por linha do arquivo original).
function swsDataBody(overrides: Partial<Record<'buyorProductName' | 'productSerial' | 'csrfToken', string>> = {}) {
  const values = {
    buyorProductName: IDENTITY.productName,
    productSerial: IDENTITY.productSerial,
    csrfToken: IDENTITY.csrfToken,
    ...overrides,
  };
  return [
    'var SWS = SWS || {};',
    'SWS.DATA = SWS.DATA || {};',
    `SWS.DATA.buyorProductName = "${values.buyorProductName}";`,
    `SWS.DATA.productSerial = "${values.productSerial}";`,
    `SWS.DATA.csrfToken = "${values.csrfToken}";`,
    'SWS.DATA.somethingElse = "irrelevante";',
  ].join('\n');
}

function fakeResponse(status: number, body: string, setCookies: string[] = []): Response {
  const headers = new Headers();
  for (const cookie of setCookies) headers.append('set-cookie', cookie);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers,
    text: async () => body,
  } as unknown as Response;
}

function loginOkResponse(cookieValue = 'Authentication=Ext1 blob-de-sessao; Path=/; HttpOnly') {
  return fakeResponse(200, JSON.stringify({ success: true, passwordExpiration: false }), [cookieValue]);
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// --- Decifrador independente, só para os testes -------------------------
//
// Escrito à mão aqui (e não importado do serviço) para que a verificação do
// que vai dentro do blob `Ext1` não use a mesma implementação sob teste. Sua
// própria correção é ancorada logo abaixo contra um blob gerado pelo BINÁRIO
// `openssl` de verdade — se este decifrador estivesse errado, o primeiro
// teste falharia.
function opensslAesDecrypt(blobBase64: string, password: string): string {
  const buf = Buffer.from(blobBase64, 'base64');
  const salt = buf.subarray(8, 16);
  const material: Buffer[] = [];
  let previous = Buffer.alloc(0);
  while (Buffer.concat(material).length < 48) {
    previous = createHash('md5')
      .update(Buffer.concat([previous, Buffer.from(password, 'utf8'), salt]))
      .digest();
    material.push(previous);
  }
  const km = Buffer.concat(material);
  const decipher = createDecipheriv('aes-256-cbc', km.subarray(0, 32), km.subarray(32, 48));
  return Buffer.concat([decipher.update(buf.subarray(16)), decipher.final()]).toString('utf8');
}

describe('opensslAesEncrypt (formato Salted__/EVP_BytesToKey do gibberish-aes)', () => {
  // Vetores gerados pelo BINÁRIO openssl (3.5.7), não por este código:
  //   printf '<texto>' | openssl enc -aes-256-cbc -md md5 -pass pass:<senha> -S <salt hex> -a -A
  // Com `-S` explícito o openssl NÃO emite o cabeçalho "Salted__" — por isso
  // a comparação é contra o CORPO cifrado, e o cabeçalho/salt são verificados
  // à parte. É o vetor de referência mais forte disponível: se a derivação de
  // chave (MD5 iterativo, 3 rodadas), o modo (CBC), o tamanho de chave (256)
  // ou o padding divergirem do OpenSSL — e portanto do que a SWS espera — a
  // string muda por completo.
  it.each([
    ['segredo-de-teste', 'minha-senha', '0102030405060708', 'TKpUctHfG40AJkzfpRiYR0tLm6fDtxf5YjkVMLEsRbs='],
    // Este segundo vetor usa exatamente o formato `usuario\rsenha` que o
    // login da SWS cifra.
    ['admin\rsenha', '0123456789abcdef', 'aabbccddeeff0011', '6mFNlS2qxTn2H5O8EbZ0eA=='],
  ])('bate com o vetor do openssl real para %j', (plaintext, password, saltHex, expectedCipherBase64) => {
    const salt = Buffer.from(saltHex, 'hex');
    const blob = Buffer.from(opensslAesEncrypt(plaintext, password, salt), 'base64');

    expect(blob.subarray(0, 8).toString('utf8')).toBe('Salted__');
    expect(blob.subarray(8, 16).toString('hex')).toBe(saltHex);
    expect(blob.subarray(16).toString('base64')).toBe(expectedCipherBase64);
  });

  it('produz um blob que o openssl real consegue decifrar (round-trip com o decifrador dos testes)', () => {
    // Blob gerado pelo binário openssl COM cabeçalho (salt aleatório):
    //   printf 'texto-de-referencia' | openssl enc -aes-256-cbc -md md5 \
    //     -pass pass:senha-de-referencia -a -A
    const fromOpenssl = 'U2FsdGVkX1/UDQ4lFFSXom/T9nozYpiDuxnQW1IorPVay9PykoYYoWQULQuhsASd';
    expect(opensslAesDecrypt(fromOpenssl, 'senha-de-referencia')).toBe('texto-de-referencia');

    // E o caminho inverso: o que ESTE código produz volta ao texto original.
    const mine = opensslAesEncrypt('texto-de-referencia', 'senha-de-referencia');
    expect(opensslAesDecrypt(mine, 'senha-de-referencia')).toBe('texto-de-referencia');
  });

  it('usa salt aleatório de 8 bytes a cada chamada (duas cifras do mesmo texto diferem)', () => {
    const a = opensslAesEncrypt('mesmo-texto', 'mesma-senha');
    const b = opensslAesEncrypt('mesmo-texto', 'mesma-senha');

    expect(a).not.toBe(b);
    for (const value of [a, b]) {
      const blob = Buffer.from(value, 'base64');
      expect(blob.subarray(0, 8).toString('utf8')).toBe('Salted__');
      expect(blob.length).toBeGreaterThan(16);
    }
    // Salts diferentes é o que faz as duas saídas diferirem.
    expect(Buffer.from(a, 'base64').subarray(8, 16).toString('hex')).not.toBe(
      Buffer.from(b, 'base64').subarray(8, 16).toString('hex'),
    );
  });
});

describe('buildLoginAuthentication', () => {
  it('monta "Ext1 <sidpw>:<skey>" com sidpw = AES(usuario\\rsenha, rn) e skey = AES(rn, produto+serial)', () => {
    const rn = 'rn0123456789abcd';
    const value = buildLoginAuthentication(IDENTITY, CREDENTIALS, rn);

    expect(value.startsWith('Ext1 ')).toBe(true);
    const [sidpw, skey] = value.slice('Ext1 '.length).split(':');
    expect(sidpw).toBeTruthy();
    expect(skey).toBeTruthy();

    // O separador é CR (\r) — não '\n' nem ':' (achado da pesquisa: trocar
    // isso faz o login falhar mesmo com a credencial certa).
    expect(opensslAesDecrypt(sidpw, rn)).toBe('admin\rsenha-do-painel');
    // A "senha" que protege o rn é productName + productSerial, concatenados
    // sem separador nenhum.
    expect(opensslAesDecrypt(skey, IDENTITY.productName + IDENTITY.productSerial)).toBe(rn);
  });

  it('gera um rn aleatório de 16 caracteres quando não recebe um (duas chamadas diferem)', () => {
    const first = buildLoginAuthentication(IDENTITY, CREDENTIALS);
    const second = buildLoginAuthentication(IDENTITY, CREDENTIALS);
    expect(first).not.toBe(second);

    const skey = first.slice('Ext1 '.length).split(':')[1];
    const rn = opensslAesDecrypt(skey, IDENTITY.productName + IDENTITY.productSerial);
    expect(rn).toHaveLength(16);
    expect(rn).toMatch(/^[A-Za-z0-9]{16}$/);
  });

  it('SEGURANÇA: a senha em claro não aparece em nenhuma parte do valor gerado', () => {
    const value = buildLoginAuthentication(IDENTITY, CREDENTIALS);
    expect(value).not.toContain(CREDENTIALS.password);
  });
});

describe('fetchDeviceIdentity', () => {
  it('faz GET no sws_data.js e extrai produto, série e csrfToken', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(200, swsDataBody()));
    vi.stubGlobal('fetch', fetchMock);

    const identity = await fetchDeviceIdentity(IP);

    expect(identity).toEqual(IDENTITY);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://${IP}/sws/data/sws_data.js`);
    expect(init.method).toBe('GET');
  });

  it('aceita aspas simples nas atribuições (o firmware não garante aspas duplas)', async () => {
    const body = "SWS.DATA.buyorProductName = 'HP X';\nSWS.DATA.productSerial = 'S1';\nSWS.DATA.csrfToken = 'T1';";
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, body)));

    await expect(fetchDeviceIdentity(IP)).resolves.toEqual({
      productName: 'HP X',
      productSerial: 'S1',
      csrfToken: 'T1',
    });
  });

  it('lança PrinterSwsRequestError quando falta qualquer um dos campos (dispositivo que não é uma SWS)', async () => {
    // Caso real: apontar a rota para uma Brother — a WBM devolve HTML, sem
    // nenhum SWS.DATA.
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, '<html>WBM da Brother</html>')));

    const error = await fetchDeviceIdentity(IP).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrinterSwsRequestError);
    // O corpo recebido NÃO é ecoado na mensagem (pode ser uma página inteira).
    expect((error as Error).message).not.toContain('WBM da Brother');
  });

  it.each(['buyorProductName', 'productSerial', 'csrfToken'] as const)(
    'lança PrinterSwsRequestError quando só %s está ausente',
    async (missing) => {
      const body = swsDataBody()
        .split('\n')
        .filter((line) => !line.includes(`SWS.DATA.${missing} `))
        .join('\n');
      vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, body)));

      await expect(fetchDeviceIdentity(IP)).rejects.toBeInstanceOf(PrinterSwsRequestError);
    },
  );

  it('lança PrinterSwsRequestError com o status quando a resposta é não-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(404, 'not found')));

    const error = await fetchDeviceIdentity(IP).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrinterSwsRequestError);
    expect((error as PrinterSwsRequestError).status).toBe(404);
  });

  it('lança PrinterUnreachableError quando o fetch rejeita (rede/host inacessível)', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );

    await expect(fetchDeviceIdentity(IP)).rejects.toBeInstanceOf(PrinterSwsUnreachableError);
  });
});

describe('loginToSws', () => {
  it('POSTa Authentication + csrf-token form-urlencoded e devolve o cookie de sessão', async () => {
    const fetchMock = vi.fn(async () => loginOkResponse());
    vi.stubGlobal('fetch', fetchMock);

    const session = await loginToSws(IP, CREDENTIALS, IDENTITY);

    expect(session).toEqual({ cookie: 'Authentication=Ext1 blob-de-sessao' });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`http://${IP}/sws/app/gnb/login/login.jsp`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });

    const body = new URLSearchParams(String(init.body));
    expect(body.get('Authentication')?.startsWith('Ext1 ')).toBe(true);
    // O csrf-token é o valor FIXO lido do sws_data.js, repassado sem
    // transformação.
    expect(body.get('csrf-token')).toBe(IDENTITY.csrfToken);
  });

  it('escolhe o cookie Authentication mesmo entre vários Set-Cookie, descartando os atributos', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        fakeResponse(200, JSON.stringify({ success: true }), [
          'JSESSIONID=abc; Path=/; HttpOnly',
          'Authentication=Ext1 sessao-certa; Path=/; HttpOnly',
        ]),
      ),
    );

    await expect(loginToSws(IP, CREDENTIALS, IDENTITY)).resolves.toEqual({
      cookie: 'Authentication=Ext1 sessao-certa',
    });
  });

  it('lança PrinterSwsAuthenticationError quando a SWS responde 200 com success: false (senha errada)', async () => {
    // A SWS responde 200 tanto no sucesso quanto na recusa — o corpo é o que
    // distingue. Se o serviço olhasse só o status, uma senha errada viraria
    // "reiniciada com sucesso".
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, JSON.stringify({ success: false }))));

    const error = await loginToSws(IP, CREDENTIALS, IDENTITY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrinterSwsAuthenticationError);
    // Mensagem cita o usuário (útil pra diagnóstico) e NUNCA a senha.
    expect((error as Error).message).toContain('admin');
    expect((error as Error).message).not.toContain(CREDENTIALS.password);
  });

  it('lança PrinterSwsAuthenticationError quando o corpo não traz success algum', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, JSON.stringify({ passwordExpiration: false }))));

    await expect(loginToSws(IP, CREDENTIALS, IDENTITY)).rejects.toBeInstanceOf(PrinterSwsAuthenticationError);
  });

  // ACHADO DO CRÍTICO (validação por mutação): trocar `parsed?.success !== true`
  // por `!parsed?.success` passava com a suíte inteira verde. Os dois casos que
  // existiam (`success: false` e `success` ausente) são indistinguíveis entre as
  // duas formas — o que as separa é um valor TRUTHY que não é `true`, e é
  // justamente aí que a diferença é perigosa: com `!success`, um
  // `{"success":"false"}` (string) do firmware seria lido como login
  // bem-sucedido e o POST de RestartSystem.jsp sairia com uma sessão que a
  // impressora nunca autorizou. A comparação estrita é a única coisa que
  // separa "credencial recusada" de "reinicia o equipamento", então precisa de
  // teste próprio.
  it.each([
    ['string "false"', 'false'],
    ['string "true" (não é o booleano)', 'true'],
    ['número 1', 1],
    ['objeto', { ok: 1 }],
  ])('recusa a credencial quando success é truthy mas não é o booleano true (%s)', async (_label, value) => {
    const fetchMock = vi.fn(async () =>
      fakeResponse(200, JSON.stringify({ success: value }), ['Authentication=Ext1 blob; Path=/']),
    );
    vi.stubGlobal('fetch', fetchMock);

    await expect(loginToSws(IP, CREDENTIALS, IDENTITY)).rejects.toBeInstanceOf(PrinterSwsAuthenticationError);
  });

  it('lança PrinterSwsRequestError quando o corpo do login não é JSON', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, '<html>login page</html>')));

    await expect(loginToSws(IP, CREDENTIALS, IDENTITY)).rejects.toBeInstanceOf(PrinterSwsRequestError);
  });

  it('lança PrinterSwsRequestError quando o login "dá certo" mas não vem cookie de sessão', async () => {
    // Sem cookie, qualquer requisição seguinte seria anônima: o POST de
    // reboot poderia ser descartado pelo firmware e nós relataríamos sucesso.
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(200, JSON.stringify({ success: true }), [])));

    await expect(loginToSws(IP, CREDENTIALS, IDENTITY)).rejects.toBeInstanceOf(PrinterSwsRequestError);
  });

  it('lança PrinterSwsRequestError quando o status é não-2xx', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse(500, 'erro')));

    await expect(loginToSws(IP, CREDENTIALS, IDENTITY)).rejects.toBeInstanceOf(PrinterSwsRequestError);
  });

  it('lança PrinterSwsUnreachableError quando o fetch rejeita', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('EHOSTUNREACH');
      }),
    );

    await expect(loginToSws(IP, CREDENTIALS, IDENTITY)).rejects.toBeInstanceOf(PrinterSwsUnreachableError);
  });

  it('SEGURANÇA: a senha não aparece no corpo enviado nem em erro derivado da exceção nativa', async () => {
    const fetchMock = vi.fn(async () => loginOkResponse());
    vi.stubGlobal('fetch', fetchMock);
    await loginToSws(IP, CREDENTIALS, IDENTITY);
    const [, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(String(init.body)).not.toContain(CREDENTIALS.password);

    // Uma lib de rede pode embutir o que quiser na mensagem do erro nativo
    // (foi exatamente o que aconteceu com o segredo SNMP e a lib net-snmp,
    // ver printer-snmp.service.ts) — o serviço precisa redigir isso, não
    // confiar que nunca acontece.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error(`falha ao enviar corpo contendo ${CREDENTIALS.password}`);
      }),
    );
    const error = await loginToSws(IP, CREDENTIALS, IDENTITY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrinterSwsUnreachableError);
    expect((error as Error).message).not.toContain(CREDENTIALS.password);
    expect((error as Error).message).toContain('[REDACTED]');
  });

  it('SEGURANÇA: senha vazia (padrão de fábrica da HP) não faz a redação apagar a mensagem inteira', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNRESET');
      }),
    );

    const error = await loginToSws(IP, { username: 'admin', password: '' }, IDENTITY).catch((e: unknown) => e);
    expect((error as Error).message).toContain('ECONNRESET');
    expect((error as Error).message).not.toContain('[REDACTED]');
  });
});

describe('rebootHpPrinter', () => {
  it('faz identidade → login → POST de restart com pinCode = MAC em MAIÚSCULAS e o cookie de sessão', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/sws/data/sws_data.js')) return fakeResponse(200, swsDataBody());
      if (String(url).endsWith('/login.jsp')) return loginOkResponse();
      return fakeResponse(200, '{"success":true}');
    });
    vi.stubGlobal('fetch', fetchMock);

    await rebootHpPrinter(IP, '50:81:40:d8:6c:7e', CREDENTIALS);

    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [url, init] = fetchMock.mock.calls[2] as unknown as [string, RequestInit];
    expect(url).toBe(`http://${IP}/sws/app/security/general/reboot/RestartSystem.jsp`);
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/x-www-form-urlencoded',
      Cookie: 'Authentication=Ext1 blob-de-sessao',
    });

    const body = new URLSearchParams(String(init.body));
    // Confirmado ao vivo lendo o reboot.json da impressora real: o pinCode é
    // literalmente o MAC, MAIÚSCULO, com dois-pontos. Minúsculo seria
    // rejeitado.
    expect(body.get('pinCode')).toBe('50:81:40:D8:6C:7E');
    expect(body.get('csrf-token')).toBe(IDENTITY.csrfToken);
  });

  it('não chega a POSTar o restart quando o login é recusado (nenhum reboot com credencial errada)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/sws/data/sws_data.js')) return fakeResponse(200, swsDataBody());
      return fakeResponse(200, JSON.stringify({ success: false }));
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(rebootHpPrinter(IP, '50:81:40:d8:6c:7e', CREDENTIALS)).rejects.toBeInstanceOf(
      PrinterSwsAuthenticationError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('RestartSystem.jsp'))).toBe(false);
  });

  // Contraparte do it.each de loginToSws acima, no nível que importa: a
  // consequência de aceitar um `success` truthy-mas-não-`true` seria REINICIAR
  // o equipamento com uma sessão não autorizada.
  it('não POSTa o restart quando o login responde success truthy sem ser `true` (ex.: a string "false")', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (String(url).endsWith('/sws/data/sws_data.js')) return fakeResponse(200, swsDataBody());
      return fakeResponse(200, JSON.stringify({ success: 'false' }), ['Authentication=Ext1 blob; Path=/']);
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(rebootHpPrinter(IP, '50:81:40:d8:6c:7e', CREDENTIALS)).rejects.toBeInstanceOf(
      PrinterSwsAuthenticationError,
    );
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('RestartSystem.jsp'))).toBe(false);
  });

  it('não chega a fazer login quando o dispositivo não é uma SWS (identidade falha primeiro)', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(404, 'not found'));
    vi.stubGlobal('fetch', fetchMock);

    await expect(rebootHpPrinter(IP, '50:81:40:d8:6c:7e', CREDENTIALS)).rejects.toBeInstanceOf(
      PrinterSwsRequestError,
    );
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('lança PrinterSwsRequestError quando o POST de restart responde não-2xx', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (String(url).endsWith('/sws/data/sws_data.js')) return fakeResponse(200, swsDataBody());
        if (String(url).endsWith('/login.jsp')) return loginOkResponse();
        return fakeResponse(403, 'forbidden');
      }),
    );

    const error = await rebootHpPrinter(IP, '50:81:40:d8:6c:7e', CREDENTIALS).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PrinterSwsRequestError);
    expect((error as PrinterSwsRequestError).status).toBe(403);
  });
});

describe('timeout de requisição', () => {
  // Mesmo raciocínio (e mesmo achado) de printer-brother-wbm.service.test.ts:
  // o `fetch` do Node não tem timeout padrão. Uma impressora que aceita a
  // conexão TCP e nunca responde — firmware ocupado imprimindo é o caso
  // típico — penduraria a rota do dashboard indefinidamente. Este teste
  // falha por timeout se o `signal` do AbortController deixar de ser passado.
  function fetchThatOnlyRespondsToAbort() {
    return vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        }),
    );
  }

  it('aborta com PrinterSwsUnreachableError após 5s de silêncio (e não antes)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchThatOnlyRespondsToAbort());

    let settled = false;
    const promise = fetchDeviceIdentity(IP).then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );

    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(true);
    expect(await promise).toBeInstanceOf(PrinterSwsUnreachableError);
  });

  it('o timeout também vale para o POST de restart (está no helper, não numa função só)', async () => {
    vi.useFakeTimers();
    // Identidade e login respondem na hora; só o restart fica em silêncio.
    const abortOnly = fetchThatOnlyRespondsToAbort();
    vi.stubGlobal(
      'fetch',
      vi.fn((url: string, init: RequestInit) => {
        if (String(url).endsWith('/sws/data/sws_data.js')) return Promise.resolve(fakeResponse(200, swsDataBody()));
        if (String(url).endsWith('/login.jsp')) return Promise.resolve(loginOkResponse());
        return abortOnly(url, init);
      }),
    );

    const promise = rebootHpPrinter(IP, '50:81:40:d8:6c:7e', CREDENTIALS).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_001);

    expect(await promise).toBeInstanceOf(PrinterSwsUnreachableError);
  });

  it('a leitura do CORPO também está dentro do prazo (corpo que nunca termina de chegar)', async () => {
    vi.useFakeTimers();
    // Resposta com status 200 imediato, mas `text()` que só resolve quando o
    // signal aborta: se o clearTimeout acontecesse antes de ler o corpo, esta
    // promessa nunca terminaria.
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async (_url: string, init: RequestInit) =>
          ({
            ok: true,
            status: 200,
            headers: new Headers(),
            text: () =>
              new Promise<string>((_resolve, reject) => {
                init.signal?.addEventListener('abort', () => {
                  reject(new DOMException('The operation was aborted', 'AbortError'));
                });
              }),
          }) as unknown as Response,
      ),
    );

    const promise = fetchDeviceIdentity(IP).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_001);

    expect(await promise).toBeInstanceOf(PrinterSwsUnreachableError);
  });
});
