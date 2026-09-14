import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Testes do serviço de Active Directory — GRUPOS (Onda 3, subtarefa 3, ver
// docs/ad-module-plan.md). Mesmo espírito de tests/unit/ad.service.test.ts:
// o client `ldapts` é mockado (diretório em memória, mínimo necessário para
// exercitar bind/search/add/modify do jeito que ad.service.ts realmente
// chama) — nada de rede/AD real aqui. O caminho contra o PROTOCOLO real
// (fake-ldap-server) é tests/integration/ad-fake-ldap.test.ts.
//
// Mesma disciplina da revisão crítica da PR #25: `escapeFilter`, `DN` e as
// classes de erro (`TypeOrValueExistsError`/`AlreadyExistsError`/
// `NoSuchAttributeError`/`NoSuchObjectError`) vêm REAIS do pacote via
// `importOriginal` — nunca reimplementadas aqui. Um mock que reimplementa
// escape/erro é o mesmo tipo de "mock desarmando a proteção que deveria
// travar a regressão" já tratado como grave neste projeto.

interface FakeEntry {
  dn: string;
  attributes: Record<string, string | string[]>;
}

let directory: Map<string, FakeEntry>;
let bindCalls: Array<{ dn: string; password: string }>;
let searchFilters: string[];
let searchBases: string[];
// DN cru recebido por `client.add` — usado para provar o ESCAPE de verdade
// (ver o teste de `createGroup` com vírgula abaixo): comparar só o SUFIXO
// da string não distingue "escapado" de "não escapado" (as duas formas
// terminam na mesma OU de qualquer jeito, concatenação crua ou não) — só
// olhar o DN cru revela a barra invertida antes da vírgula.
let addDns: string[];

class FakeNoSuchObjectError extends Error {
  code = 32;
  constructor(message = 'No such object') {
    super(message);
    this.name = 'NoSuchObjectError';
  }
}

// Casa os filtros que ad.service.ts realmente produz para grupos:
//   1. exato por cn: "(&(objectClass=group)(cn=X))" (findGroupEntry)
//   2. substring OR: "(&(objectClass=group)(|(cn=*X*)(description=*X*)))"
//   3. sem query: "(objectClass=group)"
// mais os filtros de usuário já existentes (findUserEntry), reaproveitados
// tal qual de ad.service.test.ts, porque addGroupMember/removeGroupMember
// também resolvem o DN do MEMBRO via findUserEntry.
function matchesFilter(filter: string, entry: FakeEntry): boolean {
  if (entry.attributes.objectClass === 'group' || (Array.isArray(entry.attributes.objectClass) && entry.attributes.objectClass.includes('group'))) {
    const exactCn = /\(cn=([^)*][^)]*)\)/.exec(filter);
    if (exactCn && filter.includes('objectClass=group') && !filter.includes('(|')) {
      return entry.attributes.cn === exactCn[1];
    }
    if (filter.includes('(|')) {
      const needleMatch = /\*([^*]+)\*/.exec(filter);
      if (!needleMatch) return false;
      const needle = needleMatch[1].toLowerCase();
      const haystacks = [entry.attributes.cn, entry.attributes.description]
        .flat()
        .filter((v): v is string => typeof v === 'string')
        .map((v) => v.toLowerCase());
      return haystacks.some((h) => h.includes(needle));
    }
    if (filter === '(objectClass=group)') return true;
    return false;
  }

  // Usuário — mesmo formato de ad.service.test.ts (findUserEntry por
  // sAMAccountName exato).
  const exact = /\(sAMAccountName=([^)*][^)]*)\)/.exec(filter);
  if (exact) {
    const value = entry.attributes.sAMAccountName;
    return (Array.isArray(value) ? value[0] : value) === exact[1];
  }
  return false;
}

