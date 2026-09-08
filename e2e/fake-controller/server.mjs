/**
 * Controller UniFi FAKE — usado SOMENTE pelos testes e2e (Playwright).
 *
 * Existe por uma razão de segurança: os testes e2e exercitam ações
 * destrutivas e irreversíveis num controller de verdade (bloquear cliente,
 * trocar a senha de SSH de TODOS os APs do site, criar/remover SSID). Nunca
 * podem tocar hardware real. Este servidor simula o controller o suficiente
 * para os três fluxos testados.
 *
 * Por que HTTPS com certificado autoassinado (e não HTTP puro): os dois
 * services do backend montam a base URL como `https://${CONTROLLER_HOST}`
 * (src/services/unifi.service.ts e src/services/unifi-classic.service.ts) —
 * o esquema é fixo no código, não dá pra apontar pra um `http://` sem
 * alterar código de produção. Com UNIFI_ALLOW_SELF_SIGNED=true o backend
 * seta NODE_TLS_REJECT_UNAUTHORIZED=0, então um certificado autoassinado
 * gerado em memória (pacote `selfsigned`, sem openssl e sem arquivo de
 * chave privada versionado no repo) é aceito normalmente.
 *
 * Duas superfícies de API são simuladas, exatamente como o backend as usa:
 *   1. Integration API oficial  -> /proxy/network/integration/v1/...
 *      autenticada por header X-API-Key
 *   2. API clássica/privada     -> /api/auth/login + /proxy/network/api/...
 *      autenticada por cookie de sessão + X-Csrf-Token
 *
 * Todo o estado é em memória e reiniciado a cada boot do processo, então
 * cada execução da suíte começa de um estado conhecido.
 */
import https from 'node:https';
import { randomUUID } from 'node:crypto';
import selfsigned from 'selfsigned';

const PORT = Number(process.env.FAKE_CONTROLLER_PORT ?? 8443);
const API_KEY = process.env.FAKE_CONTROLLER_API_KEY ?? 'fake-api-key-e2e';
const SITE_ID = process.env.FAKE_CONTROLLER_SITE_ID ?? '11111111-2222-3333-4444-555555555555';
const CLASSIC_SITE = process.env.FAKE_CONTROLLER_CLASSIC_SITE ?? 'default';
const CLASSIC_USER = process.env.FAKE_CONTROLLER_USER ?? 'controller-admin';
const CLASSIC_PASSWORD = process.env.FAKE_CONTROLLER_PASSWORD ?? 'controller-password';

const SESSION_COOKIE = 'TOKEN=fake-session-token-e2e';
const CSRF_TOKEN = 'fake-csrf-token-e2e';

// --- Estado em memória -----------------------------------------------------

/** Clientes conhecidos. `blocked` é a fonte da verdade do fluxo 1. */
const clients = [
  {
    _id: 'user-0001',
    id: 'client-0001',
    macAddress: 'aa:bb:cc:dd:ee:01',
    ipAddress: '10.0.0.51',
    name: 'Notebook Financeiro',
    hostname: 'nb-financeiro',
    type: 'WIRELESS',
    blocked: false,
    use_fixedip: false,
    fixed_ip: null,
  },
  {
    _id: 'user-0002',
    id: 'client-0002',
    macAddress: 'aa:bb:cc:dd:ee:02',
    ipAddress: '10.0.0.52',
    name: 'Impressora Recepcao',
    hostname: 'impressora-recepcao',
    type: 'WIRED',
    blocked: false,
    use_fixedip: false,
    fixed_ip: null,
  },
];

const devices = [
  {
    id: 'device-0001',
    name: 'AP Recepcao',
    model: 'U6-Pro',
    macAddress: 'aa:bb:cc:00:00:01',
    ipAddress: '10.0.0.11',
    state: 'ONLINE',
  },
];

/** Redes Wi-Fi (SSIDs). Mutável: o fluxo 3 cria e remove uma daqui. */
const wifiBroadcasts = [
  {
    id: 'wifi-existente-0001',
    type: 'STANDARD',
    name: 'Escritorio-Existente',
    enabled: true,
    hideName: false,
    clientIsolationEnabled: false,
    bssTransitionEnabled: true,
    broadcastingFrequenciesGHz: [2.4, 5],
    network: { type: 'NATIVE' },
    securityConfiguration: { type: 'WPA2_PERSONAL', passphrase: 'senha-existente', fastRoamingEnabled: false },
  },
];

