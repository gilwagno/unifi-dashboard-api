// Teste de fumaça da ABERTURA DE SESSÃO (Onda 4, subtarefa 5) contra o
// Guacamole REAL, chamando as funções de produção.
//
// O que ele prova, e que nenhum mock provaria:
//   - a conta por pessoa é criada de verdade e REUSADA na segunda abertura
//     (chave estável: sem isso, acumularia órfãos);
//   - o token devolvido é o DA PESSOA e ele NÃO carrega CREATE_CONNECTION —
//     ou seja, o buraco de escalação de privilégio está fechado no sistema
//     real, não só no teste unitário;
//   - a pessoa recebe READ só na conexão da sessão, e mais nada.
//
// Cria e remove tudo o que usa. Uso: npx tsx tools/guacamole-session-smoke.mts
import { remoteAccessService } from '../src/services/remote-access.service.js';

const PESSOA = 'smoke-descartavel';
const B = process.env.GUACAMOLE_URL!.replace(/\/+$/, '');
const DS = process.env.GUACAMOLE_DATA_SOURCE ?? 'postgresql';

function check(label: string, ok: boolean, detail = ''): void {
  console.log(`${ok ? 'OK  ' : 'FALHA'} ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) process.exitCode = 1;
}

async function comoServico(): Promise<string> {
  const res = await fetch(`${B}/api/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      username: process.env.GUACAMOLE_USERNAME!,
      password: process.env.GUACAMOLE_PASSWORD!,
    }),
  });
  return ((await res.json()) as { authToken: string }).authToken;
}

const conexao = await remoteAccessService.createRdpConnection({
  name: 'smoke-sessao',
  hostname: 'vm-de-teste.invalido',
  adObjectGuid: 'c1c04940-1c5b-4cfa-a4f9-d05689e80045',
});
check('conexão de teste criada', Boolean(conexao.identifier), `identifier=${conexao.identifier}`);

// --- 1a abertura: a conta da pessoa não existe ainda ---
const s1 = await remoteAccessService.openSession(PESSOA, conexao);
check('sessão aberta', Boolean(s1.url), s1.guacamoleUser);
check('conta da pessoa tem nome determinístico', s1.guacamoleUser === `dash-${PESSOA}`, s1.guacamoleUser);
check('a URL aponta para o cliente do Guacamole', s1.url.includes('/#/client/'));

const token1 = new URL(s1.url.replace('/#/', '/')).searchParams.get('token') ?? '';
check('a URL carrega um token', token1.length > 0);

// --- a prova que importa: o token da pessoa NÃO é o do serviço ---
const permsPessoa = (await (
  await fetch(`${B}/api/session/data/${DS}/self/permissions?token=${token1}`)
).json()) as { systemPermissions?: string[]; connectionPermissions?: Record<string, string[]> };

check(
  'o token da pessoa NÃO carrega CREATE_CONNECTION',
  !(permsPessoa.systemPermissions ?? []).includes('CREATE_CONNECTION'),
  JSON.stringify(permsPessoa.systemPermissions ?? []),
);
check(
  'o token da pessoa não tem permissão de sistema nenhuma',
  (permsPessoa.systemPermissions ?? []).length === 0,
);
check(
  'a pessoa tem READ na conexão da sessão',
  (permsPessoa.connectionPermissions ?? {})[conexao.identifier]?.includes('READ') === true,
  JSON.stringify(permsPessoa.connectionPermissions ?? {}),
);
check(
  'a pessoa não recebeu ADMINISTER na conexão',
  !(permsPessoa.connectionPermissions ?? {})[conexao.identifier]?.includes('ADMINISTER'),
);

// --- 2a abertura: a conta tem de ser REUSADA, não duplicada ---
const svc = await comoServico();
const usuariosAntes = Object.keys(
  (await (await fetch(`${B}/api/session/data/${DS}/users?token=${svc}`)).json()) as object,
);

const s2 = await remoteAccessService.openSession(PESSOA, conexao);
const usuariosDepois = Object.keys(
  (await (await fetch(`${B}/api/session/data/${DS}/users?token=${svc}`)).json()) as object,
);

check('2a abertura reusa a MESMA conta', s2.guacamoleUser === s1.guacamoleUser, s2.guacamoleUser);
check(
  '2a abertura não criou conta nova',
  usuariosDepois.length === usuariosAntes.length,
  `${usuariosAntes.length} -> ${usuariosDepois.length}`,
);
check('a 2a sessão tem token próprio (senha rotacionada)', !s2.url.includes(token1));

// --- limpeza ---
await fetch(`${B}/api/session/data/${DS}/users/${s1.guacamoleUser}?token=${svc}`, { method: 'DELETE' });
await remoteAccessService.deleteConnection(conexao.identifier);

const restantes = (await (await fetch(`${B}/api/session/data/${DS}/users?token=${svc}`)).json()) as object;
check('conta descartável removida', !(s1.guacamoleUser in restantes), Object.keys(restantes).join(', '));
const catalogo = await remoteAccessService.listConnections();
check('catálogo devolvido ao estado inicial', catalogo.length === 0, `${catalogo.length} conexão(ões)`);
