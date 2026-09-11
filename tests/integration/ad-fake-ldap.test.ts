import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Attribute, Change, Client, NoSuchAttributeError, TypeOrValueExistsError } from 'ldapts';
import { startFakeLdapServer } from '../../e2e/fake-ldap-server/server.mjs';
import type { AdUser } from '../../src/services/ad.service.js';

// Onda 3, subtarefa 6 (ver docs/ad-module-plan.md) — ESTE é o arquivo que
// prova que `ad.service.ts` fala LDAP de verdade, não só "constrói os
// objetos que o mock `ldapts` de tests/unit/ad.service.test.ts sabe
// interpretar". Nada aqui mocka `ldapts` — o client REAL conecta via TCP/
// TLS num `e2e/fake-ldap-server` que fala o protocolo BER de verdade (bind/
// search/add/modify/del/unbind).
//
// Cada `describe` abaixo roda as 11 funções de usuário do serviço contra o
// servidor real. `vi.resetModules()` + reimport dinâmico (mesmo truque já
// usado em tests/unit/ad.service.test.ts) garante que `src/config/env.ts`
// releia `process.env.AD_*` — incluindo a porta do fake server, que muda a
// cada execução (`startFakeLdapServer` usa porta 0 = "o SO escolhe uma
// livre", para nunca colidir com outra suíte/execução em paralelo).

let fakeLdap: Awaited<ReturnType<typeof startFakeLdapServer>>;

async function importAdService() {
  vi.resetModules();
  process.env.AD_URL = fakeLdap.url;
  process.env.AD_BASE_DN = fakeLdap.baseDn;
  process.env.AD_BIND_DN = fakeLdap.bindDn;
  process.env.AD_BIND_PASSWORD = fakeLdap.bindPassword;
  process.env.AD_USERS_OU = fakeLdap.usersOu;
  process.env.AD_NETWORK_ACCESS_GROUP_DN = fakeLdap.networkAccessGroupDn;
  // Único jeito de aceitar o certificado autoassinado do fake sem desligar
  // verificação TLS globalmente no processo (ver o comentário desta
  // variável em src/config/env.ts) — nunca usar isto contra um AD real.
  process.env.AD_TLS_REJECT_UNAUTHORIZED = 'false';
  return import('../../src/services/ad.service.js');
}

beforeAll(async () => {
  fakeLdap = await startFakeLdapServer();
});

afterAll(async () => {
  await fakeLdap.stop();
});

afterEach(() => {
  delete process.env.AD_URL;
  delete process.env.AD_BASE_DN;
  delete process.env.AD_BIND_DN;
  delete process.env.AD_BIND_PASSWORD;
  delete process.env.AD_USERS_OU;
  delete process.env.AD_NETWORK_ACCESS_GROUP_DN;
  delete process.env.AD_TLS_REJECT_UNAUTHORIZED;
});