const networks = [
  {
    id: 'network-0001',
    management: 'GATEWAY',
    name: 'Default',
    enabled: true,
    vlanId: 1,
    zoneId: 'zone-internal',
    ipv4Configuration: { hostIpAddress: '10.0.0.1', prefixLength: 24 },
  },
];

const firewallZones = [
  { id: 'zone-internal', name: 'Internal', networkIds: ['network-0001'] },
  { id: 'zone-external', name: 'External', networkIds: [] },
];

const radiusProfiles = [{ id: 'radius-0001', name: 'RADIUS Windows AD', metadata: {} }];

/**
 * Setting "mgmt" — credencial de SSH única por site. O fluxo 2 faz o PUT
 * aqui. Guardamos a senha como o controller real guardaria; o backend nunca
 * a lê de volta (GET /ssh-credentials só devolve usuário/flags).
 */
const mgmtSetting = {
  _id: 'mgmt-setting-0001',
  key: 'mgmt',
  site_id: 'site-interno-0001',
  x_ssh_enabled: true,
  x_ssh_username: 'ubnt',
  x_ssh_password: 'senha-inicial-do-controller',
  x_ssh_sha512passwd: '$6$fake$hash',
  x_ssh_auth_password_enabled: true,
  x_ssh_bind_wildcard: false,
  x_api_token: 'token-secreto-que-nao-pode-vazar',
  x_mgmt_key: 'mgmt-key-secreta',
  wifiman_enabled: true,
};

const otherSettings = [{ _id: 'setting-guest', key: 'guest_access' }];

/** Log de tudo que o backend chamou — útil para depurar um teste que falha. */
const callLog = [];

// --- Helpers ---------------------------------------------------------------

function send(res, status, body, extraHeaders = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    ...extraHeaders,
  });
  res.end(payload);
}

function classicOk(res, data = []) {
  send(res, 200, { meta: { rc: 'ok' }, data });
}

function readBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (chunk) => {
      raw += chunk;
    });
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        resolve({});
      }
    });
  });
}

function hasValidApiKey(req) {
  return req.headers['x-api-key'] === API_KEY;
}

function hasValidClassicSession(req) {
  return req.headers.cookie === SESSION_COOKIE && req.headers['x-csrf-token'] === CSRF_TOKEN;
}

function toIntegrationClient(client) {
  return {
    id: client.id,
    macAddress: client.macAddress,
    ipAddress: client.ipAddress,
    name: client.name,
    hostname: client.hostname,
    type: client.type,
    // A Integration API real não traz `blocked` confiável — o backend cruza
    // isso com /rest/user da API clássica. Reproduzimos essa limitação de
    // propósito: sempre false aqui.
    blocked: false,
    connectedAt: new Date(Date.now() - 3_600_000).toISOString(),
  };
}

function toClassicUser(client) {
  return {
    _id: client._id,
    mac: client.macAddress,
    hostname: client.hostname,
    name: client.name,
    blocked: client.blocked,
    use_fixedip: client.use_fixedip,
    fixed_ip: client.fixed_ip,
  };
}

function findClientByMac(mac) {
  return clients.find((c) => c.macAddress.toLowerCase() === String(mac).toLowerCase());
}

// --- Roteamento: Integration API -------------------------------------------

const INTEGRATION_PREFIX = '/proxy/network/integration/v1';

