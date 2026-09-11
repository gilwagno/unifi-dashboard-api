import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Testes do serviço de Active Directory (Onda 3, subtarefa 2 — ver
// docs/ad-module-plan.md). O client `ldapts` é INTEIRAMENTE mockado aqui —
// nada de rede/AD real na suíte automatizada. O "diretório falso" abaixo é
// só o suficiente para exercitar bind/search/add/modify/del do jeito que
// ad.service.ts realmente chama — não é um LDAP server completo (isso é o
// `fake-ldap-server` da subtarefa 7 do plano, para os testes de e2e).
//
// IMPORTANTE: nada aqui prova que um Active Directory REAL aceita essas
// operações — só que ad.service.ts as CONSTRÓI do jeito documentado
// publicamente pela Microsoft (atributos, filtros, codificação de senha
// UTF-16LE). Ver o comentário de topo de ad.service.ts.

interface FakeEntry {
  dn: string;
  attributes: Record<string, string | string[]>;
}

let directory: Map<string, FakeEntry>;
let bindCalls: Array<{ dn: string; password: string }>;
let unbindCount: number;
let bindShouldThrow: Error | null;
let delShouldThrowNoSuchObject: boolean;
// Captura o filtro LDAP EXATO recebido por `client.search` — usado pro
// teste de injeção (achado 1 da revisão crítica): sem isso, não dá pra
// provar que um `username` hostil foi realmente escapado antes de virar
// parte da string do filtro (o diretório falso "funcionar certo" não prova
// que o FILTRO em si ficou seguro).
let searchFilters: string[];
// Permite simular uma falha no `modify` de um DN específico — usado pros
// testes de estado AMBÍGUO (achado 3 da revisão crítica): a operação
// LDAP real falha DEPOIS de despachada, sem confirmar se aplicou.
let modifyShouldThrowForDn: string | null;
// Conta quantas requisições `modify` SEPARADAS o serviço despachou — é o que
// prova o achado 3 de verdade: senha e pwdLastSet (e senha e UAC, no
// createUser) precisam ir na MESMA requisição, porque só aí o LDAP garante
// que ou as duas aplicam ou nenhuma aplica. Um contador é a única forma de
// travar isso: o estado final do diretório fica idêntico com 1 ou com 2
// modifys.
let modifyCallCount: number;
// Faz `client.search` falhar DEPOIS que algum `modify` já rodou — usado pro
// achado da 2a revisao critica: no `createUser`, a releitura final acontece
// depois de a senha JA TER SIDO CONFIRMADA; uma falha ali descartava a unica
// copia da senha gerada.
let searchShouldThrowAfterModify: boolean;

class FakeNoSuchObjectError extends Error {
  code = 32;
  constructor(message = 'No such object') {
    super(message);
    this.name = 'NoSuchObjectError';
  }
}

// Casa o filtro LDAP com uma entrada do diretório falso. Só entende os 3
// formatos que ad.service.ts realmente produz (não é um parser de filtro
// LDAP genérico):
//   1. Busca exata por sAMAccountName (findUserEntry): "(sAMAccountName=X)",
//      sem '*' logo após o '=' — distingue do formato 2.
//   2. Busca por substring (searchUsers com query): "(cn=*X*)" dentro de
//      um "(|...)" — casa em cn/sAMAccountName/mail.
//   3. Sem nenhum dos dois acima (searchUsers sem query): casa tudo.
// A ordem do if/else importa: o formato 2 também contém
// "(sAMAccountName=*X*)" como um dos ramos do OR, que o regex do formato 1
// NÃO deve casar (por isso a exclusão de '*' logo após o '=').
function matchesFilter(filter: string, entry: FakeEntry): boolean {
  const exact = /\(sAMAccountName=([^)*][^)]*)\)/.exec(filter);
  if (exact) {
    const value = entry.attributes.sAMAccountName;
    return (Array.isArray(value) ? value[0] : value) === exact[1];
  }

  const substring = /\(cn=\*([^*]+)\*\)/.exec(filter);
  if (substring) {
    const needle = substring[1].toLowerCase();
    const haystacks = [entry.attributes.cn, entry.attributes.sAMAccountName, entry.attributes.mail]
      .flat()
      .filter((v): v is string => typeof v === 'string')
      .map((v) => v.toLowerCase());
    return haystacks.some((h) => h.includes(needle));
  }

  return true;
}

