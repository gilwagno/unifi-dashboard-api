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

vi.mock('ldapts', () => {
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

  function escapeFilter(strings: TemplateStringsArray, ...values: unknown[]): string {
    return strings.reduce((acc, str, i) => acc + str + (i < values.length ? String(values[i]) : ''), '');
  }

  return { Client, Change, Attribute, NoSuchObjectError: FakeNoSuchObjectError, escapeFilter };
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
  it('cria em 3 passos: add (desabilitado+senha não exigida), modify unicodePwd, modify UAC final', async () => {
    const { createUser } = await importAdService();

    const user = await createUser({
      sAMAccountName: 'ppereira',
      displayName: 'Paulo Pereira',
      mail: 'paulo.pereira@test.local',
      password: 'S3nh4Inicial!',
    });

    const dn = `CN=Paulo Pereira,${AD_ENV.AD_USERS_OU}`;
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

    const dn = `CN=Paulo Pereira,${AD_ENV.AD_USERS_OU}`;
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

    const dn = `CN=Paulo Pereira,${AD_ENV.AD_USERS_OU}`;
    expect(directory.get(dn)!.attributes.pwdLastSet).toBeUndefined();
  });

  it('sem mail: userPrincipalName cai para o próprio sAMAccountName', async () => {
    const { createUser } = await importAdService();
    await createUser({ sAMAccountName: 'ppereira', displayName: 'Paulo Pereira', password: 'Senha123!' });

    const dn = `CN=Paulo Pereira,${AD_ENV.AD_USERS_OU}`;
    expect(directory.get(dn)!.attributes.userPrincipalName).toBe('ppereira');
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
