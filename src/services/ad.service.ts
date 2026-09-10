import { Attribute, Change, Client, NoSuchObjectError, escapeFilter } from 'ldapts';
import { env } from '../config/env.js';

// Client LDAPS para o Active Directory (Onda 3, ver docs/ad-module-plan.md)
// — mesmo espírito de unifi-classic.service.ts: uma função central
// (`withClient`) que abre/fecha a conexão e faz bind/unbind, erros
// tipados, feature inteira desligada de forma clara quando as env vars
// opcionais não estão configuradas.
//
// ATENÇÃO: nada neste arquivo foi testado contra um Active Directory real
// ainda (ver docs/ad-module-plan.md, topo do documento) — os testes deste
// módulo mockam o client `ldapts` e provam que as operações LDAP são
// construídas do jeito documentado pela Microsoft (atributos, filtros,
// codificação de senha), não que um AD real aceita exatamente isso. Trate
// como especificação até ser validado contra um DC real, do mesmo jeito
// que a pesquisa de impressoras (docs/printers-snmp-research.md) começou
// como hipótese e foi corrigida contra o equipamento real várias vezes.
//
// Diferente da API clássica do UniFi (sessão de cookie reaproveitada entre
// chamadas), cada operação aqui abre uma conexão/bind PRÓPRIA e fecha no
// final (`finally`): conexões LDAP idle são frequentemente derrubadas pelo
// servidor depois de um tempo, e o volume de chamadas deste módulo (ações
// administrativas pontuais, não um poller de alta frequência) não
// justifica a complexidade de gerenciar uma sessão persistente com
// reconexão.

export class AdNotConfiguredError extends Error {
  constructor() {
    super(
      'Active Directory não configurado: defina AD_URL, AD_BASE_DN, AD_BIND_DN, ' +
        'AD_BIND_PASSWORD e AD_USERS_OU no .env (ver docs/ad-module-plan.md).',
    );
    this.name = 'AdNotConfiguredError';
  }
}

export class AdRequestError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AdRequestError';
  }
}

export class AdUserNotFoundError extends Error {
  constructor(username: string) {
    super(`Usuário "${username}" não encontrado no Active Directory`);
    this.name = 'AdUserNotFoundError';
  }
}

// Lançado quando a ponte 802.1X (POST/DELETE /ad/users/:username/network-access)
// é chamada sem AD_NETWORK_ACCESS_GROUP_DN configurado — diferente de
// AdNotConfiguredError, o resto do módulo (CRUD de usuário) funciona
// normalmente sem essa variável.
export class AdNetworkAccessGroupNotConfiguredError extends Error {
  constructor() {
    super(
      'Ponte 802.1X não configurada: defina AD_NETWORK_ACCESS_GROUP_DN no .env ' +
        '(o DN do grupo que o NPS valida para liberar acesso à rede).',
    );
    this.name = 'AdNetworkAccessGroupNotConfiguredError';
  }
}

function isAdConfigured(): boolean {
  return Boolean(env.AD_URL && env.AD_BASE_DN && env.AD_BIND_DN && env.AD_BIND_PASSWORD && env.AD_USERS_OU);
}

// --- userAccountControl (UAC) — bits documentados publicamente pela
// Microsoft (não é algo específico deste ambiente, ao contrário das
// peculiaridades de firmware das impressoras — não precisa de sondagem ao
// vivo para confirmar). Só os bits que este módulo usa.
const UF_ACCOUNTDISABLE = 0x0002;
const UF_NORMAL_ACCOUNT = 0x0200; // 512
const UF_PASSWD_NOTREQD = 0x0020;

function asString(value: string | string[] | Buffer | Buffer[] | undefined): string | null {
  if (value === undefined) return null;
  if (Buffer.isBuffer(value)) return value.toString('utf8');
  if (Array.isArray(value)) {
    const first = value[0];
    if (first === undefined) return null;
    return Buffer.isBuffer(first) ? first.toString('utf8') : first;
  }
  return value;
}

function asNumber(value: string | string[] | Buffer | Buffer[] | undefined): number | null {
  const str = asString(value);
  if (str === null) return null;
  const parsed = Number(str);
  return Number.isFinite(parsed) ? parsed : null;
}