// O diretório do fake é recriado do zero (3 usuários semeados: jsilva
// habilitado, mreis desabilitado, ptravado bloqueado — ver
// e2e/fake-ldap-server/server.mjs#seedDirectory) a cada `startFakeLdapServer`,
// mas os testes MUTAM esse mesmo diretório (create/update/delete/modify) —
// então cada `describe` sobe seu PRÓPRIO servidor (`beforeEach` local) para
// não vazar estado de um teste para o outro.
describe('ad.service — protocolo LDAP real (fake-ldap-server)', () => {
  beforeEach(async () => {
    await fakeLdap.stop();
    fakeLdap = await startFakeLdapServer();
  });

  it('searchUsers() sem query lista os 3 usuários semeados', async () => {
    const { searchUsers } = await importAdService();
    const users = await searchUsers();
    expect(users.map((u) => u.sAMAccountName).sort()).toEqual(['jsilva', 'mreis', 'ptravado']);
  });

  it('searchUsers(query) usa filtro OR de substring (cn/sAMAccountName/mail) — o servidor real decide o match, não um mock', async () => {
    const { searchUsers } = await importAdService();
    const users = await searchUsers('silva');
    expect(users).toHaveLength(1);
    expect(users[0]?.sAMAccountName).toBe('jsilva');

    // Casa por substring de e-mail também (mesmo filtro OR) — prova que o
    // `parseFilter`/`matchesFilter` do fake trata os 3 ramos do OR, não só
    // o primeiro que bate. "reis@fakeldap" só existe no `mail` de mreis
    // (não em cn/sAMAccountName de ninguém), então só o ramo `mail=*...*`
    // pode ser o responsável pelo match.
    const byMail = await searchUsers('reis@fakeldap');
    expect(byMail.map((u) => u.sAMAccountName)).toEqual(['mreis']);
  });

  it('getUser() decodifica userAccountControl/lockoutTime reais devolvidos pelo servidor', async () => {
    const { getUser } = await importAdService();

    const enabled = await getUser('jsilva');
    expect(enabled.enabled).toBe(true);
    expect(enabled.lockedOut).toBe(false);
    expect(enabled.mail).toBe('joao.silva@fakeldap.test');
    expect(enabled.department).toBe('TI');

    const disabled = await getUser('mreis');
    expect(disabled.enabled).toBe(false);

    const locked = await getUser('ptravado');
    expect(locked.lockedOut).toBe(true);
  });

  it('getUser() de quem não existe -> AdUserNotFoundError (resultCode 32 do servidor real, não um mock)', async () => {
    const { getUser, AdUserNotFoundError } = await importAdService();
    await expect(getUser('ninguem')).rejects.toBeInstanceOf(AdUserNotFoundError);
  });

  it('createUser() cria via add()+modify() atômico real e o usuário aparece habilitado numa releitura real', async () => {
    const { createUser, getUser } = await importAdService();

    const created = await createUser({
      sAMAccountName: 'testuser',
      displayName: 'Usuário de Teste',
      mail: 'testuser@fakeldap.test',
      password: 'S3nhaForte!2026',
    });

    expect(created.sAMAccountName).toBe('testuser');
    // O achado bloqueante da revisão crítica da PR #25 era exatamente
    // isto: o `add` (desabilitado) + o `modify` atômico (habilita + senha)
    // — contra o mock, "atômico" só provava que o serviço despachava 1
    // `client.modify` em vez de 2. Contra o servidor REAL, isto prova que
    // o próprio protocolo aceita várias mudanças (unicodePwd +
    // userAccountControl) num único ModifyRequest.
    expect(created.enabled).toBe(true);

    const reread = await getUser('testuser');
    expect(reread.enabled).toBe(true);
    expect(reread.mail).toBe('testuser@fakeldap.test');
  });

  it('createUser() com sAMAccountName contendo vírgula: o DN sai escapado de verdade — achado da revisão crítica da PR #25, agora provado contra o protocolo real', async () => {
    const { createUser, getUser, deleteUser } = await importAdService();

    // A rota (ad.routes.ts) barra vírgula por Zod — mas o SERVIÇO em si
    // (chamado aqui direto, sem a rota) precisa continuar seguro por
    // conta própria (defesa em profundidade, ver o comentário de
    // `buildUserDn` em ad.service.ts). Sem o escape real de `DN.addPairRDN`,
    // isto produziria "CN=a,b,OU=Funcionarios,..." — um RDN A MAIS,
    // silenciosamente criando a entrada FORA da OU pretendida (ou o
    // próprio servidor recusando o `add` por não achar o container
    // "b,OU=Funcionarios,...").
    const created = await createUser({
      sAMAccountName: 'a,b',
      displayName: 'Nome Com Virgula',
      password: 'OutraSenhaForte!2026',
    });

    expect(created.sAMAccountName).toBe('a,b');
    // Se o DN não tivesse saído escapado, esta entrada NÃO estaria sob
    // `usersOu` (o "b" teria virado um RDN irmão) — confirmamos o
    // contrário, direto no diretório do fake (sem passar pelo service).
    const normalized = created.dn.toLowerCase().replace(/,\s+/g, ',');
    expect(normalized.endsWith(`,${fakeLdap.usersOu.toLowerCase()}`)).toBe(true);

    const reread = await getUser('a,b');
    expect(reread.sAMAccountName).toBe('a,b');

    await deleteUser('a,b');
  });

  it('createUser() de sAMAccountName já existente -> AdPasswordAmbiguousError não se aplica; erro genérico vem do resultCode 68 real do servidor', async () => {
    const { createUser, AdRequestError } = await importAdService();
    await createUser({ sAMAccountName: 'duplicado', displayName: 'Um', password: 'SenhaForte!2026' });
    await expect(createUser({ sAMAccountName: 'duplicado', displayName: 'Dois', password: 'OutraSenhaForte!2026' })).rejects.toBeInstanceOf(
      AdRequestError,
    );
  });

  it('updateUser() aplica replace real e a releitura reflete a mudança', async () => {
    const { updateUser, getUser } = await importAdService();
    const updated = await updateUser('jsilva', { department: 'Financeiro', title: 'Coordenador' });
    expect(updated.department).toBe('Financeiro');
    expect(updated.title).toBe('Coordenador');

    const reread = await getUser('jsilva');
    expect(reread.department).toBe('Financeiro');
  });

  it('deleteUser() remove de verdade — some de uma busca real subsequente', async () => {
    const { deleteUser, searchUsers, getUser, AdUserNotFoundError } = await importAdService();
    await deleteUser('mreis');
    const users = await searchUsers();
    expect(users.map((u) => u.sAMAccountName)).not.toContain('mreis');
    await expect(getUser('mreis')).rejects.toBeInstanceOf(AdUserNotFoundError);
  });

  it('deleteUser() de quem não existe -> AdUserNotFoundError (via NoSuchObjectError real, resultCode 32)', async () => {
    const { deleteUser, AdUserNotFoundError } = await importAdService();
    await expect(deleteUser('ninguem')).rejects.toBeInstanceOf(AdUserNotFoundError);
  });

  it('setUserEnabled() liga/desliga o bit UF_ACCOUNTDISABLE via replace real, preservando os demais bits', async () => {
    const { setUserEnabled, getUser } = await importAdService();

    await setUserEnabled('jsilva', false);
    expect((await getUser('jsilva')).enabled).toBe(false);

    await setUserEnabled('jsilva', true);
    expect((await getUser('jsilva')).enabled).toBe(true);
  });

  it('unlockUser() zera lockoutTime real — o usuário bloqueado semeado deixa de estar bloqueado', async () => {
    const { unlockUser, getUser } = await importAdService();
    expect((await getUser('ptravado')).lockedOut).toBe(true);
    await unlockUser('ptravado');
    expect((await getUser('ptravado')).lockedOut).toBe(false);
  });

  it('resetPassword() com mustChangePasswordAtNextLogon: unicodePwd + pwdLastSet no MESMO ModifyRequest — o servidor real aceita os 2 changes atômicos', async () => {
    const { resetPassword } = await importAdService();
    // Não há como reler `unicodePwd` via LDAP (nem no AD real, nem aqui) —
    // o que este teste prova é que a chamada NÃO lança, ou seja, que o
    // servidor real aceitou um ModifyRequest com 2 `changes` de tipos
    // diferentes numa única mensagem (a garantia de atomicidade que o
    // docblock de `resetPassword` em ad.service.ts documenta).
    await expect(resetPassword('jsilva', 'NovaSenhaForte!2026', true)).resolves.toBeUndefined();
  });

  it('setUserWorkstations() grava via replace e remove via delete (lista vazia) — os dois ramos contra o servidor real', async () => {
    const { setUserWorkstations, getUser } = await importAdService();

    await setUserWorkstations('jsilva', ['PC-FINANCEIRO', 'PC-COMPRAS']);
    expect((await getUser('jsilva')).userWorkstations).toEqual(['PC-FINANCEIRO', 'PC-COMPRAS']);

    // Lista vazia -> Change{operation:'delete'} SEM valores, ou seja
    // "apagar o atributo inteiro" (RFC 4511 §4.6) — um `replace` com lista
    // vazia teria o MESMO efeito observável aqui, mas o `delete` é o que
    // `setUserWorkstations` realmente despacha (ver comentário no
    // serviço); provar que o servidor aceita e o atributo some de verdade
    // é o que importa.
    await setUserWorkstations('jsilva', []);
    expect((await getUser('jsilva')).userWorkstations).toEqual([]);
  });

  it('ponte 802.1X: grantNetworkAccess()/revokeNetworkAccess() alteram `member` de verdade no grupo real, e os dois são idempotentes', async () => {
    const { grantNetworkAccess, revokeNetworkAccess, getUser } = await importAdService();
    const jsilva = await getUser('jsilva');

    const memberOf = () =>
      Array.from(fakeLdap.directory.values())
        .find((e) => e.dn === fakeLdap.networkAccessGroupDn)
        ?.attrs.get('member')
        ?.map((b: Buffer) => b.toString('utf8').toLowerCase()) ?? [];

    expect(memberOf()).not.toContain(jsilva.dn.toLowerCase());

    await grantNetworkAccess('jsilva');
    expect(memberOf()).toContain(jsilva.dn.toLowerCase());

    // Idempotente: o servidor real recusa um 2º `add` do MESMO valor
    // (resultCode 20, TypeOrValueExistsError) — grantNetworkAccess precisa
    // engolir isso e não lançar (achado da revisão crítica da PR #25).
    await expect(grantNetworkAccess('jsilva')).resolves.toBeUndefined();

    await revokeNetworkAccess('jsilva');
    expect(memberOf()).not.toContain(jsilva.dn.toLowerCase());

    // Idempotente no sentido inverso: o servidor real recusa um `delete`
    // de valor que não existe mais (resultCode 16, NoSuchAttributeError).
    await expect(revokeNetworkAccess('jsilva')).resolves.toBeUndefined();
  });

  it('grantNetworkAccess()/revokeNetworkAccess() sem AD_NETWORK_ACCESS_GROUP_DN configurado -> erro tipado, sem nem tentar conectar', async () => {
    const service = await importAdService();
    delete process.env.AD_NETWORK_ACCESS_GROUP_DN;
    vi.resetModules();
    const fresh = await import('../../src/services/ad.service.js');
    await expect(fresh.grantNetworkAccess('jsilva')).rejects.toBeInstanceOf(fresh.AdNetworkAccessGroupNotConfiguredError);
    void service;
  });

  it('bind com credencial errada -> AdRequestError real (o servidor recusa com resultCode 49, InvalidCredentialsError, antes de qualquer outra operação)', async () => {
    await importAdService();
    process.env.AD_BIND_PASSWORD = 'senha-errada-de-proposito';
    vi.resetModules();
    const fresh = await import('../../src/services/ad.service.js');
    await expect(fresh.searchUsers()).rejects.toBeInstanceOf(fresh.AdRequestError);
  });

  it('AD_URL apontando para um servidor que não existe -> AdRequestError (nunca uma exceção não tratada escapando de withClient)', async () => {
    await importAdService();
    process.env.AD_URL = 'ldaps://127.0.0.1:1';
    vi.resetModules();
    const fresh = await import('../../src/services/ad.service.js');
    await expect(fresh.searchUsers()).rejects.toBeInstanceOf(fresh.AdRequestError);
  });
});

