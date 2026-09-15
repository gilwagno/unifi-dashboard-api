// Sonda: como o Guacamole pode abrir uma sessão em PASSE-THROUGH?
//
// Decisão que abre a subtarefa 5. Três coisas a descobrir contra o Guacamole
// REAL, antes de escolher o desenho:
//   1. o RDP declara username/password como parâmetros OPCIONAIS? (se sim, a
//      conexão sem credencial é válida e o Guacamole pede ao usuário)
//   2. quais extensões de autenticação estão instaladas? (LDAP mudaria tudo)
//   3. o token de sessão que a API devolve é do USUÁRIO que autenticou —
//      então entregar ao navegador o token do usuário de SERVIÇO daria ao
//      cliente os poderes dele (CREATE_CONNECTION). Confirmar.
//
// Somente leitura. Uso: node tools/guacamole-session-probe.mjs
import fs from 'node:fs';

const B = 'http://127.0.0.1:8080/guacamole';
const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

const login = await (
  await fetch(`${B}/api/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: env.GUACAMOLE_USERNAME, password: env.GUACAMOLE_PASSWORD }),
  })
).json();
const token = login.authToken;
const ds = env.GUACAMOLE_DATA_SOURCE ?? 'postgresql';

console.log('=== 1. o que o login devolve ===');
console.log(JSON.stringify({ ...login, authToken: '<token>' }, null, 2));

console.log('\n=== 2. parâmetros do protocolo rdp (credenciais são opcionais?) ===');
const protocolos = await (await fetch(`${B}/api/session/data/${ds}/schema/protocols?token=${token}`)).json();
const rdp = protocolos.rdp;
for (const form of rdp.connectionForms) {
  const campos = form.fields.map((f) => `${f.name}(${f.type})`).join(', ');
  console.log(` form "${form.name}": ${campos}`);
}
const todosCampos = rdp.connectionForms.flatMap((f) => f.fields);
for (const nome of ['username', 'password', 'domain']) {
  const campo = todosCampos.find((f) => f.name === nome);
  console.log(` campo "${nome}": ${campo ? `existe, type=${campo.type}` : 'NAO EXISTE'}`);
}

console.log('\n=== 3. extensões de autenticação instaladas ===');
const patches = await (await fetch(`${B}/api/patches`)).json().catch(() => null);
console.log(' /api/patches:', JSON.stringify(patches)?.slice(0, 200));
const langs = await (await fetch(`${B}/api/languages`)).json().catch(() => null);
console.log(' idiomas disponíveis:', Object.keys(langs ?? {}).join(', '));

console.log('\n=== 4. o token é do usuário que autenticou ===');
const self = await (await fetch(`${B}/api/session/data/${ds}/self/permissions?token=${token}`)).json();
console.log(' permissões de quem detém o token:', JSON.stringify(self.systemPermissions));
console.log(
  ' >>> entregar ESTE token ao navegador daria ao cliente estes poderes:',
  self.systemPermissions?.length ? self.systemPermissions.join(', ') : '(nenhum)',
);