async function handleIntegration(req, res, path, body) {
  if (!hasValidApiKey(req)) {
    return send(res, 401, { code: 'UNAUTHORIZED', message: 'X-API-Key inválido ou ausente' });
  }

  if (req.method === 'GET' && path === '/sites') {
    return send(res, 200, {
      data: [{ id: SITE_ID, internalReference: CLASSIC_SITE, name: 'Site de Teste E2E' }],
    });
  }

  const siteMatch = path.match(/^\/sites\/([^/]+)(\/.*)?$/);
  if (!siteMatch) return send(res, 404, { code: 'NOT_FOUND', message: `Rota desconhecida: ${path}` });

  const [, siteId, rest = ''] = siteMatch;
  if (siteId !== SITE_ID) {
    return send(res, 404, { code: 'SITE_NOT_FOUND', message: `Site ${siteId} não existe` });
  }

  if (req.method === 'GET' && rest === '/clients') {
    return send(res, 200, { data: clients.map(toIntegrationClient) });
  }

  if (req.method === 'GET' && rest === '/devices') {
    return send(res, 200, { data: devices });
  }

  if (req.method === 'GET' && rest === '/networks') {
    return send(res, 200, { data: networks });
  }

  if (req.method === 'GET' && rest === '/firewall/zones') {
    return send(res, 200, { data: firewallZones });
  }

  if (req.method === 'GET' && rest === '/radius/profiles') {
    return send(res, 200, {
      count: radiusProfiles.length,
      totalCount: radiusProfiles.length,
      limit: 25,
      offset: 0,
      data: radiusProfiles,
    });
  }

  if (rest === '/wifi/broadcasts') {
    if (req.method === 'GET') return send(res, 200, { data: wifiBroadcasts });

    if (req.method === 'POST') {
      // Validações que o controller real faz e que já quebraram este
      // projeto antes (ver comentários em src/types/unifi.ts).
      if (!body.name) return send(res, 400, { code: 'BAD_REQUEST', message: 'name is required' });
      if (body.securityConfiguration?.type === 'WPA2_PERSONAL') {
        if (!body.securityConfiguration.passphrase) {
          return send(res, 400, {
            code: 'BAD_REQUEST',
            message:
              'WPA2 personal security requires exactly one of [preshared keys setting, all of [network setting, passphrase setting]]',
          });
        }
        if (!body.network) {
          return send(res, 400, { code: 'BAD_REQUEST', message: 'network setting is required' });
        }
        if (body.bssTransitionEnabled && body.securityConfiguration.fastRoamingEnabled === undefined) {
          return send(res, 400, {
            code: 'BAD_REQUEST',
            message: 'WPA security combined with standard WiFi requires fast roaming setting',
          });
        }
      }
      if (wifiBroadcasts.some((w) => w.name === body.name)) {
        return send(res, 400, { code: 'BAD_REQUEST', message: `Já existe uma rede chamada ${body.name}` });
      }

      const created = { ...body, id: `wifi-${randomUUID()}` };
      wifiBroadcasts.push(created);
      return send(res, 200, created);
    }
  }

  const broadcastMatch = rest.match(/^\/wifi\/broadcasts\/([^/]+)$/);
  if (broadcastMatch) {
    const [, id] = broadcastMatch;
    const index = wifiBroadcasts.findIndex((w) => w.id === id);
    if (index === -1) {
      return send(res, 404, { code: 'NOT_FOUND', message: `Rede Wi-Fi ${id} não encontrada` });
    }

    if (req.method === 'GET') return send(res, 200, wifiBroadcasts[index]);

    if (req.method === 'PUT') {
      wifiBroadcasts[index] = { ...body, id };
      return send(res, 200, wifiBroadcasts[index]);
    }

    if (req.method === 'DELETE') {
      wifiBroadcasts.splice(index, 1);
      // O controller real responde 200 com corpo VAZIO neste DELETE (não
      // 204, e não um JSON) — comportamento explicitamente tratado em
      // unifiFetch(). Reproduzido aqui de propósito.
      res.writeHead(200, { 'Content-Length': '0' });
      return res.end();
    }
  }

  const networkMatch = rest.match(/^\/networks\/([^/]+)$/);
  if (networkMatch && req.method === 'DELETE') {
    const index = networks.findIndex((n) => n.id === networkMatch[1]);
    if (index === -1) return send(res, 404, { code: 'NOT_FOUND', message: 'Network não encontrada' });
    networks.splice(index, 1);
    res.writeHead(200, { 'Content-Length': '0' });
    return res.end();
  }

  if (rest === '/networks' && req.method === 'POST') {
    if (!body.zoneId) return send(res, 400, { code: 'BAD_REQUEST', message: 'zoneId must not be null' });
    const created = { ...body, id: `network-${randomUUID()}` };
    networks.push(created);
    return send(res, 200, created);
  }

  return send(res, 404, { code: 'NOT_FOUND', message: `Rota desconhecida: ${req.method} ${path}` });
}

