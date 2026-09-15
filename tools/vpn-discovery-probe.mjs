// Sonda de descoberta de VPN — SOMENTE LEITURA.
//
// Subtarefa 0 da Onda de VPN. Faz APENAS GETs contra o controller real (API
// clássica + Integration API) para localizar ONDE a VPN vive antes de
// qualquer código de escrita. Nenhuma requisição de escrita é feita aqui, e
// todo campo de material criptográfico (`x_*`, `*private_key*`) é redigido
// na saída — o objeto cru de um servidor de VPN carrega a chave privada
// WireGuard e a CA/chave do servidor OpenVPN.
//
// Uso: node tools/vpn-discovery-probe.mjs
// Achados registrados em docs/vpn-classic-api-research.md.
import fs from 'node:fs';
import https from 'node:https';

const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

const HOST = env.CONTROLLER_HOST;
const SITE = env.UNIFI_CONTROLLER_SITE || 'default';
const agent = new https.Agent({ rejectUnauthorized: false });

function req(method, path, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const r = https.request(
      { hostname: HOST, path, method, agent, headers: { Accept: 'application/json', ...headers } },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: data }));
      },
    );
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

// Redige material criptográfico antes de qualquer impressão.
const redact = (o) => {
  const c = { ...o };
  for (const k of Object.keys(c)) if (/^x_|private_key|preshared|password/i.test(k)) c[k] = '<REDIGIDO>';
  return c;
};

const login = await req('POST', '/api/auth/login', {
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: env.UNIFI_CONTROLLER_USER, password: env.UNIFI_CONTROLLER_PASSWORD }),
});
if (login.status !== 200) {
  console.error('login na API clássica falhou:', login.status, login.body.slice(0, 200));
  process.exit(1);
}
const cookie = String(login.headers['set-cookie']?.[0] || '').split(';')[0];
const G = (p) => req('GET', p, { headers: { Cookie: cookie } });

const sysinfo = JSON.parse((await G(`/proxy/network/api/s/${SITE}/stat/sysinfo`)).body).data[0];
console.log(`controller ${sysinfo.version} | console ${sysinfo.ubnt_device_type}\n`);

// 1) Onde a VPN vive na clássica: networkconf, não um endpoint /vpn.
console.log('=== clássica: rest/networkconf ===');
const nc = JSON.parse((await G(`/proxy/network/api/s/${SITE}/rest/networkconf`)).body);
for (const n of nc.data) {
  console.log(`- ${n.name} | purpose=${n.purpose}${n.vpn_type ? ` | vpn_type=${n.vpn_type}` : ''} | _id=${n._id}`);
}
for (const n of nc.data) {
  if (!/vpn/i.test(n.purpose)) continue;
  console.log(`\n--- objeto completo: ${n.name} ---`);
  console.log(JSON.stringify(redact(n), null, 2));
}

// 2) Teleport / Site Magic vivem em rest/setting, não em networkconf.
console.log('\n=== clássica: rest/setting (chaves relacionadas a VPN) ===');
const st = JSON.parse((await G(`/proxy/network/api/s/${SITE}/rest/setting`)).body);
for (const s of st.data) {
  if (/teleport|vpn|ipsec/i.test(s.key)) console.log(`\n--- ${s.key} ---\n${JSON.stringify(redact(s), null, 2)}`);
}

// 3) Endpoints de VPN que NÃO existem na clássica (registrar o 404 é o achado).
console.log('\n=== clássica: endpoints de VPN inexistentes (esperado 404) ===');
for (const p of [
  `/proxy/network/v2/api/site/${SITE}/vpn`,
  `/proxy/network/v2/api/site/${SITE}/vpn/servers`,
  `/proxy/network/api/s/${SITE}/stat/remoteuservpn`,
]) {
  console.log(`[${(await G(p)).status}] ${p}`);
}

// 4) Integration API oficial: existe uma lista só-leitura, e nada além dela.
console.log('\n=== Integration API oficial ===');
const I = (p) => req('GET', p, { headers: { 'X-API-KEY': env.UNIFI_API_KEY } });
const B = `/proxy/network/integration/v1/sites/${env.SITE_ID}`;
for (const p of [`${B}/vpn/servers`, `${B}/vpn`, `${B}/vpn/clients`, `${B}/vpn/site-to-site`, `${B}/vpn/tunnels`]) {
  const r = await I(p);
  console.log(`[${r.status}] ${p}\n   ${r.body.slice(0, 260).replace(/\s+/g, ' ')}`);
}
