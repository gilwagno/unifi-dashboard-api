import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { Attribute, Change, Client, InvalidCredentialsError, NoSuchAttributeError, OperationsError, TypeOrValueExistsError } from 'ldapts';
import selfsigned from 'selfsigned';
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
// Diretório temporário só para os arquivos PEM de CA que os testes
// escrevem em disco (AD_TLS_CA_FILE exige um caminho de arquivo, não um
// PEM inline) — nunca dentro do repo, sempre limpo no afterAll.
let tmpDir: string;
let trustedCaFile: string;

async function importAdService() {
  vi.resetModules();
  process.env.AD_URL = fakeLdap.url;
  process.env.AD_BASE_DN = fakeLdap.baseDn;
  process.env.AD_BIND_DN = fakeLdap.bindDn;
  process.env.AD_BIND_PASSWORD = fakeLdap.bindPassword;
  process.env.AD_USERS_OU = fakeLdap.usersOu;
  process.env.AD_GROUPS_OU = fakeLdap.groupsOu;
  process.env.AD_NETWORK_ACCESS_GROUP_DN = fakeLdap.networkAccessGroupDn;
  // A verificação de certificado continua LIGADA (não existe — e nunca
  // existiu, de propósito — uma variável para desligá-la, ver o comentário
  // de `AD_TLS_CA_FILE` em src/config/env.ts): isto só ESTENDE a lista de
  // CAs confiadas com a CA do fake (autoassinado, então o certificado dele
  // é sua própria CA raiz — ver `caCert` no retorno de `startFakeLdapServer`).
  process.env.AD_TLS_CA_FILE = trustedCaFile;
  return import('../../src/services/ad.service.js');
}

beforeAll(async () => {
  fakeLdap = await startFakeLdapServer();
  tmpDir = mkdtempSync(join(tmpdir(), 'ad-fake-ldap-ca-'));
  trustedCaFile = join(tmpDir, 'fake-ldap-ca.pem');
  writeFileSync(trustedCaFile, fakeLdap.caCert, 'utf8');
});

afterAll(async () => {
  await fakeLdap.stop();
  rmSync(tmpDir, { recursive: true, force: true });
});

afterEach(() => {
  delete process.env.AD_URL;
  delete process.env.AD_BASE_DN;
  delete process.env.AD_BIND_DN;
  delete process.env.AD_BIND_PASSWORD;
  delete process.env.AD_USERS_OU;
  delete process.env.AD_GROUPS_OU;
  delete process.env.AD_NETWORK_ACCESS_GROUP_DN;
  delete process.env.AD_TLS_CA_FILE;
});

// Cada `describe` abaixo sobe seu PRÓPRIO servidor por teste (ver comentário
// junto de cada `beforeEach` local) para isolar o diretório mutado — mas
// cada boot novo gera um par de chave/certificado NOVO (`selfsigned`, ver
// server.mjs), então o arquivo de CA confiada precisa ser reescrito a cada
// restart. Sem isto, só o PRIMEIRO teste de cada arquivo funcionaria — os
// seguintes tentariam validar um certificado novo contra a CA do certificado
// ANTERIOR e o handshake TLS falharia de verdade (exatamente o
// comportamento que este arquivo existe para provar, só que no lugar errado).
// Lê um atributo (multivalorado, armazenado como Buffer[] no diretório em
// memória do fake) como strings — usado só para inspecionar o DN CRU de uma
// entrada pelo valor de outro atributo (ver o teste de escape de DN de
// createGroup mais abaixo).
function getAttrStringsForTest(entry: { attrs: Map<string, Buffer[]> }, name: string): string[] {
  return (entry.attrs.get(name.toLowerCase()) ?? []).map((b) => b.toString('utf8'));
}

async function restartFakeLdap(): Promise<void> {
  await fakeLdap.stop();
  fakeLdap = await startFakeLdapServer();
  writeFileSync(trustedCaFile, fakeLdap.caCert, 'utf8');
}