// --- Roteamento: API clássica/privada --------------------------------------

async function handleClassic(req, res, path, body) {
  if (path === '/api/auth/login' && req.method === 'POST') {
    if (body.username !== CLASSIC_USER || body.password !== CLASSIC_PASSWORD) {
      return send(res, 401, { meta: { rc: 'error', msg: 'api.err.Invalid' }, data: [] });
    }
    return send(res, 200, { meta: { rc: 'ok' }, data: [] }, {
      // O service só guarda a primeira parte antes do ';' — mantemos os
      // atributos para ficar igual ao controller real.
      'Set-Cookie': `${SESSION_COOKIE}; Path=/; HttpOnly; Secure; SameSite=Strict`,
      'X-Csrf-Token': CSRF_TOKEN,
    });
  }

  if (!hasValidClassicSession(req)) {
    return send(res, 401, { meta: { rc: 'error', msg: 'api.err.LoginRequired' }, data: [] });
  }

  if (path === '/proxy/network/api/stat/admin' && req.method === 'GET') {
    return classicOk(res, [
      { name: 'admin-do-controller', email: 'admin@exemplo.local', roles: [{ site_name: 'Default', role: 'admin' }] },
    ]);
  }

  const sitePrefix = `/proxy/network/api/s/${CLASSIC_SITE}`;
  const v2Prefix = `/proxy/network/v2/api/site/${CLASSIC_SITE}`;

  if (path.startsWith(`${v2Prefix}/aggregated-dashboard`) && req.method === 'GET') {
    return send(res, 200, {
      cybersecure: { ips_enabled: true, threats: 3, signatures: 42000 },
      upgradable_device_count: { device_count: 1 },
      wan_history: { wan_history_details: [{ health_history: [] }] },
    });
  }

  if (path === `${v2Prefix}/system-log/critical` && req.method === 'POST') {
    return send(res, 200, [{ msg: 'Evento critico simulado pelo controller fake' }]);
  }

  if (path === `${sitePrefix}/rest/user` && req.method === 'GET') {
    return classicOk(res, clients.map(toClassicUser));
  }

  const restUserMatch = path.match(new RegExp(`^${sitePrefix}/rest/user/([^/]+)$`));
  if (restUserMatch && req.method === 'PUT') {
    const client = clients.find((c) => c._id === restUserMatch[1]);
    if (!client) return send(res, 404, { meta: { rc: 'error', msg: 'api.err.NoSuchUser' }, data: [] });
    if (typeof body.use_fixedip === 'boolean') client.use_fixedip = body.use_fixedip;
    if (body.fixed_ip !== undefined) client.fixed_ip = body.fixed_ip;
    // `name` é o "Apelido" exibido no painel (PATCH /clients/:mac/alias). Sem
    // aplicá-lo aqui o fake aceitava o PUT e descartava o campo em silêncio,
    // o que tornava qualquer teste de alias vazio: mandar `hostname` (que é
    // só-leitura no controller real) em vez de `name` continuava "passando".
    // `hostname` NÃO é aceito de propósito — é o que o dispositivo anuncia.
    if (typeof body.name === 'string') client.name = body.name;
    return classicOk(res, [toClassicUser(client)]);
  }

  if (path === `${sitePrefix}/cmd/stamgr` && req.method === 'POST') {
    const client = findClientByMac(body.mac);
    if (!client) {
      // O controller real NÃO valida isso (cria um registro fantasma) — o
      // backend é que valida antes. Aqui devolvemos erro para não mascarar
      // um bug caso essa validação do backend seja removida.
      return send(res, 400, { meta: { rc: 'error', msg: 'api.err.UnknownStation' }, data: [] });
    }
    if (body.cmd === 'block-sta') client.blocked = true;
    else if (body.cmd === 'unblock-sta') client.blocked = false;
    else return send(res, 400, { meta: { rc: 'error', msg: 'api.err.InvalidCmd' }, data: [] });
    return classicOk(res, [toClassicUser(client)]);
  }

  if (path === `${sitePrefix}/get/setting` && req.method === 'GET') {
    return classicOk(res, [...otherSettings, mgmtSetting]);
  }

  if (path === `${sitePrefix}/set/setting/mgmt/${mgmtSetting._id}` && req.method === 'PUT') {
    // PUT de objeto inteiro: o controller real substitui o documento. Se o
    // backend deixasse de reenviar um campo (ex: x_api_token), ele sumiria
    // aqui — e o teste de rotação verifica justamente que isso não acontece.
    if (!body.x_ssh_password) {
      return send(res, 400, { meta: { rc: 'error', msg: 'api.err.NoPassword' }, data: [] });
    }
    for (const key of Object.keys(mgmtSetting)) delete mgmtSetting[key];
    Object.assign(mgmtSetting, body, { x_ssh_sha512passwd: `$6$fake$${body.x_ssh_password.slice(0, 8)}` });
    return classicOk(res, [mgmtSetting]);
  }

  if (path === `${sitePrefix}/stat/device` && req.method === 'POST') {
    return classicOk(res, [
      {
        mac: devices[0].macAddress,
        name: devices[0].name,
        'system-stats': { cpu: '12', mem: '48', uptime: '86400' },
        uptime: 86400,
        num_sta: 2,
        rx_bytes: 1000,
        tx_bytes: 2000,
        radio_table_stats: [{ name: 'ra0', radio: 'na', channel: 36, cu_total: 20, satisfaction: 97, num_sta: 2 }],
      },
    ]);
  }

  if (path === `${sitePrefix}/stat/sta` && req.method === 'GET') {
    return classicOk(
      res,
      clients.map((c) => ({
        mac: c.macAddress,
        hostname: c.hostname,
        is_wired: c.type === 'WIRED',
        signal: -55,
        rssi: 40,
        satisfaction: 95,
        channel: 36,
        rx_bytes: 500,
        tx_bytes: 700,
      })),
    );
  }

  return send(res, 404, { meta: { rc: 'error', msg: `api.err.NoSuchRoute ${req.method} ${path}` }, data: [] });
}