function applyChange(entry: FakeEntry, change: { operation: string; modification: { type: string; values?: unknown[] } }) {
  const { type, values } = change.modification;
  const stringValues = (values ?? []).map((v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v)));

  if (change.operation === 'add') {
    const current = entry.attributes[type];
    const arr = Array.isArray(current) ? [...current] : current ? [current] : [];
    entry.attributes[type] = [...arr, ...stringValues];
  } else if (change.operation === 'delete') {
    const current = entry.attributes[type];
    const arr = Array.isArray(current) ? current : current ? [current] : [];
    entry.attributes[type] = arr.filter((v) => !stringValues.includes(v));
  } else if (change.operation === 'replace') {
    entry.attributes[type] = stringValues.length === 1 ? stringValues[0] : stringValues;
  }
}

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
    constructor(_options: { url: string }) {
      void _options;
    }

    async bind(dn: string, password: string): Promise<void> {
      bindCalls.push({ dn, password });
    }

    async search(baseDN: string, options: { filter: string; scope?: string }) {
      searchBases.push(baseDN);
      searchFilters.push(options.filter);
      const entries = [...directory.values()].filter((entry) => matchesFilter(options.filter, entry));
      return {
        searchEntries: entries.map((entry) => ({ dn: entry.dn, ...entry.attributes })),
        searchReferences: [],
      };
    }

    async add(dn: string, attributes: Record<string, string | string[]>): Promise<void> {
      addDns.push(dn);
      if (directory.has(dn)) throw new actual.AlreadyExistsError('já existe');
      directory.set(dn, { dn, attributes: { ...attributes, distinguishedName: dn } });
    }

    async modify(dn: string, changes: InstanceType<typeof Change> | InstanceType<typeof Change>[]): Promise<void> {
      const entry = directory.get(dn);
      if (!entry) throw new FakeNoSuchObjectError();
      const list = Array.isArray(changes) ? changes : [changes];

      // Validação estilo RFC 4511 (mesma semântica do fake-ldap-server real)
      // — precisa REALMENTE recusar add-de-valor-existente/delete-de-valor-
      // ausente para que os `catch` de idempotência em ad.service.ts sejam
      // de fato exercitados (não só "o mock deixa passar tudo").
      for (const change of list) {
        const { type, values } = change.modification;
        const stringValues = (values ?? []).map((v) => (Buffer.isBuffer(v) ? v.toString('utf8') : String(v)));
        const current = entry.attributes[type];
        const currentArr = Array.isArray(current) ? current : current ? [current] : [];
        if (change.operation === 'add') {
          for (const v of stringValues) {
            if (currentArr.includes(v)) throw new actual.TypeOrValueExistsError('valor já existe');
          }
        } else if (change.operation === 'delete') {
          for (const v of stringValues) {
            if (!currentArr.includes(v)) throw new actual.NoSuchAttributeError('valor não existe');
          }
        }
      }

      for (const change of list) applyChange(entry, change);
    }

    async del(dn: string): Promise<void> {
      if (!directory.has(dn)) throw new FakeNoSuchObjectError();
      directory.delete(dn);
    }

    async unbind(): Promise<void> {
      // nada a fazer
    }
  }

  return {
    Client,
    Change,
    Attribute,
    NoSuchObjectError: FakeNoSuchObjectError,
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
  AD_GROUPS_OU: 'OU=Grupos,DC=test,DC=local',
};

function seedUser(sam: string, dn?: string): string {
  const entryDn = dn ?? `CN=${sam},${AD_ENV.AD_USERS_OU}`;
  directory.set(entryDn, {
    dn: entryDn,
    attributes: {
      distinguishedName: entryDn,
      sAMAccountName: sam,
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
    },
  });
  return entryDn;
}