// --- Achados da verificação (Onda 3, subtarefa 6) ------------------------
//
// Estes dois blocos existem porque a revisão às cegas provou por MUTAÇÃO
// que as duas garantias abaixo estavam sem NENHUM teste: os dois mutantes
// SOBREVIVERAM com a suíte inteira verde (675/675).

describe('AD_TLS_REJECT_UNAUTHORIZED — o default seguro', () => {
  // MUTANTE QUE ISTO MATA: trocar `.default('true')` por `.default('false')`
  // em src/config/env.ts. Sem este teste, a suíte ficava verde com a
  // verificação de certificado da conexão LDAPS DESLIGADA por padrão — a
  // conexão que carrega AD_BIND_DN/AD_BIND_PASSWORD contra o DC real
  // aceitaria qualquer certificado, sem ninguém perceber.
  it('sem a env var definida, o default é true E o client REAL de fato recusa um certificado autoassinado', async () => {
    vi.resetModules();
    process.env.AD_URL = fakeLdap.url;
    process.env.AD_BASE_DN = fakeLdap.baseDn;
    process.env.AD_BIND_DN = fakeLdap.bindDn;
    process.env.AD_BIND_PASSWORD = fakeLdap.bindPassword;
    process.env.AD_USERS_OU = fakeLdap.usersOu;
    delete process.env.AD_TLS_REJECT_UNAUTHORIZED;

    const { env } = await import('../../src/config/env.js');
    expect(env.AD_TLS_REJECT_UNAUTHORIZED).toBe(true);

    // Não basta ler a config: prova o EFEITO no caminho de produção
    // (`withClient` é o mesmo para teste e para um AD real — não existe
    // client separado). Com o default `true`, o handshake contra o fake
    // (certificado autoassinado) precisa falhar de verdade.
    const service = await import('../../src/services/ad.service.js');
    await expect(service.searchUsers()).rejects.toThrow(/self-signed|self signed|certificate/i);
  });

  // Fail-safe: só a string exata 'false' desliga. Qualquer outro valor
  // (typo, 'FALSE', '0', vazio) precisa continuar VERIFICANDO.
  it.each(['FALSE', '0', 'no', ''])('valor %o não desliga a verificação (só a string exata "false")', async (value) => {
    vi.resetModules();
    process.env.AD_TLS_REJECT_UNAUTHORIZED = value;
    const { env } = await import('../../src/config/env.js');
    expect(env.AD_TLS_REJECT_UNAUTHORIZED).toBe(true);
  });
});