// --- Servidor --------------------------------------------------------------

// Certificado gerado EM MEMÓRIA a cada boot — nenhuma chave privada fica
// versionada no repositório e não há dependência do openssl da máquina.
// `generate` é assíncrono no selfsigned v5.
const pems = await selfsigned.generate([{ name: 'commonName', value: '127.0.0.1' }], {
  keySize: 2048,
  // `selfsigned` assina com SHA-1 por padrão; o OpenSSL 3 embutido no Node
  // recusa o handshake nesse caso ("tls alert handshake failure", alerta
  // nº 40) mesmo com a verificação de certificado desligada — a rejeição é
  // do algoritmo de assinatura, não da cadeia de confiança.
  algorithm: 'sha256',
  extensions: [
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, keyEncipherment: true },
    { name: 'extKeyUsage', serverAuth: true },
    {
      name: 'subjectAltName',
      altNames: [
        { type: 7, ip: '127.0.0.1' },
        { type: 7, ip: '::1' },
        { type: 2, value: 'localhost' },
      ],
    },
  ],
});

const server = https.createServer({ key: pems.private, cert: pems.cert }, async (req, res) => {
  const url = new URL(req.url, `https://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const body = ['POST', 'PUT', 'PATCH'].includes(req.method) ? await readBody(req) : {};

  callLog.push({ at: new Date().toISOString(), method: req.method, path });
  console.log(`[fake-controller] ${req.method} ${req.url}`);

  try {
    // Rota de diagnóstico do próprio fake (não faz parte da API do UniFi).
    if (path === '/__e2e/calls') return send(res, 200, { data: callLog });

    if (path.startsWith(INTEGRATION_PREFIX)) {
      return await handleIntegration(req, res, path.slice(INTEGRATION_PREFIX.length) || '/', body);
    }
    return await handleClassic(req, res, path, body);
  } catch (err) {
    console.error('[fake-controller] erro interno', err);
    return send(res, 500, { message: String(err) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[fake-controller] escutando em https://127.0.0.1:${PORT} (site ${SITE_ID})`);
});