function applyChange(entry: FakeEntry, change: { operation: string; modification: { type: string; values?: unknown[] } }) {
  const { type, values } = change.modification;
  const stringValues = (values ?? []).map((v) => (Buffer.isBuffer(v) ? v.toString('utf16le').replace(/^"|"$/g, '') : String(v)));

  if (change.operation === 'replace') {
    entry.attributes[type] = stringValues.length === 1 ? stringValues[0] : stringValues;
  } else if (change.operation === 'delete') {
    if (stringValues.length === 0) {
      delete entry.attributes[type];
    } else {
      const current = entry.attributes[type];
      const arr = Array.isArray(current) ? current : current ? [current] : [];
      const next = arr.filter((v) => !stringValues.includes(v));
      entry.attributes[type] = next;
    }
  } else if (change.operation === 'add') {
    const current = entry.attributes[type];
    const arr = Array.isArray(current) ? [...current] : current ? [current] : [];
    entry.attributes[type] = [...arr, ...stringValues];
  }
}

// `importOriginal` traz `DN`, `escapeFilter`, `TypeOrValueExistsError`,
// `AlreadyExistsError` e `NoSuchAttributeError` REAIS do pacote (funções/
// classes puras, sem rede) — ACHADO GRAVE da revisão crítica: um
// `escapeFilter` reimplementado aqui (concatenação crua, sem escapar nada)
// deixava a suíde 100% verde mesmo com a proteção contra injeção de filtro
// LDAP REMOVIDA do código de produção — a mesma classe de "mock desarmando
// o teste que deveria travar a regressão" que este projeto já tratou como
// grave na subtarefa 15 da Onda 2. Só `Client`/`Change`/`Attribute`/
// `NoSuchObjectError` continuam fakes (esses SÃO o diretório em memória).
vi.mock('ldapts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ldapts')>();
  class Attribute {
    type: string;
    values: unknown[];
    constructor(options: { type?: string; values?: unknown[] } = {}) {
      this.type = options.type ?? '';
      this.values = options.values ?? [];
    }
  }

  class Change {
    operation: string;
    modification: Attribute;
    constructor(options: { operation?: string; modification: Attribute }) {
      this.operation = options.operation ?? 'replace';
      this.modification = options.modification;
    }
  }

  class Client {
    private url: string;
    constructor(options: { url: string }) {
      this.url = options.url;
    }

    async bind(dn: string, password: string): Promise<void> {
      bindCalls.push({ dn, password });
      if (bindShouldThrow) throw bindShouldThrow;
    }

    async search(baseDN: string, options: { filter: string; scope?: string }) {
      searchFilters.push(options.filter);
      if (searchShouldThrowAfterModify && modifyCallCount > 0) {
        throw new Error('conexão derrubada na releitura (simulado)');
      }
      const entries = [...directory.values()].filter((entry) => matchesFilter(options.filter, entry));
      return {
        searchEntries: entries.map((entry) => ({ dn: entry.dn, ...entry.attributes })),
        searchReferences: [],
      };
    }

    async add(dn: string, attributes: Record<string, string | string[]>): Promise<void> {
      if (directory.has(dn)) throw new Error(`Entry already exists: ${dn}`);
      directory.set(dn, { dn, attributes: { ...attributes } });
    }

    async modify(dn: string, changes: InstanceType<typeof Change> | InstanceType<typeof Change>[]): Promise<void> {
      modifyCallCount += 1;
      if (modifyShouldThrowForDn === dn) throw new Error('conexão derrubada no meio da escrita (simulado)');
      const entry = directory.get(dn);
      if (!entry) throw new FakeNoSuchObjectError();
      const list = Array.isArray(changes) ? changes : [changes];
      for (const change of list) applyChange(entry, change);
    }

    async del(dn: string): Promise<void> {
      if (delShouldThrowNoSuchObject || !directory.has(dn)) throw new FakeNoSuchObjectError();
      directory.delete(dn);
    }

    async unbind(): Promise<void> {
      unbindCount += 1;
    }
  }

  return {
    Client,
    Change,
    Attribute,
    NoSuchObjectError: FakeNoSuchObjectError,
    // Reais — ver o comentário acima do vi.mock.
    DN: actual.DN,
    escapeFilter: actual.escapeFilter,
    TypeOrValueExistsError: actual.TypeOrValueExistsError,
    AlreadyExistsError: actual.AlreadyExistsError,
    NoSuchAttributeError: actual.NoSuchAttributeError,
  };
});

const AD_ENV = {
  AD_URL: 'ldaps://dc.test.local:636',
  AD_BASE_DN: 'DC=test,DC=local',
  AD_BIND_DN: 'CN=svc-dashboard,CN=Users,DC=test,DC=local',
  AD_BIND_PASSWORD: 'super-secret-bind-password',
  AD_USERS_OU: 'OU=Funcionarios,DC=test,DC=local',
};