describe('fake-ldap-server — semântica de erro do ModifyRequest (RFC 4511 §4.6)', () => {
  // MUTANTE QUE ISTO MATA: remover o "Passo 1: validar TODOS os changes"
  // de handleModify (e2e/fake-ldap-server/server.mjs). Sem este teste o
  // fake ficava GENEROSO DEMAIS — aceitava calado um `add` de valor já
  // existente e um `delete` de valor ausente. Consequência real: os `catch`
  // de TypeOrValueExistsError/NoSuchAttributeError em
  // grantNetworkAccess/revokeNetworkAccess (o achado bloqueante da revisão
  // crítica da PR #25) NUNCA eram exercitados, apesar de o teste de
  // idempotência acima afirmar em comentário que eram — o servidor jamais
  // chegava a recusar nada.
  let client: Client;
  const groupDn = () => fakeLdap.networkAccessGroupDn;
  const memberDn = 'CN=jsilva,OU=Funcionarios,DC=fakeldap,DC=test';

  beforeEach(async () => {
    await fakeLdap.stop();
    fakeLdap = await startFakeLdapServer();
    client = new Client({ url: fakeLdap.url, tlsOptions: { rejectUnauthorized: false } });
    await client.bind(fakeLdap.bindDn, fakeLdap.bindPassword);
  });

  afterEach(async () => {
    await client.unbind().catch(() => undefined);
  });

  it('add de um valor que JÁ existe -> TypeOrValueExistsError (resultCode 20) de verdade', async () => {
    const change = new Change({ operation: 'add', modification: new Attribute({ type: 'member', values: [memberDn] }) });
    await client.modify(groupDn(), change);
    await expect(client.modify(groupDn(), change)).rejects.toBeInstanceOf(TypeOrValueExistsError);
  });

  it('delete de um valor que NÃO existe -> NoSuchAttributeError (resultCode 16) de verdade', async () => {
    const del = new Change({ operation: 'delete', modification: new Attribute({ type: 'member', values: [memberDn] }) });
    await expect(client.modify(groupDn(), del)).rejects.toBeInstanceOf(NoSuchAttributeError);
  });

  it('atomicidade: um ModifyRequest com 2 changes, o 2º inválido, não aplica NENHUM dos dois', async () => {
    const ok = new Change({ operation: 'replace', modification: new Attribute({ type: 'department', values: ['Novo'] }) });
    const bad = new Change({ operation: 'delete', modification: new Attribute({ type: 'title', values: ['NaoExiste'] }) });
    await expect(client.modify(memberDn, [ok, bad])).rejects.toBeInstanceOf(NoSuchAttributeError);

    const entry = Array.from(fakeLdap.directory.values()).find((e) => e.dn === memberDn);
    expect(entry?.attrs.get('department')?.map((b: Buffer) => b.toString('utf8'))).toEqual(['TI']);
  });
});

// Confirma que o tipo exportado pelo serviço bate com o que o servidor real
// devolve (sanity check de tipos, não de comportamento).
void (null as unknown as AdUser);
