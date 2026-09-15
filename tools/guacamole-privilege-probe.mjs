// Sonda-chave da subtarefa 5: CREATE_USER está CONTIDO?
//
// O desenho aprovado dá `CREATE_USER` ao usuário de serviço, para ele
// provisionar uma conta Guacamole por pessoa. Isso só é seguro se valer uma
// propriedade: **quem cria um usuário não pode conceder a ele mais poder do
// que ele próprio tem**. Se puder, `CREATE_USER` é equivalente a admin na
// prática — bastaria criar um admin e usá-lo — e o modelo de menor
// privilégio desaba em silêncio.
//
// Isso é o tipo de coisa que "deveria" funcionar assim. Esta sonda MEDE.
//
// Escreve: concede CREATE_USER ao usuário de serviço (mudança pretendida do
// desenho) e cria/remove um usuário descartável. Uso:
//   node tools/guacamole-privilege-probe.mjs
import fs from 'node:fs';

const B = 'http://127.0.0.1:8080/guacamole';

function readEnv(file) {
  return Object.fromEntries(
    fs.readFileSync(file, 'utf8').split(/\r?\n/)
      .map((l) => l.match(/^([A-Z_]+)=(.*)$/)).filter(Boolean)
      .map((m) => [m[1], m[2].trim()]),
  );
}
const app = readEnv('.env');
const infra = readEnv('guacamole/.env');
const ds = app.GUACAMOLE_DATA_SOURCE ?? 'postgresql';

async function login(username, password) {
  const res = await fetch(`${B}/api/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password }),
  });
  if (!res.ok) throw new Error(`login de ${username} falhou: ${res.status}`);
  return (await res.json()).authToken;
}
const U = (token, path) => `${B}/api/session/data/${ds}${path}?token=${token}`;

let falhas = 0;
function check(label, ok, detail = '') {
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) falhas += 1;
}

const admin = await login(infra.GUACAMOLE_ADMIN_USER ?? 'guacadmin', infra.GUACAMOLE_ADMIN_PASSWORD);

// 1. Conceder CREATE_USER ao usuário de serviço (a mudança do desenho).
const grant = await fetch(U(admin, `/users/${app.GUACAMOLE_USERNAME}/permissions`), {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify([{ op: 'add', path: '/systemPermissions', value: 'CREATE_USER' }]),
});
check('guacadmin concede CREATE_USER ao usuário de serviço', grant.ok, `HTTP ${grant.status}`);

const svc = await login(app.GUACAMOLE_USERNAME, app.GUACAMOLE_PASSWORD);
const perms = await (await fetch(U(svc, `/self/permissions`))).json();
console.log('permissões do usuário de serviço agora:', JSON.stringify(perms.systemPermissions));

// 2. Ele consegue criar um usuário? (é o objetivo, tem que funcionar)
const alvo = 'probe-escalonamento';
const criar = await fetch(U(svc, '/users'), {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: alvo, password: 'senha-descartavel-probe-1', attributes: {} }),
});
check('usuário de serviço cria um usuário', criar.ok, `HTTP ${criar.status}`);

// 3. O TESTE QUE IMPORTA: ele consegue dar ao novo usuário poder que ele
//    mesmo NÃO tem? Cada uma destas tentativas tem que ser RECUSADA.
async function tentarConceder(alvoUsuario, permissao) {
  const res = await fetch(U(svc, `/users/${alvoUsuario}/permissions`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify([{ op: 'add', path: '/systemPermissions', value: permissao }]),
  });
  let efetivou = false;
  if (res.ok) {
    // "HTTP 200" não prova gravação — lição da subtarefa 4. Relê.
    const depois = await (await fetch(U(admin, `/users/${alvoUsuario}/permissions`))).json();
    efetivou = (depois.systemPermissions ?? []).includes(permissao);
  }
  return { status: res.status, efetivou };
}

const admin1 = await tentarConceder(alvo, 'ADMINISTER');
check(
  'RECUSA conceder ADMINISTER a um usuário novo',
  !admin1.efetivou,
  `HTTP ${admin1.status}, efetivou=${admin1.efetivou}`,
);

const cadeia = await tentarConceder(alvo, 'CREATE_USER');
check(
  'RECUSA auto-replicação em cadeia (dar CREATE_USER adiante)',
  !cadeia.efetivou,
  `HTTP ${cadeia.status}, efetivou=${cadeia.efetivou}`,
);

const auto = await tentarConceder(app.GUACAMOLE_USERNAME, 'ADMINISTER');
check(
  'RECUSA AUTO-PROMOÇÃO (dar ADMINISTER a si mesmo)',
  !auto.efetivou,
  `HTTP ${auto.status}, efetivou=${auto.efetivou}`,
);

// 4. Limpeza: o usuário descartável sai.
const del = await fetch(U(svc, `/users/${alvo}`), { method: 'DELETE' });
console.log(`\nlimpeza do usuário descartável: HTTP ${del.status}`);
const restou = await (await fetch(U(admin, '/users'))).json();
check('usuário descartável removido', !(alvo in restou), Object.keys(restou).join(', '));

console.log(
  falhas === 0
    ? '\n>>> CREATE_USER está CONTIDO: medido, não assumido.'
    : `\n>>> ${falhas} verificação(ões) falharam — o desenho precisa ser repensado.`,
);
process.exitCode = falhas === 0 ? 0 : 1;
