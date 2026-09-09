import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ORIGINAL_ENV = { ...process.env };

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}

function loginResponse() {
  return jsonResponse(
    { meta: { rc: 'ok' } },
    { headers: { 'set-cookie': 'unifises=abc123; Path=/; HttpOnly', 'x-csrf-token': 'csrf-token-1' } },
  );
}

describe('unifiClassicService', () => {
  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    process.env.UNIFI_CONTROLLER_USER = 'admin';
    process.env.UNIFI_CONTROLLER_PASSWORD = 'secret';
    process.env.UNIFI_CONTROLLER_SITE = 'default';
  });

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it('isConfigured() reflete se as credenciais estão presentes', async () => {
    const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
    expect(unifiClassicService.isConfigured()).toBe(true);
  });

  it('lança ClassicApiNotConfiguredError quando as credenciais não estão configuradas', async () => {
    delete process.env.UNIFI_CONTROLLER_USER;
    delete process.env.UNIFI_CONTROLLER_PASSWORD;
    vi.resetModules();

    const { unifiClassicService, ClassicApiNotConfiguredError } = await import(
      '../../src/services/unifi-classic.service.js'
    );

    await expect(unifiClassicService.blockClient('aa:bb:cc:dd:ee:ff')).rejects.toBeInstanceOf(
      ClassicApiNotConfiguredError,
    );
  });

  it('faz login antes da primeira chamada e reusa a sessão nas seguintes', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/login')) return loginResponse();
      if (url.includes('/rest/user')) {
        return jsonResponse({ meta: { rc: 'ok' }, data: [{ mac: 'aa:bb:cc:dd:ee:ff', blocked: false }] });
      }
      if (url.includes('/cmd/stamgr')) return jsonResponse({ meta: { rc: 'ok' }, data: [{ blocked: true }] });
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');

    await unifiClassicService.blockClient('aa:bb:cc:dd:ee:ff');
    await unifiClassicService.unblockClient('aa:bb:cc:dd:ee:ff');

    const loginCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/login'));
    expect(loginCalls).toHaveLength(1);
  });

  it('refaz login uma vez quando recebe 401 (sessão expirada) e repete a chamada', async () => {
    let restUserCalls = 0;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/login')) return loginResponse();
      if (url.includes('/rest/user')) {
        restUserCalls++;
        if (restUserCalls === 1) return jsonResponse({ meta: { rc: 'error' } }, { status: 401 });
        return jsonResponse({ meta: { rc: 'ok' }, data: [{ mac: 'aa:bb:cc:dd:ee:ff', blocked: false }] });
      }
      if (url.includes('/cmd/stamgr')) return jsonResponse({ meta: { rc: 'ok' }, data: [] });
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');

    await unifiClassicService.blockClient('aa:bb:cc:dd:ee:ff');

    const loginCalls = fetchMock.mock.calls.filter(([url]) => String(url).endsWith('/api/auth/login'));
    expect(loginCalls).toHaveLength(2);
    expect(restUserCalls).toBe(2);
  });

  it('blockClient lança UnknownClientError (404) para um MAC nunca visto, sem chamar cmd/stamgr', async () => {
    const stamgrCalls: string[] = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('/api/auth/login')) return loginResponse();
      if (url.includes('/rest/user')) {
        return jsonResponse({
          meta: { rc: 'ok' },
          data: [{ mac: 'aa:aa:aa:aa:aa:aa', blocked: false }],
        });
      }
      if (url.includes('/cmd/stamgr')) {
        stamgrCalls.push(String(init?.body));
        return jsonResponse({ meta: { rc: 'ok' }, data: [] });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { unifiClassicService, UnknownClientError } = await import(
      '../../src/services/unifi-classic.service.js'
    );

    await expect(unifiClassicService.blockClient('ff:ff:ff:ff:ff:ff')).rejects.toBeInstanceOf(
      UnknownClientError,
    );
    await expect(unifiClassicService.unblockClient('ff:ff:ff:ff:ff:ff')).rejects.toBeInstanceOf(
      UnknownClientError,
    );

    // Nunca deve mandar block-sta/unblock-sta pra um MAC desconhecido —
    // isso é o que cria o registro fantasma no controller.
    expect(stamgrCalls).toHaveLength(0);
  });

  it('UnknownClientError carrega status 404', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/login')) return loginResponse();
      if (url.includes('/rest/user')) return jsonResponse({ meta: { rc: 'ok' }, data: [] });
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { unifiClassicService, UniFiClassicApiError } = await import(
      '../../src/services/unifi-classic.service.js'
    );

    try {
      await unifiClassicService.blockClient('ff:ff:ff:ff:ff:ff');
      expect.unreachable('deveria ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(UniFiClassicApiError);
      expect((err as InstanceType<typeof UniFiClassicApiError>).status).toBe(404);
    }
  });

  it('getBlockedMacs() retorna só os MACs com blocked: true', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/api/auth/login')) return loginResponse();
      if (url.includes('/rest/user')) {
        return jsonResponse({
          meta: { rc: 'ok' },
          data: [
            { mac: 'aa:aa:aa:aa:aa:aa', blocked: true },
            { mac: 'bb:bb:bb:bb:bb:bb', blocked: false },
            { mac: 'cc:cc:cc:cc:cc:cc' },
          ],
        });
      }
      throw new Error(`unexpected url ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);

    const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
    const blocked = await unifiClassicService.getBlockedMacs();

    expect(blocked).toEqual(new Set(['aa:aa:aa:aa:aa:aa']));
  });

  describe('getKnownClientsNetworkInfo() — merge de status de rede do módulo de impressoras', () => {
    it('reusa fetchKnownClients (/rest/user) e devolve um Map por MAC minúsculo com IP e tipo de conexão', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/api/auth/login')) return loginResponse();
        if (url.includes('/rest/user')) {
          return jsonResponse({
            meta: { rc: 'ok' },
            data: [
              // Cliente cabeado com IP dinâmico (last_ip).
              { mac: 'AA:AA:AA:AA:AA:AA', is_wired: true, last_ip: '172.16.0.10' },
              // Cliente sem fio com IP fixo ligado — deve priorizar fixed_ip
              // sobre last_ip (que pode estar desatualizado).
              {
                mac: 'bb:bb:bb:bb:bb:bb',
                is_wired: false,
                use_fixedip: true,
                fixed_ip: '172.16.0.89',
                last_ip: '172.16.0.99',
              },
              // Cliente sem nenhum dado de IP conhecido.
              { mac: 'cc:cc:cc:cc:cc:cc' },
            ],
          });
        }
        throw new Error(`unexpected url ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
      const info = await unifiClassicService.getKnownClientsNetworkInfo();

      // A chave é normalizada pra minúsculas mesmo quando o controller
      // devolve em outra caixa (não deveria acontecer na prática, mas o
      // merge do módulo de impressoras não deve depender de coincidência
      // de caixa em nenhum dos dois lados).
      expect(info.get('aa:aa:aa:aa:aa:aa')).toEqual({ ipAddress: '172.16.0.10', connectionType: 'WIRED' });
      expect(info.get('bb:bb:bb:bb:bb:bb')).toEqual({ ipAddress: '172.16.0.89', connectionType: 'WIRELESS' });
      expect(info.get('cc:cc:cc:cc:cc:cc')).toEqual({ ipAddress: null, connectionType: null });
    });

    it('não duplica a lógica de fetch/login — usa a mesma sessão já autenticada de outra chamada', async () => {
      let loginCalls = 0;
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/api/auth/login')) {
          loginCalls += 1;
          return loginResponse();
        }
        if (url.includes('/rest/user')) {
          return jsonResponse({ meta: { rc: 'ok' }, data: [{ mac: 'aa:aa:aa:aa:aa:aa', is_wired: true }] });
        }
        throw new Error(`unexpected url ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
      await unifiClassicService.getBlockedMacs();
      await unifiClassicService.getKnownClientsNetworkInfo();

      // Um único login pras duas chamadas — confirma que
      // getKnownClientsNetworkInfo reaproveita a mesma sessão/infraestrutura
      // de classicFetch, em vez de reimplementar login.
      expect(loginCalls).toBe(1);
    });
  });

  describe('getPrinterDiscoveryCandidates() — achado 10 do CLAUDE.md', () => {
    // ACHADO REAL (sessão de continuação, contra a rede real desta empresa):
    // um filtro ingênuo por substring de fabricante ("samsung" no OUI) pegou
    // um ar-condicionado, um celular Android e um dispositivo sem hostname
    // junto com as 2 impressoras reais — todos com OUI "Samsung Electronics
    // Co.,Ltd". Os 3 primeiros casos abaixo replicam exatamente isso.
    it('reconhece HP/Brother só pelo OUI (fabricantes inequívocos)', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/api/auth/login')) return loginResponse();
        if (url.includes('/rest/user')) {
          return jsonResponse({
            meta: { rc: 'ok' },
            data: [
              { mac: '50:81:40:D8:6C:7E', oui: 'HP Inc.', hostname: 'COMERCIAL', name: 'HPLaserMFP135w' },
              { mac: 'E8:6F:38:BA:B9:32', oui: 'Brother Industries, Ltd.', hostname: 'HLL2360DWVENDAS' },
            ],
          });
        }
        throw new Error(`unexpected url ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
      const candidates = await unifiClassicService.getPrinterDiscoveryCandidates();

      expect(candidates).toHaveLength(2);
      expect(candidates.map((c) => c.mac)).toEqual(['50:81:40:d8:6c:7e', 'e8:6f:38:ba:b9:32']);
    });

    it('reconhece Brother pelo prefixo de hostname mesmo com OUI diferente/ausente', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/api/auth/login')) return loginResponse();
        if (url.includes('/rest/user')) {
          return jsonResponse({
            meta: { rc: 'ok' },
            data: [{ mac: '84:9E:56:7E:04:45', oui: 'Some Other Vendor', hostname: 'BRW849E567E0445' }],
          });
        }
        throw new Error(`unexpected url ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
      const candidates = await unifiClassicService.getPrinterDiscoveryCandidates();

      expect(candidates.map((c) => c.mac)).toEqual(['84:9e:56:7e:04:45']);
    });

    it('NÃO trata fabricante ambíguo (Samsung/Canon/Epson) como candidato sem indício de impressora no hostname/nome', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/api/auth/login')) return loginResponse();
        if (url.includes('/rest/user')) {
          return jsonResponse({
            meta: { rc: 'ok' },
            data: [
              // Réplica exata dos 3 falsos positivos observados ao vivo.
              { mac: 'BC:45:5B:C0:CE:23', oui: 'Samsung Electronics Co.,Ltd', hostname: 'Samsung' },
              {
                mac: '50:FD:D5:01:EF:9A',
                oui: 'SJI Industry Company',
                hostname: 'Samsung-Room-Airconditioner',
              },
              { mac: '38:9A:F6:9D:89:EB', oui: 'Samsung Electronics Co.,Ltd' },
              { mac: '78:37:16:7C:38:F0', oui: 'Samsung Electronics Co.,Ltd', hostname: 'A03s-de-ADM' },
            ],
          });
        }
        throw new Error(`unexpected url ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
      const candidates = await unifiClassicService.getPrinterDiscoveryCandidates();

      expect(candidates).toHaveLength(0);
    });

    it('trata fabricante ambíguo como candidato QUANDO o hostname/nome também indica impressora', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/api/auth/login')) return loginResponse();
        if (url.includes('/rest/user')) {
          return jsonResponse({
            meta: { rc: 'ok' },
            data: [{ mac: 'AA:BB:CC:DD:EE:FF', oui: 'Canon Inc.', hostname: 'Canon-LaserPrinter' }],
          });
        }
        throw new Error(`unexpected url ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
      const candidates = await unifiClassicService.getPrinterDiscoveryCandidates();

      expect(candidates.map((c) => c.mac)).toEqual(['aa:bb:cc:dd:ee:ff']);
    });

    it('devolve mac em minúsculas, hostname/name/oui/ipAddress do jeito que fetchKnownClientsNetworkInfo já expõe', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/api/auth/login')) return loginResponse();
        if (url.includes('/rest/user')) {
          return jsonResponse({
            meta: { rc: 'ok' },
            data: [
              {
                mac: 'B0:22:7A:4F:63:80',
                oui: 'HP Inc.',
                hostname: 'COMPRAS',
                name: 'HPLaserMFP135w',
                use_fixedip: true,
                fixed_ip: '172.16.0.34',
                last_ip: '172.16.0.34',
              },
            ],
          });
        }
        throw new Error(`unexpected url ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
      const [candidate] = await unifiClassicService.getPrinterDiscoveryCandidates();

      expect(candidate).toEqual({
        mac: 'b0:22:7a:4f:63:80',
        hostname: 'COMPRAS',
        name: 'HPLaserMFP135w',
        oui: 'HP Inc.',
        ipAddress: '172.16.0.34',
      });
    });
  });

  describe('setClientAlias() — Apelido do cliente (rest/user, campo name)', () => {
    it('busca o _id pelo MAC e faz PUT parcial só com { name: alias }, sem os outros campos do cliente', async () => {
      let putUrl: string | undefined;
      let putBody: Record<string, unknown> | undefined;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/auth/login')) return loginResponse();
        if (init?.method === 'PUT' && url.includes('/rest/user/')) {
          putUrl = url;
          putBody = JSON.parse(String(init.body));
          return jsonResponse({ meta: { rc: 'ok' }, data: [{ ...putBody, _id: 'client-id-1' }] });
        }
        if (url.includes('/rest/user')) {
          return jsonResponse({
            meta: { rc: 'ok' },
            data: [
              {
                _id: 'client-id-1',
                mac: 'aa:bb:cc:dd:ee:ff',
                name: 'Nome antigo',
                hostname: 'HP-LaserJet-1020',
                blocked: false,
                use_fixedip: true,
                fixed_ip: '172.16.0.50',
              },
            ],
          });
        }
        throw new Error(`unexpected url ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
      await unifiClassicService.setClientAlias('aa:bb:cc:dd:ee:ff', 'Impressora Recepção');

      expect(putUrl).toContain('/rest/user/client-id-1');
      // Atualização parcial: só `name` vai no corpo, nenhum outro campo do
      // cliente (hostname, blocked, use_fixedip, fixed_ip, mac...) é
      // reenviado junto — diferente do PUT de SSH, que faz merge completo.
      expect(putBody).toEqual({ name: 'Impressora Recepção' });
    });

    it('lança UnknownClientError (404) quando o MAC não é conhecido pelo controller', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/api/auth/login')) return loginResponse();
        if (url.includes('/rest/user')) return jsonResponse({ meta: { rc: 'ok' }, data: [] });
        throw new Error(`unexpected url ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { unifiClassicService, UnknownClientError } = await import(
        '../../src/services/unifi-classic.service.js'
      );

      await expect(unifiClassicService.setClientAlias('ff:ff:ff:ff:ff:ff', 'Novo apelido')).rejects.toBeInstanceOf(
        UnknownClientError,
      );
    });
  });

  // ACHADO AO VIVO (sessão de continuação do reboot HP, 2026-09-09): o
  // campo `hostname` aparece travado (só leitura) na UI do controller. Uma
  // 1ª tentativa (PUT direto em `{ hostname }`, mesmo endpoint que `/alias`
  // usa pra `name`) FOI aceita pelo controller mas confirmada, ao vivo, como
  // NÃO permanente — revertia sozinha em ~20s, provavelmente por um motor
  // interno de fingerprinting/descoberta reafirmando o valor "aprendido"
  // por cima. O mecanismo que realmente funciona (monitorado >100s sem
  // reverter) é o campo oficial `local_dns_record` (visível na própria UI
  // como o checkbox "Registro DNS Local"), que exige `use_fixedip: true`
  // com `fixed_ip` na mesma requisição.
  describe('setClientHostname() — hostname via Local DNS Record (rest/user)', () => {
    it('busca o _id pelo MAC e faz PUT com use_fixedip/fixed_ip + local_dns_record_enabled/local_dns_record', async () => {
      let putUrl: string | undefined;
      let putBody: Record<string, unknown> | undefined;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/auth/login')) return loginResponse();
        if (init?.method === 'PUT' && url.includes('/rest/user/')) {
          putUrl = url;
          putBody = JSON.parse(String(init.body));
          return jsonResponse({ meta: { rc: 'ok' }, data: [{ ...putBody, _id: 'client-id-1' }] });
        }
        if (url.includes('/rest/user')) {
          return jsonResponse({
            meta: { rc: 'ok' },
            data: [
              {
                _id: 'client-id-1',
                mac: 'b0:22:7a:4f:63:80',
                name: 'HPLaserMFP135w Financeiro',
                hostname: 'COMPRAS',
                blocked: false,
                use_fixedip: true,
                fixed_ip: '172.16.0.34',
              },
            ],
          });
        }
        throw new Error(`unexpected url ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
      await unifiClassicService.setClientHostname('b0:22:7a:4f:63:80', 'Financeiro');

      expect(putUrl).toContain('/rest/user/client-id-1');
      // Não reenvia `name` (Apelido) — campo diferente, não deveria ser
      // afetado por essa chamada.
      expect(putBody).toEqual({
        use_fixedip: true,
        fixed_ip: '172.16.0.34',
        local_dns_record_enabled: true,
        local_dns_record: 'Financeiro',
      });
    });

    // ACHADO DO CRÍTICO EM POTENCIAL — validado por mutação mental: sem essa
    // guarda, um cliente sem IP fixo receberia um PUT que o controller real
    // rejeita com `api.err.LocalDnsRecordRequiresFixedIp` (confirmado ao
    // vivo) — e sem este teste, a guarda poderia ser removida silenciosamente
    // sem quebrar nada além do controller real.
    it('lança LocalDnsRecordRequiresFixedIpError (409) quando o cliente não tem IP fixo habilitado', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/api/auth/login')) return loginResponse();
        if (url.includes('/rest/user')) {
          return jsonResponse({
            meta: { rc: 'ok' },
            data: [{ _id: 'client-id-1', mac: 'aa:bb:cc:dd:ee:ff', use_fixedip: false }],
          });
        }
        throw new Error(`unexpected url ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { unifiClassicService, LocalDnsRecordRequiresFixedIpError } = await import(
        '../../src/services/unifi-classic.service.js'
      );

      const error = await unifiClassicService
        .setClientHostname('aa:bb:cc:dd:ee:ff', 'Novo hostname')
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(LocalDnsRecordRequiresFixedIpError);
      expect((error as InstanceType<typeof LocalDnsRecordRequiresFixedIpError>).status).toBe(409);
    });

    it('lança UnknownClientError (404) quando o MAC não é conhecido pelo controller', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/api/auth/login')) return loginResponse();
        if (url.includes('/rest/user')) return jsonResponse({ meta: { rc: 'ok' }, data: [] });
        throw new Error(`unexpected url ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { unifiClassicService, UnknownClientError } = await import(
        '../../src/services/unifi-classic.service.js'
      );

      await expect(unifiClassicService.setClientHostname('ff:ff:ff:ff:ff:ff', 'Novo hostname')).rejects.toBeInstanceOf(
        UnknownClientError,
      );
    });
  });

  describe('SSH dos equipamentos (get/setting mgmt)', () => {
    function mgmtSettingFixture(overrides: Record<string, unknown> = {}) {
      return {
        _id: 'mgmt-id-1',
        key: 'mgmt',
        site_id: 'site-1',
        x_ssh_enabled: true,
        x_ssh_username: '9KYZHt6',
        x_ssh_password: 'senha-atual-secreta',
        x_ssh_sha512passwd: 'hash-atual-secreto',
        x_ssh_auth_password_enabled: true,
        x_ssh_bind_wildcard: false,
        x_api_token: 'token-secreto',
        x_mgmt_key: 'chave-secreta',
        wifiman_enabled: true,
        advanced_feature_enabled: false,
        ...overrides,
      };
    }

    it('getSshInfo() retorna só os campos públicos — sem senha, hash, token ou chave', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/api/auth/login')) return loginResponse();
        if (url.includes('/get/setting')) {
          return jsonResponse({
            meta: { rc: 'ok' },
            data: [{ _id: 'wifi-id', key: 'other' }, mgmtSettingFixture()],
          });
        }
        throw new Error(`unexpected url ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
      const info = await unifiClassicService.getSshInfo();

      expect(info).toEqual({ sshEnabled: true, sshUsername: '9KYZHt6', passwordAuthEnabled: true });
      expect(Object.keys(info)).toEqual(['sshEnabled', 'sshUsername', 'passwordAuthEnabled']);
    });

    it('rotateSshCredentials() sem password: gera uma senha forte aleatória com node:crypto', async () => {
      let putBody: Record<string, unknown> | undefined;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/auth/login')) return loginResponse();
        if (url.includes('/get/setting')) {
          return jsonResponse({ meta: { rc: 'ok' }, data: [mgmtSettingFixture()] });
        }
        if (url.includes('/set/setting/mgmt/')) {
          putBody = JSON.parse(String(init?.body));
          return jsonResponse({ meta: { rc: 'ok' }, data: [putBody] });
        }
        throw new Error(`unexpected url ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
      const result = await unifiClassicService.rotateSshCredentials({});

      expect(result.sshUsername).toBe('9KYZHt6');
      expect(result.sshPassword).toBeTruthy();
      expect(result.sshPassword).not.toBe('senha-atual-secreta');
      expect(result.sshPassword.length).toBeGreaterThanOrEqual(20);

      // O PUT precisa preservar TODOS os outros campos do GET original.
      expect(putBody).toMatchObject({
        _id: 'mgmt-id-1',
        key: 'mgmt',
        site_id: 'site-1',
        x_api_token: 'token-secreto',
        x_mgmt_key: 'chave-secreta',
        wifiman_enabled: true,
        advanced_feature_enabled: false,
      });
      expect(putBody?.x_ssh_password).toBe(result.sshPassword);
    });

    it('rotateSshCredentials() com username/password fornecidos: usa exatamente os valores dados', async () => {
      let putBody: Record<string, unknown> | undefined;
      const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('/api/auth/login')) return loginResponse();
        if (url.includes('/get/setting')) {
          return jsonResponse({ meta: { rc: 'ok' }, data: [mgmtSettingFixture()] });
        }
        if (url.includes('/set/setting/mgmt/')) {
          putBody = JSON.parse(String(init?.body));
          return jsonResponse({ meta: { rc: 'ok' }, data: [putBody] });
        }
        throw new Error(`unexpected url ${url}`);
      });
      vi.stubGlobal('fetch', fetchMock);

      const { unifiClassicService } = await import('../../src/services/unifi-classic.service.js');
      const result = await unifiClassicService.rotateSshCredentials({
        username: 'novo-usuario',
        password: 'senha-fornecida-pelo-chamador',
      });

      expect(result).toEqual({ sshUsername: 'novo-usuario', sshPassword: 'senha-fornecida-pelo-chamador' });
      expect(putBody?.x_ssh_username).toBe('novo-usuario');
      expect(putBody?.x_ssh_password).toBe('senha-fornecida-pelo-chamador');
    });
  });
});