function seedGroup(cn: string, opts: { dn?: string; members?: string[]; description?: string } = {}): string {
  const entryDn = opts.dn ?? `CN=${cn},${AD_ENV.AD_GROUPS_OU}`;
  directory.set(entryDn, {
    dn: entryDn,
    attributes: {
      distinguishedName: entryDn,
      cn,
      objectClass: ['top', 'group'],
      member: opts.members ?? [],
      ...(opts.description ? { description: opts.description } : {}),
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
  searchFilters = [];
  searchBases = [];
  addDns = [];
});

afterEach(() => {
  for (const key of Object.keys(AD_ENV)) delete process.env[key];
  vi.restoreAllMocks();
});

describe('ad.service — searchGroups/getGroup', () => {
  it('sem query lista todos os grupos, ignorando entradas de usuário', async () => {
    seedGroup('Financeiro', { members: ['CN=jsilva,OU=Funcionarios,DC=test,DC=local'] });
    seedGroup('Rede-Permitida', { dn: 'CN=Rede-Permitida,CN=Users,DC=test,DC=local' });
    seedUser('jsilva');

    const { searchGroups } = await importAdService();
    const groups = await searchGroups();

    expect(groups.map((g) => g.cn).sort()).toEqual(['Financeiro', 'Rede-Permitida']);
    const financeiro = groups.find((g) => g.cn === 'Financeiro')!;
    expect(financeiro.members).toEqual(['CN=jsilva,OU=Funcionarios,DC=test,DC=local']);
  });

  it('busca por AD_BASE_DN, não por AD_GROUPS_OU — um grupo fora da OU de criação ainda aparece', async () => {
    // Achado desta subtarefa: AD_GROUPS_OU só é usada para CRIAR — buscar/
    // listar não deveria depender de onde o grupo foi criado (grupos reais
    // de domínio frequentemente vivem em "CN=Users", fora de qualquer OU).
    seedGroup('ForaDaOu', { dn: 'CN=ForaDaOu,CN=Users,DC=test,DC=local' });
    const { searchGroups } = await importAdService();
    const groups = await searchGroups();
    expect(groups.map((g) => g.cn)).toContain('ForaDaOu');
    expect(searchBases).toContain(AD_ENV.AD_BASE_DN);
  });

  it('com query filtra por substring em cn OU description', async () => {
    seedGroup('Financeiro', { description: 'Equipe do financeiro' });
    seedGroup('TI');

    const { searchGroups } = await importAdService();
    const byCn = await searchGroups('financ');
    expect(byCn.map((g) => g.cn)).toEqual(['Financeiro']);
  });

  it('getGroup() de quem não existe -> AdGroupNotFoundError', async () => {
    const { getGroup, AdGroupNotFoundError } = await importAdService();
    await expect(getGroup('NaoExiste')).rejects.toBeInstanceOf(AdGroupNotFoundError);
  });

  // NÃO testamos injeção de filtro LDAP aqui: o "diretório falso" deste
  // arquivo casa filtros por REGEX própria (ver `matchesFilter` no topo),
  // não por um parser LDAP de verdade — um filtro malicioso like
  // "(&(objectClass=group)(cn=*)(cn=*))" (o resultado de um `name` hostil
  // não escapado) não bate no formato que a regex reconhece e o teste
  // "passaria" mesmo com o escape REMOVIDO do código de produção (mutante
  // que rodamos de verdade confirmou isso: sobreviveu aqui, morreu no
  // teste de protocolo real abaixo). A prova de verdade desta proteção
  // está em tests/integration/ad-fake-ldap.test.ts ("findGroupEntry()
  // escapa..."), contra o parser de filtro REAL do fake-ldap-server —
  // mesmo princípio de "mock demonstra construção, protocolo real
  // demonstra proteção" já estabelecido no resto do módulo.
});

describe('ad.service — createGroup', () => {
  it('sem AD_GROUPS_OU -> AdGroupsOuNotConfiguredError, sem sequer tentar conectar', async () => {
    const { createGroup, AdGroupsOuNotConfiguredError } = await importAdService({ ...AD_ENV, AD_GROUPS_OU: undefined });
    await expect(createGroup({ name: 'Novo' })).rejects.toBeInstanceOf(AdGroupsOuNotConfiguredError);
    expect(bindCalls).toHaveLength(0);
  });

  it('cria o grupo sob AD_GROUPS_OU e a releitura reflete o objeto criado', async () => {
    const { createGroup } = await importAdService();
    const created = await createGroup({ name: 'Suporte', description: 'Equipe de suporte' });
    expect(created.cn).toBe('Suporte');
    expect(created.description).toBe('Equipe de suporte');
    expect(created.dn.endsWith(`,${AD_ENV.AD_GROUPS_OU}`)).toBe(true);
  });

  it('escapa o DN — um `name` com vírgula produz um DN com a vírgula ESCAPADA (mesmo achado bloqueante da PR #25, agora em grupo)', async () => {
    // ACHADO GRAVE original (PR #25, usuários): DN por concatenação crua
    // permitia que um valor como "x,OU=Servidores" produzisse um DN válido
    // FORA do container pretendido — mas comparar só se o DN final TERMINA
    // com AD_GROUPS_OU não distingue escapado de não escapado (as duas
    // formas terminam no mesmo sufixo, concatenação crua ou não: a vírgula
    // não deslocada continua ANTES da OU). A prova real é o DN CRU
    // recebido pelo `add()`: `DN.addPairRDN` (RFC 4514) escapa vírgula como
    // `\,` — sem o escape, o `add()` recebe "CN=a,b,OU=..." (vírgula NUA,
    // que um AD real leria como separador de RDN); com o escape, recebe
    // "CN=a\,b,OU=..." (vírgula literal, um único RDN).
    const { createGroup, getGroup } = await importAdService();
    const created = await createGroup({ name: 'a,b' });
    expect(created.cn).toBe('a,b');
    expect(addDns).toEqual([`CN=a\\,b,${AD_ENV.AD_GROUPS_OU}`]);

    const reread = await getGroup('a,b');
    expect(reread.cn).toBe('a,b');
  });
});

describe('ad.service — addGroupMember/removeGroupMember', () => {
  it('addGroupMember() adiciona o DN do usuário ao `member` do grupo', async () => {
    seedUser('jsilva');
    seedGroup('Financeiro');
    const { addGroupMember, getGroup } = await importAdService();

    await addGroupMember('Financeiro', 'jsilva');
    const group = await getGroup('Financeiro');
    expect(group.members).toEqual(['CN=jsilva,OU=Funcionarios,DC=test,DC=local']);
  });

  it('addGroupMember() é IDEMPOTENTE: adicionar quem já é membro não lança (achado da PR #25, generalizado para grupo)', async () => {
    const memberDn = 'CN=jsilva,OU=Funcionarios,DC=test,DC=local';
    seedUser('jsilva');
    seedGroup('Financeiro', { members: [memberDn] });
    const { addGroupMember } = await importAdService();

    await expect(addGroupMember('Financeiro', 'jsilva')).resolves.toBeUndefined();
  });

  it('removeGroupMember() remove o DN do `member` do grupo', async () => {
    const memberDn = 'CN=jsilva,OU=Funcionarios,DC=test,DC=local';
    seedUser('jsilva');
    seedGroup('Financeiro', { members: [memberDn] });
    const { removeGroupMember, getGroup } = await importAdService();

    await removeGroupMember('Financeiro', 'jsilva');
    const group = await getGroup('Financeiro');
    expect(group.members).toEqual([]);
  });

  it('removeGroupMember() é IDEMPOTENTE: revogar de quem já não é membro não lança — nunca um 502 numa ação de segurança', async () => {
    seedUser('jsilva');
    seedGroup('Financeiro'); // sem membros
    const { removeGroupMember } = await importAdService();

    await expect(removeGroupMember('Financeiro', 'jsilva')).resolves.toBeUndefined();
  });

  it('addGroupMember() de usuário inexistente -> AdUserNotFoundError (falha ALTO E CLARO, não idempotência silenciosa)', async () => {
    seedGroup('Financeiro');
    const { addGroupMember, AdUserNotFoundError } = await importAdService();
    await expect(addGroupMember('Financeiro', 'ninguem')).rejects.toBeInstanceOf(AdUserNotFoundError);
  });

  it('addGroupMember() de grupo inexistente -> AdGroupNotFoundError', async () => {
    seedUser('jsilva');
    const { addGroupMember, AdGroupNotFoundError } = await importAdService();
    await expect(addGroupMember('NaoExiste', 'jsilva')).rejects.toBeInstanceOf(AdGroupNotFoundError);
  });

  it('removeGroupMember() de usuário inexistente -> AdUserNotFoundError', async () => {
    seedGroup('Financeiro');
    const { removeGroupMember, AdUserNotFoundError } = await importAdService();
    await expect(removeGroupMember('Financeiro', 'ninguem')).rejects.toBeInstanceOf(AdUserNotFoundError);
  });
});

// Regressão: a ponte 802.1X (PR #25) foi refatorada nesta subtarefa para
// reaproveitar `applyGroupMembership` — prova que grant/revoke continuam
// funcionando e idempotentes depois do refactor, sem duplicar toda a
// suíte já existente em ad.service.test.ts.
describe('ad.service — grantNetworkAccess/revokeNetworkAccess (regressão pós-refactor de applyGroupMembership)', () => {
  it('grant/revoke continuam idempotentes nos dois sentidos depois de extrair applyGroupMembership', async () => {
    seedUser('jsilva');
    seedGroup('Rede-Permitida', { dn: 'CN=Rede-Permitida,CN=Users,DC=test,DC=local' });
    const { grantNetworkAccess, revokeNetworkAccess } = await importAdService({
      ...AD_ENV,
      AD_NETWORK_ACCESS_GROUP_DN: 'CN=Rede-Permitida,CN=Users,DC=test,DC=local',
    });

    await grantNetworkAccess('jsilva');
    await expect(grantNetworkAccess('jsilva')).resolves.toBeUndefined();
    await revokeNetworkAccess('jsilva');
    await expect(revokeNetworkAccess('jsilva')).resolves.toBeUndefined();
  });
});