function seedUser(overrides: Partial<FakeEntry['attributes']> = {}, dn?: string): string {
  const sam = (overrides.sAMAccountName as string) ?? 'jsilva';
  const entryDn = dn ?? `CN=Joao Silva,${AD_ENV.AD_USERS_OU}`;
  directory.set(entryDn, {
    dn: entryDn,
    attributes: {
      distinguishedName: entryDn,
      sAMAccountName: sam,
      displayName: 'Joao Silva',
      cn: 'Joao Silva',
      mail: 'joao.silva@test.local',
      department: 'TI',
      title: 'Analista',
      userAccountControl: '512',
      lockoutTime: '0',
      userWorkstations: '',
      ...overrides,
    },
  });
  return entryDn;
}

async function importAdService(envOverrides: Partial<typeof AD_ENV> | Record<string, undefined> = AD_ENV) {
  vi.resetModules();
  for (const [key, value] of Object.entries(envOverrides)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import('../../src/services/ad.service.js');
}

beforeEach(() => {
  directory = new Map();
  bindCalls = [];
  unbindCount = 0;
  bindShouldThrow = null;
  delShouldThrowNoSuchObject = false;
  searchFilters = [];
  modifyShouldThrowForDn = null;
  modifyCallCount = 0;
  searchShouldThrowAfterModify = false;
});

afterEach(() => {
  for (const key of Object.keys(AD_ENV)) delete process.env[key];
  vi.restoreAllMocks();
});

describe('ad.service — não configurado', () => {
  it('lança AdNotConfiguredError quando as env vars AD_* não estão definidas', async () => {
    const { searchUsers, AdNotConfiguredError } = await importAdService({
      AD_URL: undefined,
      AD_BASE_DN: undefined,
      AD_BIND_DN: undefined,
      AD_BIND_PASSWORD: undefined,
      AD_USERS_OU: undefined,
    });

    await expect(searchUsers()).rejects.toThrow(AdNotConfiguredError);
    expect(bindCalls).toHaveLength(0);
  });

  it('AdNotConfiguredError também dispara quando só AD_BIND_PASSWORD falta (parcialmente configurado)', async () => {
    const { getUser, AdNotConfiguredError } = await importAdService({ ...AD_ENV, AD_BIND_PASSWORD: undefined });
    await expect(getUser('jsilva')).rejects.toThrow(AdNotConfiguredError);
  });
});

describe('ad.service — searchUsers/getUser', () => {
  it('busca sem query devolve todos os usuários da OU, campos mapeados corretamente', async () => {
    seedUser();
    seedUser({ sAMAccountName: 'mpereira', cn: 'Maria Pereira', displayName: 'Maria Pereira' }, 'CN=Maria Pereira,OU=Funcionarios,DC=test,DC=local');

    const { searchUsers } = await importAdService();
    const users = await searchUsers();

    expect(users).toHaveLength(2);
    const joao = users.find((u) => u.sAMAccountName === 'jsilva')!;
    expect(joao).toMatchObject({
      sAMAccountName: 'jsilva',
      displayName: 'Joao Silva',
      mail: 'joao.silva@test.local',
      department: 'TI',
      title: 'Analista',
      enabled: true,
      lockedOut: false,
      userWorkstations: [],
    });
  });

  it('busca COM query filtra por substring em cn (não devolve usuários que não combinam)', async () => {
    seedUser();
    seedUser({ sAMAccountName: 'mpereira', cn: 'Maria Pereira' }, 'CN=Maria Pereira,OU=Funcionarios,DC=test,DC=local');

    const { searchUsers } = await importAdService();
    const users = await searchUsers('Maria');

    expect(users).toHaveLength(1);
    expect(users[0].sAMAccountName).toBe('mpereira');
  });

  it('getUser devolve o usuário quando existe', async () => {
    seedUser();
    const { getUser } = await importAdService();
    const user = await getUser('jsilva');
    expect(user.sAMAccountName).toBe('jsilva');
  });

  it('getUser lança AdUserNotFoundError quando não existe', async () => {
    const { getUser, AdUserNotFoundError } = await importAdService();
    await expect(getUser('nao-existe')).rejects.toThrow(AdUserNotFoundError);
  });

  it('conta desabilitada (bit ACCOUNTDISABLE) mapeia enabled: false', async () => {
    seedUser({ userAccountControl: '514' }); // 512 (normal) + 2 (disabled)
    const { getUser } = await importAdService();
    const user = await getUser('jsilva');
    expect(user.enabled).toBe(false);
  });

  it('conta bloqueada (lockoutTime não-zero) mapeia lockedOut: true', async () => {
    seedUser({ lockoutTime: '133434567890123456' });
    const { getUser } = await importAdService();
    const user = await getUser('jsilva');
    expect(user.lockedOut).toBe(true);
  });

  it('userWorkstations com valor devolve a lista separada por vírgula, aparada', async () => {
    seedUser({ userWorkstations: 'PC-FINANCEIRO, PC-COMPRAS' });
    const { getUser } = await importAdService();
    const user = await getUser('jsilva');
    expect(user.userWorkstations).toEqual(['PC-FINANCEIRO', 'PC-COMPRAS']);
  });
});

describe('ad.service — createUser', () => {
  // Reduzido de 3 pra 2 operações LDAP pela revisão crítica (achado grave:
  // senha+UAC combinados num único `modify` atômico, fechando a janela
  // ambígua entre "senha definida" e "conta habilitada").
  it('cria em 2 passos: add (desabilitado+senha não exigida), modify atômico (unicodePwd+UAC+pwdLastSet)', async () => {
    const { createUser } = await importAdService();

    const user = await createUser({
      sAMAccountName: 'ppereira',
      displayName: 'Paulo Pereira',
      mail: 'paulo.pereira@test.local',
      password: 'S3nh4Inicial!',
    });

    const dn = `CN=ppereira,${AD_ENV.AD_USERS_OU}`;
    const entry = directory.get(dn)!;
    expect(entry).toBeDefined();
    // UAC final: normal (512), habilitado.
    expect(entry.attributes.userAccountControl).toBe('512');
    // pwdLastSet=0 por padrão (mustChangePasswordAtNextLogon default true).
    expect(entry.attributes.pwdLastSet).toBe('0');
    expect(user.sAMAccountName).toBe('ppereira');
    expect(user.enabled).toBe(true);
  });

  it('codifica a senha em UTF-16LE entre aspas duplas (padrão unicodePwd do AD)', async () => {
    const { createUser } = await importAdService();
    await createUser({ sAMAccountName: 'ppereira', displayName: 'Paulo Pereira', password: 'Senha123!' });

    const dn = `CN=ppereira,${AD_ENV.AD_USERS_OU}`;
    // O fake decodifica o Buffer recebido de volta para string (ver
    // applyChange) — se a codificação estivesse errada (sem aspas, ou
    // utf8 em vez de utf16le), este valor não bateria com a senha original.
    expect(directory.get(dn)!.attributes.unicodePwd).toBe('Senha123!');
  });

  it('mustChangePasswordAtNextLogon: false não seta pwdLastSet', async () => {
    const { createUser } = await importAdService();
    await createUser({
      sAMAccountName: 'ppereira',
      displayName: 'Paulo Pereira',
      password: 'Senha123!',
      mustChangePasswordAtNextLogon: false,
    });

    const dn = `CN=ppereira,${AD_ENV.AD_USERS_OU}`;
    expect(directory.get(dn)!.attributes.pwdLastSet).toBeUndefined();
  });

  // Achado 10 da revisão crítica: sem `mail`, o UPN caía pro sAMAccountName
  // PELADO, sem sufixo de domínio — não é um UPN de logon válido. Agora
  // deriva o sufixo do próprio AD_BASE_DN configurado ("DC=test,DC=local"
  // -> "test.local").
  it('sem mail: userPrincipalName usa sAMAccountName + domínio derivado de AD_BASE_DN', async () => {
    const { createUser } = await importAdService();
    await createUser({ sAMAccountName: 'ppereira', displayName: 'Paulo Pereira', password: 'Senha123!' });

    const dn = `CN=ppereira,${AD_ENV.AD_USERS_OU}`;
    expect(directory.get(dn)!.attributes.userPrincipalName).toBe('ppereira@test.local');
  });

  it('DN é derivado do sAMAccountName, não do displayName — nome com vírgula não quebra nem escreve fora da OU', async () => {
    const { createUser } = await importAdService();
    // "Silva, João" quebraria um DN montado por concatenação crua da forma
    // antiga (a vírgula é separador de RDN em LDAP) — achado grave da
    // revisão crítica.
    const user = await createUser({
      sAMAccountName: 'jsilva2',
      displayName: 'Silva, João',
      password: 'Senha123!',
    });

    const dn = `CN=jsilva2,${AD_ENV.AD_USERS_OU}`;
    expect(directory.get(dn)).toBeDefined();
    expect(directory.get(dn)!.attributes.displayName).toBe('Silva, João');
    expect(user.dn).toBe(dn);
  });
});

describe('ad.service — updateUser', () => {
  it('atualiza só os campos informados, sem tocar nos demais', async () => {
    seedUser();
    const { updateUser } = await importAdService();

    const updated = await updateUser('jsilva', { department: 'Financeiro' });

    expect(updated.department).toBe('Financeiro');
    expect(updated.title).toBe('Analista'); // inalterado
    expect(updated.mail).toBe('joao.silva@test.local'); // inalterado
  });

  it('lança AdUserNotFoundError ao tentar atualizar usuário inexistente', async () => {
    const { updateUser, AdUserNotFoundError } = await importAdService();
    await expect(updateUser('nao-existe', { title: 'Gerente' })).rejects.toThrow(AdUserNotFoundError);
  });
});

describe('ad.service — deleteUser', () => {
  it('remove o usuário do diretório', async () => {
    const dn = seedUser();
    const { deleteUser } = await importAdService();
    await deleteUser('jsilva');
    expect(directory.has(dn)).toBe(false);
  });

  it('lança AdUserNotFoundError quando o usuário não existe (nunca chega a chamar del)', async () => {
    const { deleteUser, AdUserNotFoundError } = await importAdService();
    await expect(deleteUser('nao-existe')).rejects.toThrow(AdUserNotFoundError);
  });

  it('remove o usuário JÁ resolvido mas apagado por outra ação entre o search e o del (corrida): mapeia pra AdUserNotFoundError, não deixa o NoSuchObjectError cru vazar', async () => {
    seedUser();
    delShouldThrowNoSuchObject = true;
    const { deleteUser, AdUserNotFoundError } = await importAdService();
    await expect(deleteUser('jsilva')).rejects.toThrow(AdUserNotFoundError);
  });
});

describe('ad.service — setUserEnabled', () => {
  it('desabilita preservando os demais bits do userAccountControl', async () => {
    // 512 (normal) + 65536 (DONT_EXPIRE_PASSWORD) — bit que setUserEnabled
    // NÃO pode apagar ao desabilitar.
    seedUser({ userAccountControl: String(512 + 65536) });
    const { setUserEnabled } = await importAdService();

    await setUserEnabled('jsilva', false);

    const dn = `CN=Joao Silva,${AD_ENV.AD_USERS_OU}`;
    const uac = Number(directory.get(dn)!.attributes.userAccountControl);
    expect((uac & 0x0002) !== 0).toBe(true); // ACCOUNTDISABLE ligado
    expect((uac & 0x10000) !== 0).toBe(true); // DONT_EXPIRE_PASSWORD preservado
  });

  it('habilita limpando só o bit ACCOUNTDISABLE', async () => {
    seedUser({ userAccountControl: String(512 + 2 + 65536) }); // desabilitado + dont-expire
    const { setUserEnabled } = await importAdService();

    await setUserEnabled('jsilva', true);

    const dn = `CN=Joao Silva,${AD_ENV.AD_USERS_OU}`;
    const uac = Number(directory.get(dn)!.attributes.userAccountControl);
    expect((uac & 0x0002) !== 0).toBe(false); // ACCOUNTDISABLE removido
    expect((uac & 0x10000) !== 0).toBe(true); // DONT_EXPIRE_PASSWORD preservado
  });
});

describe('ad.service — unlockUser', () => {
  it('zera lockoutTime', async () => {
    seedUser({ lockoutTime: '133434567890123456' });
    const { unlockUser } = await importAdService();

    await unlockUser('jsilva');

    const dn = `CN=Joao Silva,${AD_ENV.AD_USERS_OU}`;
    expect(directory.get(dn)!.attributes.lockoutTime).toBe('0');
  });
});

describe('ad.service — resetPassword', () => {
  it('troca a senha (unicodePwd) e força troca no próximo logon por padrão', async () => {
    seedUser();
    const { resetPassword } = await importAdService();

    await resetPassword('jsilva', 'NovaSenha123!');

    const dn = `CN=Joao Silva,${AD_ENV.AD_USERS_OU}`;
    expect(directory.get(dn)!.attributes.unicodePwd).toBe('NovaSenha123!');
    expect(directory.get(dn)!.attributes.pwdLastSet).toBe('0');
  });

  it('mustChangePasswordAtNextLogon=false não seta pwdLastSet', async () => {
    seedUser();
    const { resetPassword } = await importAdService();

    await resetPassword('jsilva', 'NovaSenha123!', false);

    const dn = `CN=Joao Silva,${AD_ENV.AD_USERS_OU}`;
    expect(directory.get(dn)!.attributes.pwdLastSet).toBeUndefined();
  });
});

describe('ad.service — setUserWorkstations', () => {
  it('grava a lista como string separada por vírgula', async () => {
    seedUser();
    const { setUserWorkstations } = await importAdService();

    await setUserWorkstations('jsilva', ['PC-FINANCEIRO', 'PC-COMPRAS']);

    const dn = `CN=Joao Silva,${AD_ENV.AD_USERS_OU}`;
    expect(directory.get(dn)!.attributes.userWorkstations).toBe('PC-FINANCEIRO,PC-COMPRAS');
  });

  it('lista vazia REMOVE a restrição (apaga o atributo, não grava string vazia)', async () => {
    seedUser({ userWorkstations: 'PC-FINANCEIRO' });
    const { setUserWorkstations } = await importAdService();

    await setUserWorkstations('jsilva', []);

    const dn = `CN=Joao Silva,${AD_ENV.AD_USERS_OU}`;
    expect(directory.get(dn)!.attributes.userWorkstations).toBeUndefined();
  });
});

describe('ad.service — ponte 802.1X', () => {
  it('grantNetworkAccess lança AdNetworkAccessGroupNotConfiguredError sem AD_NETWORK_ACCESS_GROUP_DN', async () => {
    seedUser();
    const { grantNetworkAccess, AdNetworkAccessGroupNotConfiguredError } = await importAdService();
    await expect(grantNetworkAccess('jsilva')).rejects.toThrow(AdNetworkAccessGroupNotConfiguredError);
  });

  it('grantNetworkAccess adiciona o DN do usuário como member do grupo configurado', async () => {
    seedUser();
    const groupDn = 'CN=Rede-Permitida,CN=Users,DC=test,DC=local';
    directory.set(groupDn, { dn: groupDn, attributes: { cn: 'Rede-Permitida', member: [] } });

    const { grantNetworkAccess } = await importAdService({ ...AD_ENV, AD_NETWORK_ACCESS_GROUP_DN: groupDn });
    await grantNetworkAccess('jsilva');

    const userDn = `CN=Joao Silva,${AD_ENV.AD_USERS_OU}`;
    expect(directory.get(groupDn)!.attributes.member).toEqual([userDn]);
  });

  it('revokeNetworkAccess remove o DN do usuário do grupo', async () => {
    seedUser();
    const groupDn = 'CN=Rede-Permitida,CN=Users,DC=test,DC=local';
    const userDn = `CN=Joao Silva,${AD_ENV.AD_USERS_OU}`;
    directory.set(groupDn, { dn: groupDn, attributes: { cn: 'Rede-Permitida', member: [userDn, 'CN=Outro,DC=test,DC=local'] } });

    const { revokeNetworkAccess } = await importAdService({ ...AD_ENV, AD_NETWORK_ACCESS_GROUP_DN: groupDn });
    await revokeNetworkAccess('jsilva');

    expect(directory.get(groupDn)!.attributes.member).toEqual(['CN=Outro,DC=test,DC=local']);
  });
});

describe('ad.service — erros de conexão/protocolo', () => {
  it('falha de bind vira AdRequestError (nunca um erro cru da lib)', async () => {
    bindShouldThrow = new Error('connect ECONNREFUSED');
    const { searchUsers, AdRequestError } = await importAdService();
    await expect(searchUsers()).rejects.toThrow(AdRequestError);
  });

  it('AdRequestError preserva a causa original (cause) para diagnóstico', async () => {
    const original = new Error('connect ECONNREFUSED');
    bindShouldThrow = original;
    const { searchUsers, AdRequestError } = await importAdService();

    try {
      await searchUsers();
      expect.unreachable('deveria ter lançado');
    } catch (err) {
      expect(err).toBeInstanceOf(AdRequestError);
      expect((err as InstanceType<typeof AdRequestError>).cause).toBe(original);
    }
  });

  it('sempre chama unbind mesmo quando a operação falha', async () => {
    seedUser();
    const { getUser, AdUserNotFoundError } = await importAdService();
    await expect(getUser('nao-existe')).rejects.toThrow(AdUserNotFoundError);
    expect(unbindCount).toBe(1);
  });

  it('chama unbind depois de uma operação bem-sucedida', async () => {
    seedUser();
    const { getUser } = await importAdService();
    await getUser('jsilva');
    expect(unbindCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ACHADO 1 da revisão crítica — injeção de filtro LDAP
// ---------------------------------------------------------------------------
// Estes testes só têm valor porque o `vi.mock` acima passou a usar o
// `escapeFilter` REAL do `ldapts` (via importOriginal). Com o escape falso
// que existia antes (concatenação crua), eles falhariam — era exatamente a
// rede de segurança ausente que o crítico apontou: remover o `escapeFilter`
// do código de produção deixava a suíte inteira verde.
describe('ad.service — escape de filtro LDAP (injeção)', () => {
  it('username hostil não injeta operador no filtro de getUser', async () => {
    seedUser();
    const { getUser, AdUserNotFoundError } = await importAdService();

    // Sem escape, `*)(objectClass=*` fecharia o `(sAMAccountName=...)` e
    // abriria um novo termo — o filtro casaria QUALQUER objeto do diretório,
    // devolvendo um usuário que o chamador não tinha direito de ver.
    await expect(getUser('*)(objectClass=*')).rejects.toThrow(AdUserNotFoundError);

    const [filter] = searchFilters;
    // Os metacaracteres chegaram ao filtro ESCAPADOS (\2a = '*', \28 = '(',
    // \29 = ')'), não como sintaxe LDAP ativa.
    expect(filter).toContain('\\2a');
    expect(filter).toContain('\\28');
    expect(filter).toContain('\\29');
    // E o filtro continua com exatamente os 3 termos que o serviço monta —
    // nenhum termo extra entrou pelo valor do usuário.
    expect(filter).toBe(
      '(&(objectClass=user)(objectCategory=person)(sAMAccountName=\\2a\\29\\28objectClass=\\2a))',
    );
  });

  it('query hostil não injeta operador no filtro de searchUsers', async () => {
    seedUser();
    const { searchUsers } = await importAdService();

    const users = await searchUsers(')(|(objectClass=*');
    // Nada casou: o valor virou texto literal de busca, não sintaxe.
    expect(users).toEqual([]);
    expect(searchFilters[0]).toContain('\\29\\28');
    expect(searchFilters[0]).not.toContain(')(|(objectClass=*');
  });

  it('backslash no valor também é escapado (não vira escape de outro caractere)', async () => {
    seedUser();
    const { getUser, AdUserNotFoundError } = await importAdService();

    await expect(getUser('a\\2a')).rejects.toThrow(AdUserNotFoundError);
    // A barra literal vira \5c; o "2a" que o usuário digitou continua texto,
    // não é reinterpretado como o metacaractere '*'.
    expect(searchFilters[0]).toContain('a\\5c2a');
  });
});

// ---------------------------------------------------------------------------
// ACHADO 3 da revisão crítica — senha perdida em estado AMBÍGUO
// ---------------------------------------------------------------------------
describe('ad.service — senha em estado ambíguo', () => {
  it('createUser: falha do modify preserva a senha tentada em AdPasswordAmbiguousError', async () => {
    const { createUser, AdPasswordAmbiguousError, AdRequestError } = await importAdService();
    const dn = `CN=ppereira,${AD_ENV.AD_USERS_OU}`;
    modifyShouldThrowForDn = dn;

    try {
      await createUser({ sAMAccountName: 'ppereira', displayName: 'Paulo Pereira', password: 'S3nh4Gerada!' });
      expect.unreachable('deveria ter lançado');
    } catch (err) {
      // NÃO pode virar o AdRequestError genérico — esse caminho descartaria
      // a senha, que pode ser a única cópia existente (gerada na rota).
      expect(err).not.toBeInstanceOf(AdRequestError);
      expect(err).toBeInstanceOf(AdPasswordAmbiguousError);
      expect((err as InstanceType<typeof AdPasswordAmbiguousError>).attemptedPassword).toBe('S3nh4Gerada!');
    }

    // A conta existe, mas ficou DESABILITADA e sem senha exigida — nunca
    // habilitada sem senha definida.
    const entry = directory.get(dn)!;
    expect(entry).toBeDefined();
    expect(Number(entry.attributes.userAccountControl) & 0x0002).not.toBe(0); // ACCOUNTDISABLE
  });

  it('resetPassword: falha do modify preserva a senha tentada', async () => {
    const dn = seedUser();
    modifyShouldThrowForDn = dn;
    const { resetPassword, AdPasswordAmbiguousError, AdRequestError } = await importAdService();

    try {
      await resetPassword('jsilva', 'N0vaSenh4!', true);
      expect.unreachable('deveria ter lançado');
    } catch (err) {
      expect(err).not.toBeInstanceOf(AdRequestError);
      expect(err).toBeInstanceOf(AdPasswordAmbiguousError);
      expect((err as InstanceType<typeof AdPasswordAmbiguousError>).attemptedPassword).toBe('N0vaSenh4!');
    }
  });

  it('resetPassword aplica senha e pwdLastSet num ÚNICO modify (atômico)', async () => {
    const dn = seedUser();
    const { resetPassword } = await importAdService();
    await resetPassword('jsilva', 'N0vaSenh4!', true);

    const entry = directory.get(dn)!;
    expect(entry.attributes.pwdLastSet).toBe('0');
    expect(entry.attributes.unicodePwd).toBe('N0vaSenh4!');
    // O CONTADOR é o que prova o achado: com dois modifys separados (a
    // versão anterior), uma falha entre eles deixava a senha JÁ TROCADA no
    // AD sem o pwdLastSet — e o estado final do diretório no caminho feliz
    // seria idêntico, então só a contagem trava a regressão.
    expect(modifyCallCount).toBe(1);
  });

  it('createUser aplica senha, UAC e pwdLastSet num ÚNICO modify (atômico)', async () => {
    const { createUser } = await importAdService();
    await createUser({ sAMAccountName: 'ppereira', displayName: 'Paulo Pereira', password: 'S3nh4Inicial!' });

    // 1 `add` + 1 `modify`. Eram 2 modifys antes da revisão crítica, com uma
    // janela real entre "senha definida" e "conta habilitada".
    expect(modifyCallCount).toBe(1);
  });

  it('AdPasswordAmbiguousError atravessa withClient sem virar AdRequestError', async () => {
    const dn = seedUser();
    modifyShouldThrowForDn = dn;
    const { resetPassword, AdPasswordAmbiguousError } = await importAdService();

    await expect(resetPassword('jsilva', 'N0vaSenh4!', false)).rejects.toBeInstanceOf(AdPasswordAmbiguousError);
    // E o unbind continua acontecendo (o finally do withClient não é pulado).
    expect(unbindCount).toBe(1);
  });
});

describe('ad.service — DN do usuário novo (escape de RDN)', () => {
  it('sAMAccountName com vírgula/igual NÃO escapa da OU configurada (achado 2 da revisão crítica)', async () => {
    const { createUser } = await importAdService();
    // Valor hostil: com concatenação crua (`CN=${sam},${OU}`), isto produz um
    // DN VÁLIDO apontando pra OU=Servidores — o objeto seria criado FORA da
    // OU pretendida. Com o RDN escapado, a vírgula e o '=' viram parte do CN.
    await createUser({
      sAMAccountName: 'x,OU=Servidores',
      displayName: 'Hostil',
      password: 'S3nh4Inicial!',
    });

    const dns = [...directory.keys()];
    expect(dns).toHaveLength(1);
    const [dn] = dns;
    // O DN precisa terminar EXATAMENTE na OU configurada, com um único RDN
    // antes dela — nada de "OU=Servidores" no meio do caminho.
    expect(dn.endsWith(`,${AD_ENV.AD_USERS_OU}`)).toBe(true);
    const rdn = dn.slice(0, dn.length - AD_ENV.AD_USERS_OU.length - 1);
    expect(rdn).toBe('CN=x\\,OU\\=Servidores');
    expect(rdn).not.toContain('OU=Servidores');
  });
});

describe('ad.service — releitura pós-escrita (achado da 2ª revisão crítica)', () => {
  it('createUser preserva a senha quando a RELEITURA falha depois do modify confirmado', async () => {
    searchShouldThrowAfterModify = true;
    const { createUser, AdPasswordAmbiguousError } = await importAdService();

    // A senha JÁ FOI aplicada (o modify confirmou) — sem este tratamento, a
    // falha da busca virava AdRequestError/404 genérico e a única cópia da
    // senha gerada se perdia, exatamente o achado bloqueante nº 3 sobrevivendo
    // neste caminho.
    const err = await createUser({
      sAMAccountName: 'ppereira',
      displayName: 'Paulo Pereira',
      password: 'S3nh4Inicial!',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AdPasswordAmbiguousError);
    expect((err as { attemptedPassword: string }).attemptedPassword).toBe('S3nh4Inicial!');
    // Aqui dá pra AFIRMAR o estado: o modify aplicou, a conta está habilitada.
    expect((err as { accountEnabled: boolean | null }).accountEnabled).toBe(true);
  });

  it('falha do PRÓPRIO modify deixa accountEnabled desconhecido (nunca afirma false)', async () => {
    const { createUser, AdPasswordAmbiguousError } = await importAdService();
    // O add cria a entrada; o modify seguinte falha — pode ou não ter aplicado.
    const { DN } = await import('ldapts');
    modifyShouldThrowForDn = `${new DN().addPairRDN('CN', 'ppereira').toString()},${AD_ENV.AD_USERS_OU}`;

    const err = await createUser({
      sAMAccountName: 'ppereira',
      displayName: 'Paulo Pereira',
      password: 'S3nh4Inicial!',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(AdPasswordAmbiguousError);
    expect((err as { accountEnabled: boolean | null }).accountEnabled).toBeNull();
  });
});

describe('ad.service — AdPasswordAmbiguousError não vaza a senha em serialização', () => {
  it('attemptedPassword é acessível mas NÃO enumerável (pino/JSON nunca gravam a senha)', async () => {
    const { AdPasswordAmbiguousError } = await importAdService();
    const err = new AdPasswordAmbiguousError('jsilva', 'S3nh4-SUPER-SECRETA');

    // A rota precisa do valor...
    expect(err.attemptedPassword).toBe('S3nh4-SUPER-SECRETA');
    // ...mas nenhum serializador automático pode alcançá-lo. Confirmado
    // empiricamente que o serializador de erro do pino inclui as props
    // próprias ENUMERÁVEIS — com o campo enumerável, `app.log.error(error)`
    // (catch-all de src/app.ts) gravaria a senha em claro no log.
    expect(Object.keys(err)).not.toContain('attemptedPassword');
    expect(Object.propertyIsEnumerable.call(err, 'attemptedPassword')).toBe(false);
    expect(JSON.stringify({ ...err })).not.toContain('S3nh4-SUPER-SECRETA');
  });
});
