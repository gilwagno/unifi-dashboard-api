// Sonda: o Guacamole aceita ATRIBUTO CUSTOM numa conexão?
//
// Decisão-chave da subtarefa 4 (Onda 4): qual é a âncora estável que casa
// "computador do AD" com "conexão do Guacamole". O nome não serve — quebra
// em renomeação. Se a conexão puder carregar o objectGUID/SID do computador,
// essa é a âncora robusta (mesmo papel que o `external_id` tem no módulo de
// VPN). Esta sonda responde isso contra o Guacamole REAL, não pela doc.
//
// Cria e remove uma conexão descartável própria. Uso: node tools/guacamole-attr-probe.mjs
import fs from 'node:fs';

const B = 'http://127.0.0.1:8080/guacamole';
const env = Object.fromEntries(
  fs.readFileSync('.env', 'utf8').split(/\r?\n/)
    .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean)
    .map((m) => [m[1], m[2].trim()]),
);

const token = (
  await (
    await fetch(`${B}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ username: env.GUACAMOLE_USERNAME, password: env.GUACAMOLE_PASSWORD }),
    })
  ).json()
).authToken;
const U = (p) => `${B}/api/session/data/${env.GUACAMOLE_DATA_SOURCE ?? 'postgresql'}${p}?token=${token}`;

// 1. O que o Guacamole DECLARA aceitar como atributo de conexão.
const schema = await (await fetch(U('/schema/connectionAttributes'))).json();
console.log('=== atributos de conexão declarados no schema ===');
for (const form of schema) {
  console.log(` form "${form.name}": ${form.fields.map((f) => `${f.name}(${f.type})`).join(', ')}`);
}

// 2. Tentar gravar um atributo CUSTOM junto de um PADRÃO (controle).
const GUID = 'a1b2c3d4-0000-1111-2222-333344445555';
const res = await fetch(U('/connections'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    parentIdentifier: 'ROOT',
    name: 'probe-atributo-custom',
    protocol: 'rdp',
    parameters: { hostname: 'x.invalido', port: '3389' },
    attributes: { 'ad-object-guid': GUID, 'max-connections': '1' },
  }),
});
const created = await res.json();
console.log(`\ncriar com atributo custom: HTTP ${res.status}, identifier=${created.identifier}`);

const back = await (await fetch(U(`/connections/${created.identifier}`))).json();
console.log('atributos na releitura:', JSON.stringify(back.attributes));
console.log(
  '>>> atributo CUSTOM sobreviveu?',
  JSON.stringify(back.attributes ?? {}).includes(GUID) ? 'SIM' : 'NAO — descartado em silêncio',
);
console.log('>>> atributo PADRAO (max-connections) sobreviveu?', back.attributes?.['max-connections'] ?? 'nao');

// 3. E se o custom for gravado como PARÂMETRO em vez de atributo?
const res2 = await fetch(U(`/connections/${created.identifier}`), {
  method: 'PUT',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    identifier: created.identifier,
    parentIdentifier: 'ROOT',
    name: 'probe-atributo-custom',
    protocol: 'rdp',
    parameters: { hostname: 'x.invalido', port: '3389', 'ad-object-guid': GUID },
    attributes: {},
  }),
});
const params = await (await fetch(U(`/connections/${created.identifier}/parameters`))).json();
console.log(`\nPUT com parametro custom: HTTP ${res2.status}`);
console.log('parametros na releitura:', JSON.stringify(params));
console.log(
  '>>> parametro CUSTOM sobreviveu?',
  JSON.stringify(params).includes(GUID) ? 'SIM' : 'NAO — descartado em silêncio',
);

await fetch(U(`/connections/${created.identifier}`), { method: 'DELETE' });
console.log('\nconexao de sonda removida');