// userWorkstations é um único atributo AD (não multivalorado): uma string
// separada por vírgula, ex. "PC-FINANCEIRO,PC-COMPRAS". Lista vazia/ausente
// significa "sem restrição" (o padrão do AD — o usuário pode logar em
// qualquer estação).
function parseWorkstations(value: string | string[] | Buffer | Buffer[] | undefined): string[] {
  const str = asString(value);
  if (str === null || str.trim().length === 0) return [];
  return str
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// unicodePwd é a forma padrão do AD de setar/trocar senha via LDAP — exige
// LDAPS (ver AdNotConfiguredError acima) e o valor codificado em UTF-16LE
// entre aspas duplas literais. Documentado publicamente pela Microsoft
// (KB269190 e sucessoras), não uma descoberta deste projeto.
function encodeAdPassword(password: string): Buffer {
  return Buffer.from(`"${password}"`, 'utf16le');
}

export interface AdUser {
  dn: string;
  sAMAccountName: string;
  displayName: string | null;
  mail: string | null;
  department: string | null;
  title: string | null;
  enabled: boolean;
  lockedOut: boolean;
  userWorkstations: string[];
}

const USER_SEARCH_ATTRIBUTES = [
  'distinguishedName',
  'sAMAccountName',
  'displayName',
  'cn',
  'mail',
  'department',
  'title',
  'userAccountControl',
  'lockoutTime',
  'userWorkstations',
];

function toAdUser(entry: Record<string, string | string[] | Buffer | Buffer[]>, dn: string): AdUser {
  const uac = asNumber(entry.userAccountControl) ?? UF_NORMAL_ACCOUNT;
  const lockoutTime = asString(entry.lockoutTime);

  return {
    dn,
    sAMAccountName: asString(entry.sAMAccountName) ?? '',
    displayName: asString(entry.displayName) ?? asString(entry.cn),
    mail: asString(entry.mail),
    department: asString(entry.department),
    title: asString(entry.title),
    enabled: (uac & UF_ACCOUNTDISABLE) === 0,
    // '0' ou ausente = não bloqueado. Qualquer outro valor é um FILETIME
    // Windows (timestamp do bloqueio) — não precisamos decodificar a data
    // aqui, só a presença de um valor não-zero já significa "bloqueado".
    lockedOut: lockoutTime !== null && lockoutTime !== '0',
    userWorkstations: parseWorkstations(entry.userWorkstations),
  };
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  if (!isAdConfigured()) {
    throw new AdNotConfiguredError();
  }

  const client = new Client({ url: env.AD_URL! });
  try {
    await client.bind(env.AD_BIND_DN!, env.AD_BIND_PASSWORD!);
    return await fn(client);
  } catch (err) {
    if (err instanceof AdNotConfiguredError || err instanceof AdUserNotFoundError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new AdRequestError(`Falha na operação com o Active Directory: ${message}`, err);
  } finally {
    try {
      await client.unbind();
    } catch {
      // A conexão já pode ter caído (erro anterior) — fechar de novo não
      // deve mascarar o erro original, que já foi tratado acima.
    }
  }
}

// Resolve um usuário pelo sAMAccountName dentro de uma conexão JÁ aberta
// (bind já feito) — usado internamente por toda operação que precisa do DN
// antes de gravar (update/delete/enable/unlock/reset de senha/workstations),
// para nunca construir um DN "adivinhado" a partir do username.
async function findUserEntry(
  client: Client,
  username: string,
): Promise<Record<string, string | string[] | Buffer | Buffer[]>> {
  const { searchEntries } = await client.search(env.AD_USERS_OU!, {
    scope: 'sub',
    filter: escapeFilter`(&(objectClass=user)(objectCategory=person)(sAMAccountName=${username}))`,
    attributes: USER_SEARCH_ATTRIBUTES,
  });

  const entry = searchEntries[0];
  if (!entry) throw new AdUserNotFoundError(username);
  return entry as unknown as Record<string, string | string[] | Buffer | Buffer[]>;
}

// Busca/lista usuários (escopo funcional, item "Usuários" do plano). Sem
// `query`, lista todos os usuários da OU configurada; com `query`, filtra
// por substring em cn/sAMAccountName/mail (busca "contém", a mesma
// experiência de uma busca de nome comum em qualquer painel admin).
export async function searchUsers(query?: string): Promise<AdUser[]> {
  return withClient(async (client) => {
    const filter = query
      ? escapeFilter`(&(objectClass=user)(objectCategory=person)(|(cn=*${query}*)(sAMAccountName=*${query}*)(mail=*${query}*)))`
      : '(&(objectClass=user)(objectCategory=person))';

    const { searchEntries } = await client.search(env.AD_USERS_OU!, {
      scope: 'sub',
      filter,
      attributes: USER_SEARCH_ATTRIBUTES,
    });

    return searchEntries.map((entry) =>
      toAdUser(entry as unknown as Record<string, string | string[] | Buffer | Buffer[]>, entry.dn),
    );
  });
}

export async function getUser(username: string): Promise<AdUser> {
  return withClient(async (client) => {
    const entry = await findUserEntry(client, username);
    return toAdUser(entry, asString(entry.distinguishedName) ?? (entry.dn as unknown as string));
  });
}

export interface CreateAdUserInput {
  sAMAccountName: string;
  displayName: string;
  mail?: string;
  password: string;
  // Default true — mesma prática recomendada pela Microsoft para contas
  // criadas por um administrador: o usuário troca a senha inicial no
  // primeiro logon em vez de continuar com uma senha que outra pessoa
  // conhece indefinidamente.
  mustChangePasswordAtNextLogon?: boolean;
}

// Cria o usuário em 3 passos LDAP separados — técnica padrão documentada
// pela Microsoft para criar contas via LDAP puro (sem ADSI/PowerShell AD
// module): o AD recusa `unicodePwd` no mesmo `add` que cria o objeto, então
// (1) cria o objeto já com UF_PASSWD_NOTREQD (senão o `add` falha por
// "sem senha"), (2) define a senha via `modify` (unicodePwd), (3) habilita
// a conta (remove UF_PASSWD_NOTREQD/UF_ACCOUNTDISABLE). Se o passo 2 ou 3
// falhar, a conta fica criada mas DESABILITADA — nunca uma conta habilitada
// sem senha definida.
export async function createUser(input: CreateAdUserInput): Promise<AdUser> {
  const mustChangePassword = input.mustChangePasswordAtNextLogon ?? true;
  const dn = `CN=${input.displayName},${env.AD_USERS_OU}`;

  return withClient(async (client) => {
    await client.add(dn, {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      cn: input.displayName,
      sAMAccountName: input.sAMAccountName,
      userPrincipalName: input.mail ?? input.sAMAccountName,
      displayName: input.displayName,
      ...(input.mail ? { mail: input.mail } : {}),
      userAccountControl: String(UF_NORMAL_ACCOUNT | UF_ACCOUNTDISABLE | UF_PASSWD_NOTREQD),
    });

    await client.modify(
      dn,
      new Change({
        operation: 'replace',
        modification: new Attribute({ type: 'unicodePwd', values: [encodeAdPassword(input.password)] }),
      }),
    );

    const changes = [
      new Change({
        operation: 'replace',
        modification: new Attribute({ type: 'userAccountControl', values: [String(UF_NORMAL_ACCOUNT)] }),
      }),
    ];
    if (mustChangePassword) {
      changes.push(
        new Change({
          operation: 'replace',
          modification: new Attribute({ type: 'pwdLastSet', values: ['0'] }),
        }),
      );
    }
    await client.modify(dn, changes);

    const entry = await findUserEntry(client, input.sAMAccountName);
    return toAdUser(entry, dn);
  });
}

export interface UpdateAdUserInput {
  displayName?: string;
  mail?: string;
  department?: string;
  title?: string;
}

export async function updateUser(username: string, updates: UpdateAdUserInput): Promise<AdUser> {
  return withClient(async (client) => {
    const entry = await findUserEntry(client, username);
    const dn = asString(entry.distinguishedName) ?? (entry.dn as unknown as string);

    const changes = (Object.entries(updates) as [keyof UpdateAdUserInput, string | undefined][])
      .filter(([, value]) => value !== undefined)
      .map(
        ([field, value]) =>
          new Change({ operation: 'replace', modification: new Attribute({ type: field, values: [value!] }) }),
      );

    if (changes.length > 0) {
      await client.modify(dn, changes);
    }

    const refreshed = await findUserEntry(client, username);
    return toAdUser(refreshed, dn);
  });
}

export async function deleteUser(username: string): Promise<void> {
  return withClient(async (client) => {
    const entry = await findUserEntry(client, username);
    const dn = asString(entry.distinguishedName) ?? (entry.dn as unknown as string);
    try {
      await client.del(dn);
    } catch (err) {
      if (err instanceof NoSuchObjectError) throw new AdUserNotFoundError(username);
      throw err;
    }
  });
}

export async function setUserEnabled(username: string, enabled: boolean): Promise<void> {
  return withClient(async (client) => {
    const entry = await findUserEntry(client, username);
    const dn = asString(entry.distinguishedName) ?? (entry.dn as unknown as string);
    const currentUac = asNumber(entry.userAccountControl) ?? UF_NORMAL_ACCOUNT;
    const nextUac = enabled ? currentUac & ~UF_ACCOUNTDISABLE : currentUac | UF_ACCOUNTDISABLE;

    await client.modify(
      dn,
      new Change({
        operation: 'replace',
        modification: new Attribute({ type: 'userAccountControl', values: [String(nextUac)] }),
      }),
    );
  });
}

// Desbloqueia uma conta travada por tentativas de senha erradas (política
// de lockout do domínio) — zerar lockoutTime é o mecanismo padrão via LDAP
// puro (equivalente ao botão "Unlock account" do ADUC/PowerShell).
export async function unlockUser(username: string): Promise<void> {
  return withClient(async (client) => {
    const entry = await findUserEntry(client, username);
    const dn = asString(entry.distinguishedName) ?? (entry.dn as unknown as string);

    await client.modify(
      dn,
      new Change({
        operation: 'replace',
        modification: new Attribute({ type: 'lockoutTime', values: ['0'] }),
      }),
    );
  });
}

export async function resetPassword(
  username: string,
  newPassword: string,
  mustChangePasswordAtNextLogon = true,
): Promise<void> {
  return withClient(async (client) => {
    const entry = await findUserEntry(client, username);
    const dn = asString(entry.distinguishedName) ?? (entry.dn as unknown as string);

    await client.modify(
      dn,
      new Change({
        operation: 'replace',
        modification: new Attribute({ type: 'unicodePwd', values: [encodeAdPassword(newPassword)] }),
      }),
    );

    if (mustChangePasswordAtNextLogon) {
      await client.modify(
        dn,
        new Change({
          operation: 'replace',
          modification: new Attribute({ type: 'pwdLastSet', values: ['0'] }),
        }),
      );
    }
  });
}

// Restringe em quais estações o usuário pode logar (`userWorkstations`,
// item do escopo funcional). Lista vazia REMOVE a restrição (o padrão do
// AD é "pode logar em qualquer estação") — apagar o atributo em vez de
// gravar uma string vazia, porque o AD trata "atributo com string vazia"
// de forma inconsistente conforme a versão do schema.
export async function setUserWorkstations(username: string, workstations: string[]): Promise<void> {
  return withClient(async (client) => {
    const entry = await findUserEntry(client, username);
    const dn = asString(entry.distinguishedName) ?? (entry.dn as unknown as string);

    const change =
      workstations.length === 0
        ? new Change({ operation: 'delete', modification: new Attribute({ type: 'userWorkstations' }) })
        : new Change({
            operation: 'replace',
            modification: new Attribute({ type: 'userWorkstations', values: [workstations.join(',')] }),
          });

    await client.modify(dn, change);
  });
}

// --- Ponte 802.1X (item "Ponte 802.1X" do escopo funcional) ---
//
// Endpoint de conveniência: habilitar/revogar acesso à rede é só
// adicionar/remover o usuário do grupo configurado (AD_NETWORK_ACCESS_GROUP_DN)
// — o NPS no Windows Server valida contra membership nesse grupo (infra
// fora do código, documentada em docs/ad-module-plan.md). Modelado como
// chamada específica (não "lembrar de tirar da lista genérica de grupos")
// de propósito: revogar acesso de alguém não pode depender de alguém
// lembrar de editar o grupo certo manualmente.
export async function grantNetworkAccess(username: string): Promise<void> {
  if (!env.AD_NETWORK_ACCESS_GROUP_DN) throw new AdNetworkAccessGroupNotConfiguredError();

  return withClient(async (client) => {
    const entry = await findUserEntry(client, username);
    const dn = asString(entry.distinguishedName) ?? (entry.dn as unknown as string);

    await client.modify(
      env.AD_NETWORK_ACCESS_GROUP_DN!,
      new Change({ operation: 'add', modification: new Attribute({ type: 'member', values: [dn] }) }),
    );
  });
}

export async function revokeNetworkAccess(username: string): Promise<void> {
  if (!env.AD_NETWORK_ACCESS_GROUP_DN) throw new AdNetworkAccessGroupNotConfiguredError();

  return withClient(async (client) => {
    const entry = await findUserEntry(client, username);
    const dn = asString(entry.distinguishedName) ?? (entry.dn as unknown as string);

    await client.modify(
      env.AD_NETWORK_ACCESS_GROUP_DN!,
      new Change({ operation: 'delete', modification: new Attribute({ type: 'member', values: [dn] }) }),
    );
  });
}

export const adService = {
  searchUsers,
  getUser,
  createUser,
  updateUser,
  deleteUser,
  setUserEnabled,
  unlockUser,
  resetPassword,
  setUserWorkstations,
  grantNetworkAccess,
  revokeNetworkAccess,
};