// O diretório do fake é recriado do zero (3 usuários semeados: jsilva
// habilitado, mreis desabilitado, ptravado bloqueado — ver
// e2e/fake-ldap-server/server.mjs#seedDirectory) a cada `startFakeLdapServer`,
// mas os testes MUTAM esse mesmo diretório (create/update/delete/modify) —
// então cada `describe` sobe seu PRÓPRIO servidor (`beforeEach` local) para
// não vazar estado de um teste para o outro.
describe('ad.service — protocolo LDAP real (fake-ldap-server)', () => {
  beforeEach(restartFakeLdap);

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

// Onda 3, subtarefa 3 (grupos/privilégios) — mesmo princípio da subtarefa 6:
// prova que ad.service.ts fala o PROTOCOLO LDAP real para grupos, não só o
// que um `vi.mock('ldapts')` sabe interpretar (ver tests/unit/
// ad-groups.service.test.ts para a contraparte mockada). O diretório do
// fake já semeia um grupo "Financeiro" FORA de AD_GROUPS_OU (em
// "CN=Users", ver seedDirectory em server.mjs) de propósito, para provar
// que buscar/listar/add-remove-membro não dependem de onde o grupo foi
// criado.
describe('ad.service — grupos, protocolo LDAP real (fake-ldap-server)', () => {
  beforeEach(restartFakeLdap);

  it('searchGroups() sem query lista os grupos semeados (Rede-Permitida + Financeiro), ignorando usuários', async () => {
    const { searchGroups } = await importAdService();
    const groups = await searchGroups();
    expect(groups.map((g) => g.cn).sort()).toEqual(['Financeiro', 'Rede-Permitida']);
  });

  it('searchGroups(query) filtra por substring em cn/description contra o servidor real', async () => {
    const { searchGroups } = await importAdService();
    const byCn = await searchGroups('financ');
    expect(byCn.map((g) => g.cn)).toEqual(['Financeiro']);

    const byDescription = await searchGroups('equipe do financeiro');
    expect(byDescription.map((g) => g.cn)).toEqual(['Financeiro']);
  });

  it('getGroup() devolve o grupo semeado FORA de AD_GROUPS_OU (achado: busca é por AD_BASE_DN, não pela OU de criação)', async () => {
    const { getGroup } = await importAdService();
    const financeiro = await getGroup('Financeiro');
    expect(financeiro.description).toBe('Equipe do financeiro');
    expect(financeiro.dn.toLowerCase()).not.toContain(fakeLdap.groupsOu.toLowerCase());
    expect(financeiro.members.map((m) => m.toLowerCase())).toContain(`cn=jsilva,${fakeLdap.usersOu}`.toLowerCase());
  });

  it('getGroup() de quem não existe -> AdGroupNotFoundError (resultCode 32 real)', async () => {
    const { getGroup, AdGroupNotFoundError } = await importAdService();
    await expect(getGroup('NaoExiste')).rejects.toBeInstanceOf(AdGroupNotFoundError);
  });

  // MUTANTE QUE ISTO MATA (rodado de verdade, revertido depois): trocar
  // `escapeFilter\`...\`` por um template literal cru em `findGroupEntry`
  // (ad.service.ts). Confirmado com uma sonda isolada (client `ldapts`
  // real, sem passar por ad.service.ts) que o filtro resultante do `name`
  // hostil abaixo — "(&(objectClass=group)(cn=*)(cn=*))", um `(cn=*)`
  // INJETADO a mais fechando o filtro cedo — CASA de verdade com os 2
  // grupos semeados (`cn=*` é uma busca de presença, sempre verdadeira
  // pra um grupo) contra o parser de filtro REAL do fake-ldap-server. Sem
  // o escape, `findGroupEntry` devolveria o PRIMEIRO grupo que bater (não
  // o pretendido) em vez de lançar AdGroupNotFoundError — o mesmo tipo de
  // "cn errado resubmetido"/"objeto errado atingido" que este projeto já
  // tratou como grave outras vezes (extractAdminField, achado 8b). Um
  // mock de diretório em memória com matchesFilter por REGEX (ver
  // tests/unit/ad-groups.service.test.ts) NÃO detecta este mutante — só o
  // parser de filtro REAL prova a proteção.
  it('getGroup() escapa o `name` no filtro contra o parser de filtro REAL — um `name` hostil não vaza outro grupo nem finge presença', async () => {
    const { getGroup, AdGroupNotFoundError } = await importAdService();
    // Tenta fechar o filtro "(cn=" cedo e injetar "(cn=*)" (presença,
    // sempre verdadeira) — se escapeFilter estiver ativo, os caracteres
    // especiais (parênteses, asterisco) saem codificados (\28 \29 \2a) e o
    // servidor busca por um cn LITERAL igual a essa string toda, que não
    // existe.
    await expect(getGroup('*)(cn=*')).rejects.toBeInstanceOf(AdGroupNotFoundError);
  });

  // ACHADO DA VERIFICAÇÃO (mutante executado, revertido depois): o escape do
  // filtro de `findGroupEntry` tinha teste (o caso acima), mas o de
  // `searchGroups` NÃO — trocar `escapeFilter\`...\`` por um template literal
  // cru em searchGroups deixava a suíte de grupos inteira verde (63/63).
  // Diferente de `groupName` (barrado por charset na rota), `query` é texto
  // LIVRE vindo de `?query=`: uma sonda executada contra o parser de filtro
  // REAL do fake confirmou que, sem o escape, `searchGroups('x)(cn=*')`
  // devolve TODOS os grupos do diretório (o `(cn=*)` injetado é uma busca de
  // presença, sempre verdadeira) em vez de nenhum — injeção de filtro LDAP
  // de verdade, não hipótese. Com o escape ativo, o servidor busca por um cn
  // LITERAL com esses caracteres e não acha nada.
  it('searchGroups() escapa a `query` no filtro — payload de injeção não vira "presença" e não vaza a lista inteira', async () => {
    const { searchGroups } = await importAdService();
    const todos = await searchGroups();
    expect(todos.length).toBeGreaterThan(0); // há grupos a vazar, o teste não passa por vacuidade

    await expect(searchGroups('x)(cn=*')).resolves.toEqual([]);
  });

  it('createGroup() sem AD_GROUPS_OU -> AdGroupsOuNotConfiguredError, sem sequer conectar no fake', async () => {
    const service = await importAdService();
    delete process.env.AD_GROUPS_OU;
    vi.resetModules();
    const fresh = await import('../../src/services/ad.service.js');
    await expect(fresh.createGroup({ name: 'Nunca Vai Existir' })).rejects.toBeInstanceOf(fresh.AdGroupsOuNotConfiguredError);
    void service;
  });

  it('createGroup() cria via add() real, sob AD_GROUPS_OU, e a releitura reflete o objeto criado', async () => {
    const { createGroup, getGroup } = await importAdService();
    const created = await createGroup({ name: 'Suporte', description: 'Equipe de suporte' });
    expect(created.cn).toBe('Suporte');
    expect(created.dn.toLowerCase().endsWith(`,${fakeLdap.groupsOu.toLowerCase()}`)).toBe(true);

    const reread = await getGroup('Suporte');
    expect(reread.description).toBe('Equipe de suporte');
  });

  it('createGroup() com nome contendo vírgula: o DN sai escapado de verdade contra o servidor real (mesmo achado bloqueante da PR #25, agora em grupo)', async () => {
    // Comparar só se o DN final TERMINA em fakeLdap.groupsOu não distingue
    // escapado de não escapado (ambas as formas terminam no mesmo sufixo —
    // a vírgula nua continua ANTES da OU, nunca desloca o final da string).
    // A prova real é o DN CRU que chegou ao `add()` do servidor: com
    // `DN.addPairRDN` (RFC 4514), a vírgula sai como `\,` (escapada); sem o
    // escape, o servidor recebe uma vírgula NUA, que um AD real leria como
    // separador de RDN. Inspeciona o DN cru gravado no diretório do fake
    // (nunca normalizado — normalizeDn só mexe em espaço/caixa, preserva a
    // barra invertida).
    const { createGroup, getGroup } = await importAdService();
    const created = await createGroup({ name: 'a,b' });
    expect(created.cn).toBe('a,b');

    const rawEntry = Array.from(fakeLdap.directory.values()).find((e) => getAttrStringsForTest(e, 'cn').includes('a,b'));
    expect(rawEntry?.dn).toBe(`CN=a\\,b,${fakeLdap.groupsOu}`);

    const reread = await getGroup('a,b');
    expect(reread.cn).toBe('a,b');
  });

  it('addGroupMember()/removeGroupMember() alteram `member` de verdade no grupo real, e os dois são idempotentes (resultCode 20/16 reais)', async () => {
    const { addGroupMember, removeGroupMember, getGroup } = await importAdService();

    let financeiro = await getGroup('Financeiro');
    expect(financeiro.members.map((m) => m.toLowerCase())).toContain(`cn=jsilva,${fakeLdap.usersOu}`.toLowerCase());

    // ptravado ainda não é membro — adiciona de verdade.
    await addGroupMember('Financeiro', 'ptravado');
    financeiro = await getGroup('Financeiro');
    expect(financeiro.members.map((m) => m.toLowerCase())).toContain(`cn=ptravado,${fakeLdap.usersOu}`.toLowerCase());

    // Idempotente: o servidor real recusa um 2º `add` do MESMO valor
    // (resultCode 20, TypeOrValueExistsError) — addGroupMember precisa
    // engolir isso e não lançar.
    await expect(addGroupMember('Financeiro', 'ptravado')).resolves.toBeUndefined();

    await removeGroupMember('Financeiro', 'ptravado');
    financeiro = await getGroup('Financeiro');
    expect(financeiro.members.map((m) => m.toLowerCase())).not.toContain(`cn=ptravado,${fakeLdap.usersOu}`.toLowerCase());

    // Idempotente no sentido inverso: o servidor real recusa um `delete` de
    // valor que não existe mais (resultCode 16, NoSuchAttributeError).
    await expect(removeGroupMember('Financeiro', 'ptravado')).resolves.toBeUndefined();
  });

  it('addGroupMember() de usuário inexistente -> AdUserNotFoundError real, membership do grupo não muda', async () => {
    const { addGroupMember, getGroup, AdUserNotFoundError } = await importAdService();
    const before = await getGroup('Financeiro');
    await expect(addGroupMember('Financeiro', 'ninguem')).rejects.toBeInstanceOf(AdUserNotFoundError);
    const after = await getGroup('Financeiro');
    expect(after.members).toEqual(before.members);
  });

  it('addGroupMember()/removeGroupMember() de grupo inexistente -> AdGroupNotFoundError real', async () => {
    const { addGroupMember, removeGroupMember, AdGroupNotFoundError } = await importAdService();
    await expect(addGroupMember('NaoExiste', 'jsilva')).rejects.toBeInstanceOf(AdGroupNotFoundError);
    await expect(removeGroupMember('NaoExiste', 'jsilva')).rejects.toBeInstanceOf(AdGroupNotFoundError);
  });
});

// Pré-requisito bloqueante da subtarefa de grupos (resolvido na PR #33):
// prova que o bind-por-conexão também é exigido para as operações de grupo,
// não só para as de usuário já cobertas no describe correspondente mais
// abaixo neste arquivo.
describe('ad.service — grupos exigem bind prévio (mesma garantia RFC 4511 §4.2.1, exercitada pelo caminho de grupo)', () => {
  beforeEach(restartFakeLdap);

  it('search de grupo antes de bind -> OperationsError, não os grupos semeados', async () => {
    const client = new Client({ url: fakeLdap.url, tlsOptions: { ca: fakeLdap.caCert } });
    try {
      await expect(client.search(fakeLdap.baseDn, { scope: 'sub', filter: '(objectClass=group)' })).rejects.toBeInstanceOf(
        OperationsError,
      );
    } finally {
      await client.unbind().catch(() => undefined);
    }
  });

  it('modify de `member` de grupo antes de bind -> OperationsError, membership não muda', async () => {
    const client = new Client({ url: fakeLdap.url, tlsOptions: { ca: fakeLdap.caCert } });
    const change = new Change({
      operation: 'add',
      modification: new Attribute({ type: 'member', values: [`CN=ptravado,${fakeLdap.usersOu}`] }),
    });
    try {
      await expect(client.modify('CN=Financeiro,CN=Users,' + fakeLdap.baseDn, change)).rejects.toBeInstanceOf(OperationsError);
    } finally {
      await client.unbind().catch(() => undefined);
    }
  });
});

// --- Achados da verificação (Onda 3, subtarefa 6) ------------------------
//
// Estes dois blocos existem porque a revisão às cegas provou por MUTAÇÃO
// que as duas garantias abaixo estavam sem NENHUM teste: os dois mutantes
// SOBREVIVERAM com a suíte inteira verde (675/675).

// Ponto de design revisado: NÃO existe mais nenhuma variável que DESLIGUE a
// verificação de certificado desta conexão (o antigo `AD_TLS_REJECT_UNAUTHORIZED`
// foi removido por completo — ver docs/ad-module-plan.md e o histórico deste
// arquivo). O que existe é `AD_TLS_CA_FILE`, que só ESTENDE a lista de CAs
// confiadas. Os 3 testes abaixo prova que a verificação continua acontecendo
// de VERDADE nesse novo desenho: (1) sem nenhuma CA extra configurada, um
// certificado autoassinado desconhecido é recusado; (2) com uma CA extra que
// NÃO é a do servidor, ainda é recusado — prova que é o CONTEÚDO da CA que
// importa, não a mera presença do arquivo; (3) só com a CA certa o handshake
// passa (já provado implicitamente por todo o resto deste arquivo via
// `importAdService`, mas aqui de forma isolada e explícita).
describe('AD_TLS_CA_FILE — a verificação de certificado é real, não um interruptor', () => {
  // MUTANTE QUE ISTO MATA: `buildTlsOptions` (ad.service.ts) devolver
  // `undefined` mesmo com `AD_TLS_CA_FILE` configurado (ex.: alguém apaga a
  // linha `ca: readFileSync(...)` num refactor futuro). Sem este teste, a
  // suíte inteira continuaria verde com a CA do fake sendo IGNORADA — só que
  // aí TODOS os outros testes deste arquivo estariam de fato rodando com a
  // verificação de certificado efetivamente desligada por baixo (o client
  // aceitaria o certificado do fake por padrões de sistema seguirem
  // vigentes só por coincidência nenhuma, na verdade recusaria — mas o
  // ponto é que nenhum teste estaria PROVANDO que é a CA que faz a diferença).
  it('sem AD_TLS_CA_FILE, o client REAL recusa o certificado autoassinado do fake (verificação padrão do SO)', async () => {
    vi.resetModules();
    process.env.AD_URL = fakeLdap.url;
    process.env.AD_BASE_DN = fakeLdap.baseDn;
    process.env.AD_BIND_DN = fakeLdap.bindDn;
    process.env.AD_BIND_PASSWORD = fakeLdap.bindPassword;
    process.env.AD_USERS_OU = fakeLdap.usersOu;
    delete process.env.AD_TLS_CA_FILE;

    const { env } = await import('../../src/config/env.js');
    expect(env.AD_TLS_CA_FILE).toBeUndefined();

    // Não basta ler a config: prova o EFEITO no caminho de produção
    // (`withClient` é o mesmo para teste e para um AD real — não existe
    // client separado). Sem CA extra, o handshake contra o fake
    // (certificado autoassinado, desconhecido do sistema) precisa falhar.
    const service = await import('../../src/services/ad.service.js');
    await expect(service.searchUsers()).rejects.toThrow(/self-signed|self signed|certificate/i);
  });

  it('com AD_TLS_CA_FILE apontando para uma CA DIFERENTE da do servidor, o client REAL ainda recusa', async () => {
    // CA "decoy": um par autoassinado NOVO, sem nenhuma relação com o
    // fake-ldap-server desta suíte. Se este teste passasse com QUALQUER
    // arquivo de CA (em vez de recusar), provaria que `buildTlsOptions`
    // vira, na prática, um "confie em qualquer coisa" — o mesmo problema
    // que a variável antiga tinha, só que disfarçado atrás de um nome novo.
    const decoy = await selfsigned.generate([{ name: 'commonName', value: 'ca-errada.test' }], {
      keySize: 2048,
      algorithm: 'sha256',
    });
    const decoyFile = join(tmpDir, 'ca-decoy.pem');
    writeFileSync(decoyFile, decoy.cert, 'utf8');

    vi.resetModules();
    process.env.AD_URL = fakeLdap.url;
    process.env.AD_BASE_DN = fakeLdap.baseDn;
    process.env.AD_BIND_DN = fakeLdap.bindDn;
    process.env.AD_BIND_PASSWORD = fakeLdap.bindPassword;
    process.env.AD_USERS_OU = fakeLdap.usersOu;
    process.env.AD_TLS_CA_FILE = decoyFile;

    const service = await import('../../src/services/ad.service.js');
    await expect(service.searchUsers()).rejects.toThrow(/self-signed|self signed|certificate|unable to verify/i);
  });

  it('com AD_TLS_CA_FILE apontando para a CA certa, bind + search passam de verdade', async () => {
    // A mesma configuração que `importAdService()` usa em todo o resto do
    // arquivo — aqui isolada, para deixar explícito que o caminho feliz
    // depende da CA bater, não de alguma verificação ter sumido.
    const { searchUsers } = await importAdService();
    await expect(searchUsers()).resolves.not.toHaveLength(0);
  });

  // MUTANTE QUE ISTO MATA: trocar `z.string().min(1).optional()` por
  // `z.string().optional()` em src/config/env.ts (achado da reverificacao:
  // esse mutante SOBREVIVIA com a suite inteira verde). Sem o `min(1)`, um
  // `AD_TLS_CA_FILE=` vazio no `.env` vira `undefined` em SILENCIO: o boot
  // sobe normalmente e a conexao passa a NAO confiar na CA interna que o
  // operador achou que tinha configurado. Nao e um furo de seguranca (a
  // verificacao continua LIGADA contra as CAs do SO — falha fechada, nao
  // aberta), mas a falha aparece como um erro de certificado incompreensivel
  // em runtime em vez de um erro de configuracao no boot. Com `min(1)`, o
  // valor vazio e rejeitado alto e cedo.
  it('AD_TLS_CA_FILE vazio e um erro de configuracao no boot, nunca um "sem CA extra" silencioso', async () => {
    vi.resetModules();
    process.env.AD_TLS_CA_FILE = '';
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await expect(import('../../src/config/env.js')).rejects.toThrow('process.exit(1)');
      expect(errorSpy.mock.calls.flat().some((c) => JSON.stringify(c).includes('AD_TLS_CA_FILE'))).toBe(true);
    } finally {
      exitSpy.mockRestore();
      errorSpy.mockRestore();
      delete process.env.AD_TLS_CA_FILE;
      vi.resetModules();
    }
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
    await restartFakeLdap();
    // Mesma regra do resto do arquivo: a verificação de certificado
    // continua ligada, só estendida com a CA do fake — nunca
    // `rejectUnauthorized: false`.
    client = new Client({ url: fakeLdap.url, tlsOptions: { ca: fakeLdap.caCert } });
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

// Pré-requisito bloqueante da subtarefa de grupos (ver o topo da seção da
// Onda 3 no CLAUDE.md): estas provas usam o `Client` REAL do `ldapts`,
// conectado direto ao fake — sem `vi.mock`, sem passar por `ad.service.ts`
// (que sempre faz bind antes de operar, então nunca exercitaria o caminho
// "não autenticado" mesmo se a proteção não existisse). Cada `it` abre sua
// PRÓPRIA conexão TCP/TLS (nunca reaproveita um client de outro teste) —
// é exatamente o que prova que o estado de bind é por conexão, não global.
describe('fake-ldap-server — exige bind prévio por conexão (RFC 4511 §4.2.1)', () => {
  beforeEach(restartFakeLdap);

  function connect(): Client {
    return new Client({ url: fakeLdap.url, tlsOptions: { ca: fakeLdap.caCert } });
  }

  it('search antes de qualquer bind -> OperationsError (resultCode 1), não os 3 usuários semeados', async () => {
    // MUTANTE QUE ISTO MATA: remover a chamada a `requireBind` dentro do
    // `case OP.SearchRequest` de handleMessage (server.mjs) — sem ela, este
    // teste falharia porque o search devolveria os 3 usuários normalmente,
    // exatamente o comportamento "generoso demais" que esta subtarefa existe
    // para fechar.
    const client = connect();
    try {
      await expect(client.search(fakeLdap.usersOu, { scope: 'sub', filter: '(objectClass=user)' })).rejects.toBeInstanceOf(
        OperationsError,
      );
    } finally {
      await client.unbind().catch(() => undefined);
    }
  });

  it('add antes de qualquer bind -> OperationsError, entrada não é criada', async () => {
    const client = connect();
    const dn = `CN=intruso,${fakeLdap.usersOu}`;
    try {
      await expect(
        client.add(dn, { objectClass: ['top', 'person', 'organizationalPerson', 'user'], sAMAccountName: ['intruso'] }),
      ).rejects.toBeInstanceOf(OperationsError);
    } finally {
      await client.unbind().catch(() => undefined);
    }
    expect(fakeLdap.directory.has(dn.toLowerCase())).toBe(false);
  });

  it('modify antes de qualquer bind -> OperationsError, atributo não muda', async () => {
    const client = connect();
    const memberDn = `CN=jsilva,${fakeLdap.usersOu}`;
    const change = new Change({ operation: 'replace', modification: new Attribute({ type: 'department', values: ['Hackeado'] }) });
    try {
      await expect(client.modify(memberDn, change)).rejects.toBeInstanceOf(OperationsError);
    } finally {
      await client.unbind().catch(() => undefined);
    }
    const entry = Array.from(fakeLdap.directory.values()).find((e) => e.dn === memberDn);
    expect(entry?.attrs.get('department')?.map((b: Buffer) => b.toString('utf8'))).toEqual(['TI']);
  });

  it('delete antes de qualquer bind -> OperationsError, entrada continua existindo', async () => {
    const client = connect();
    const memberDn = `CN=jsilva,${fakeLdap.usersOu}`;
    try {
      await expect(client.del(memberDn)).rejects.toBeInstanceOf(OperationsError);
    } finally {
      await client.unbind().catch(() => undefined);
    }
    expect(fakeLdap.directory.has(memberDn.toLowerCase())).toBe(true);
  });

  it('bind com credencial errada não autentica a conexão -> search seguinte ainda recusa com OperationsError', async () => {
    // Prova a garantia 3 do pedido: uma tentativa de bind malsucedida não
    // pode deixar a conexão em estado autenticado. Se `connState.
    // authenticated` fosse setado incondicionalmente (ou nunca resetado em
    // caso de falha), o search abaixo passaria normalmente em vez de
    // recusar.
    const client = connect();
    try {
      await expect(client.bind(fakeLdap.bindDn, 'senha-errada')).rejects.toBeInstanceOf(InvalidCredentialsError);
      await expect(client.search(fakeLdap.usersOu, { scope: 'sub', filter: '(objectClass=user)' })).rejects.toBeInstanceOf(
        OperationsError,
      );
    } finally {
      await client.unbind().catch(() => undefined);
    }
  });

  it('rebind com credencial errada DERRUBA a autorização de uma conexão já autenticada', async () => {
    // Mutante que este teste mata (rodado de verdade nesta subtarefa, não só
    // hipótese): `connState.authenticated = ok` trocado por
    // `if (ok) connState.authenticated = true;` (nunca resetando para
    // `false` em falha). Numa conexão NOVA os dois comportamentos são
    // idênticos (o estado inicial já é `false`) — só um REBIND com
    // credencial errada, DEPOIS de um bind bem-sucedido na mesma conexão,
    // expõe a diferença: o mutante deixaria a conexão autenticada por
    // acidente, sobrevivendo a todos os outros testes deste arquivo.
    const client = connect();
    try {
      await client.bind(fakeLdap.bindDn, fakeLdap.bindPassword);
      const { searchEntries: before } = await client.search(fakeLdap.usersOu, { scope: 'sub', filter: '(objectClass=user)' });
      expect(before.length).not.toBe(0);

      await expect(client.bind(fakeLdap.bindDn, 'senha-errada-no-rebind')).rejects.toBeInstanceOf(InvalidCredentialsError);
      await expect(client.search(fakeLdap.usersOu, { scope: 'sub', filter: '(objectClass=user)' })).rejects.toBeInstanceOf(
        OperationsError,
      );
    } finally {
      await client.unbind().catch(() => undefined);
    }
  });

  it('bind bem-sucedido autoriza a MESMA conexão a buscar, e uma 2ª conexão nova não herda essa autorização', async () => {
    const authenticated = connect();
    const other = connect();
    try {
      await authenticated.bind(fakeLdap.bindDn, fakeLdap.bindPassword);
      const { searchEntries } = await authenticated.search(fakeLdap.usersOu, { scope: 'sub', filter: '(objectClass=user)' });
      expect(searchEntries.length).not.toBe(0);

      // Conexão NOVA, nunca fez bind -> continua exigindo, prova que o
      // estado é por conexão, não um flag global do servidor.
      await expect(other.search(fakeLdap.usersOu, { scope: 'sub', filter: '(objectClass=user)' })).rejects.toBeInstanceOf(
        OperationsError,
      );
    } finally {
      await authenticated.unbind().catch(() => undefined);
      await other.unbind().catch(() => undefined);
    }
  });

  it('unbind volta a conexão ao estado não autenticado: reconectar exige bind de novo', async () => {
    // Não dá para reenviar operações na MESMA conexão depois de um
    // UnbindRequest (RFC 4511 §4.3 — o servidor fecha a conexão, o próprio
    // ldapts encerra o socket junto). A prova observável de "unbind reseta
    // o estado" é: uma conexão NOVA depois de um unbind explícito continua
    // exigindo bind — nada de estado sobrevivendo por acidente num objeto
    // reaproveitado.
    const first = connect();
    await first.bind(fakeLdap.bindDn, fakeLdap.bindPassword);
    const { searchEntries } = await first.search(fakeLdap.usersOu, { scope: 'sub', filter: '(objectClass=user)' });
    expect(searchEntries.length).not.toBe(0);
    await first.unbind();

    const second = connect();
    try {
      await expect(second.search(fakeLdap.usersOu, { scope: 'sub', filter: '(objectClass=user)' })).rejects.toBeInstanceOf(
        OperationsError,
      );
    } finally {
      await second.unbind().catch(() => undefined);
    }
  });

  // Garantia 5 do pedido: bind ANÔNIMO (RFC 4511 §5.1.2 — DN vazio) e bind
  // NÃO AUTENTICADO (DN válido + senha vazia, §5.1.1) são caminhos que este
  // fake recusa DE PROPÓSITO, porque `ad.service.ts` sempre binda com as
  // duas credenciais configuradas. Sem estes dois testes a recusa era
  // PROTEÇÃO SEM TRAVA: o mutante
  // `const ok = normalizeDn(dn) === '' || <expressão original>` (aceitar
  // bind anônimo) SOBREVIVIA com a suíte inteira verde — executado de
  // verdade nesta verificação. Um fake que autentica sem credencial é a
  // forma mais silenciosa possível de reabrir o buraco que esta subtarefa
  // fecha: todo teste de grupos/computadores passaria sem nunca exercitar
  // o gate.
  it('bind ANÔNIMO (DN e senha vazios) é recusado e NÃO autentica a conexão', async () => {
    const client = connect();
    try {
      await expect(client.bind('', '')).rejects.toBeInstanceOf(InvalidCredentialsError);
      await expect(client.search(fakeLdap.usersOu, { scope: 'sub', filter: '(objectClass=user)' })).rejects.toBeInstanceOf(
        OperationsError,
      );
    } finally {
      await client.unbind().catch(() => undefined);
    }
  });

  it('bind com DN correto mas senha VAZIA é recusado e NÃO autentica a conexão', async () => {
    const client = connect();
    try {
      await expect(client.bind(fakeLdap.bindDn, '')).rejects.toBeInstanceOf(InvalidCredentialsError);
      await expect(client.search(fakeLdap.usersOu, { scope: 'sub', filter: '(objectClass=user)' })).rejects.toBeInstanceOf(
        OperationsError,
      );
    } finally {
      await client.unbind().catch(() => undefined);
    }
  });
});

// Confirma que o tipo exportado pelo serviço bate com o que o servidor real
// devolve (sanity check de tipos, não de comportamento).
void (null as unknown as AdUser);
