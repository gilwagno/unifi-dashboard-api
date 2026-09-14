import { readFileSync } from 'node:fs';
import {
  AlreadyExistsError,
  Attribute,
  Change,
  Client,
  DN,
  NoSuchAttributeError,
  NoSuchObjectError,
  TypeOrValueExistsError,
  escapeFilter,
} from 'ldapts';
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

// Base comum de TODO erro tipado deste módulo.
//
// Existe por um achado da subtarefa 4: `withClient` decidia o que
// re-lançar por uma LISTA de `instanceof`, uma classe por vez. Um erro
// tipado novo que ninguém lembrasse de somar àquela lista era silenciosamente
// reembrulhado em `AdRequestError` — a rota perdia o 404/409 e devolvia erro
// genérico. Foi exatamente o que aconteceu com `AdComputerNotFoundError`:
// três testes de integração falharam antes de a lista ser a suspeita.
//
// Com uma base comum a regra vira estrutural: quem herda daqui atravessa o
// `withClient` intacto, e uma subtarefa futura não precisa lembrar de nada.
// Também conserta um caso que a lista nunca cobriu — `AdRequestError`
// lançado DENTRO do callback (a recusa de escrita com UAC ilegível) era
// reembrulhado em outro `AdRequestError`, aninhando a mensagem.
export class AdError extends Error {}

export class AdNotConfiguredError extends AdError {
  constructor() {
    super(
      'Active Directory não configurado: defina AD_URL, AD_BASE_DN, AD_BIND_DN, ' +
        'AD_BIND_PASSWORD e AD_USERS_OU no .env (ver docs/ad-module-plan.md).',
    );
    this.name = 'AdNotConfiguredError';
  }
}

export class AdRequestError extends AdError {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'AdRequestError';
  }
}

export class AdUserNotFoundError extends AdError {
  constructor(username: string) {
    super(`Usuário "${username}" não encontrado no Active Directory`);
    this.name = 'AdUserNotFoundError';
  }
}

// ACHADO GRAVE da revisão crítica (2026-09-10): `createUser` e
// `resetPassword` só podem gravar a senha DEPOIS de outra operação LDAP já
// ter sido despachada (o `add` que cria a conta, ou a resolução do DN via
// busca) — se a operação que grava a senha falhar de um jeito que não deixa
// claro se colou no servidor (timeout, conexão derrubada no meio), a ÚNICA
// cópia da senha tentada (gerada aleatoriamente quando o chamador não
// informa uma) não pode ser simplesmente descartada num erro genérico: o
// operador ficaria sem saber se o AD já exige aquela senha ou não, sem
// nenhuma forma de recuperar o valor. Mesma classe de bug já corrigida em
// `PrinterSwsPasswordVerificationError` (printer-hp-sws.service.ts) — o
// texto do REPORT do crítico cita esse precedente explicitamente. Nunca vai
// pro log (só no corpo da resposta HTTP, ver ad.routes.ts).
export class AdPasswordAmbiguousError extends AdError {
  constructor(
    username: string,
    public readonly attemptedPassword: string,
    public readonly cause?: unknown,
    // Estado CONHECIDO da conta depois da falha ambígua, quando dá pra
    // afirmar: `true` = a escrita da senha/habilitação já confirmou e o
    // que falhou foi a releitura posterior; `null` = desconhecido (a
    // própria escrita falhou sem confirmar). NUNCA afirmar `false` num
    // caminho em que o `modify` pode ter aplicado — ACHADO da 2ª revisão
    // crítica: a rota devolvia `accountEnabled: false` fixo, uma afirmação
    // possivelmente FALSA sobre uma conta de produção com acesso à rede.
    public readonly accountEnabled: boolean | null = null,
  ) {
    super(
      `Não foi possível confirmar se a senha de "${username}" foi realmente alterada no Active Directory — ` +
        'a operação de escrita foi despachada mas a confirmação falhou.',
    );
    this.name = 'AdPasswordAmbiguousError';
    // ACHADO da 2a revisao critica, confirmado empiricamente: o serializador
    // de erro do pino inclui as propriedades proprias ENUMERAVEIS do Error —
    // um `app.log.error(error)` (o catch-all de src/app.ts) gravaria a senha
    // EM CLARO no log, violando a regra dura do projeto. Tornar o campo
    // nao-enumeravel mantem o acesso programatico (`error.attemptedPassword`,
    // usado pela rota) e tira o valor de qualquer serializacao automatica
    // (pino, JSON.stringify, util.inspect padrao).
    Object.defineProperty(this, 'attemptedPassword', {
      value: attemptedPassword,
      enumerable: false,
      writable: false,
      configurable: false,
    });
  }
}

// Lançado quando a ponte 802.1X (POST/DELETE /ad/users/:username/network-access)
// é chamada sem AD_NETWORK_ACCESS_GROUP_DN configurado — diferente de
// AdNotConfiguredError, o resto do módulo (CRUD de usuário) funciona
// normalmente sem essa variável.
export class AdNetworkAccessGroupNotConfiguredError extends AdError {
  constructor() {
    super(
      'Ponte 802.1X não configurada: defina AD_NETWORK_ACCESS_GROUP_DN no .env ' +
        '(o DN do grupo que o NPS valida para liberar acesso à rede).',
    );
    this.name = 'AdNetworkAccessGroupNotConfiguredError';
  }
}

export class AdGroupNotFoundError extends AdError {
  constructor(name: string) {
    super(`Grupo "${name}" não encontrado no Active Directory`);
    this.name = 'AdGroupNotFoundError';
  }
}

export class AdComputerNotFoundError extends AdError {
  constructor(name: string) {
    super(`Computador "${name}" não encontrado no Active Directory`);
    this.name = 'AdComputerNotFoundError';
  }
}

// Lançado só por `createGroup` — diferente de AdNotConfiguredError (o resto
// do módulo de grupos, busca/listagem e add/remove de membro, funciona sem
// AD_GROUPS_OU: ver o comentário da env var em src/config/env.ts).
export class AdGroupsOuNotConfiguredError extends AdError {
  constructor() {
    super('Criação de grupo não configurada: defina AD_GROUPS_OU no .env (a OU onde grupos novos são criados).');
    this.name = 'AdGroupsOuNotConfiguredError';
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
// Bits de conta de COMPUTADOR. Este módulo nunca os escreve — só lê, para
// distinguir uma estação de um controlador de domínio.
//
// ACHADO de revisão: a primeira versão derivava "é DC" pela AUSÊNCIA de
// UF_WORKSTATION_TRUST_ACCOUNT, e isso classifica um RODC ERRADO. Um
// Read-Only Domain Controller É um controlador de domínio, mas a conta
// dele carrega UF_WORKSTATION_TRUST_ACCOUNT junto de
// UF_PARTIAL_SECRETS_ACCOUNT — não UF_SERVER_TRUST_ACCOUNT. Derivar por
// ausência fazia um RODC sair como `isDomainController: false`, ou seja: a
// interface NÃO avisaria antes de desabilitar a conta de um controlador de
// domínio, que é a única coisa para a qual o campo existe. Falha ABERTA,
// no sinal de segurança da operação mais destrutiva do módulo.
//
// A derivação correta é AFIRMATIVA — perguntar quais bits o objeto TEM,
// nunca quais não tem. Assim um UAC desconhecido/atípico erra para
// "não é DC" só quando de fato não carrega nenhum bit de DC, e uma conta
// pré-criada com UAC 0 não vira alarme falso.
const UF_WORKSTATION_TRUST_ACCOUNT = 0x1000;
const UF_SERVER_TRUST_ACCOUNT = 0x2000;
const UF_PARTIAL_SECRETS_ACCOUNT = 0x04000000; // RODC

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
  // `null` quando userAccountControl não veio na leitura (ex.: a conta de
  // serviço do bind não tem permissão de ler esse atributo neste objeto) —
  // ACHADO da revisão crítica: assumir "habilitada" nesse caso falha ABERTO
  // (uma conta desabilitada podia aparecer como ativa num módulo cujo
  // objetivo é controlar acesso à rede). Nunca inventa um valor.
  enabled: boolean | null;
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
  const uac = asNumber(entry.userAccountControl);
  const lockoutTime = asString(entry.lockoutTime);

  return {
    dn,
    sAMAccountName: asString(entry.sAMAccountName) ?? '',
    displayName: asString(entry.displayName) ?? asString(entry.cn),
    mail: asString(entry.mail),
    department: asString(entry.department),
    title: asString(entry.title),
    // `uac === null` (atributo não veio) vira `null`, nunca "habilitada"
    // por padrão — ver o comentário de AdUser.enabled.
    enabled: uac === null ? null : (uac & UF_ACCOUNTDISABLE) === 0,
    // '0' ou ausente = não bloqueado. Qualquer outro valor é um FILETIME
    // Windows (timestamp do bloqueio) — não precisamos decodificar a data
    // aqui, só a presença de um valor não-zero já significa "bloqueado".
    lockedOut: lockoutTime !== null && lockoutTime !== '0',
    userWorkstations: parseWorkstations(entry.userWorkstations),
  };
}

// Constrói `tlsOptions` do `Client` — nunca um jeito de DESLIGAR a
// verificação de certificado, só de ESTENDER quem é confiável (ver
// `AD_TLS_CA_FILE` em src/config/env.ts). Sem a env var, `tlsOptions` fica
// vazio e o `ldapts`/Node verificam contra as CAs padrão do sistema —
// exatamente o que aconteceria contra um AD real com certificado emitido
// por uma CA pública/AD CS já confiada pelo SO. Lido a cada chamada (não
// cacheado): este módulo não é um poller de alta frequência (ver o
// comentário de topo do arquivo sobre abrir/fechar conexão por operação),
// então o custo de um `readFileSync` a mais por chamada é desprezível
// perto do round-trip de rede que já acontece de qualquer forma.
function buildTlsOptions(): import('node:tls').ConnectionOptions | undefined {
  if (!env.AD_TLS_CA_FILE) return undefined;
  return { ca: readFileSync(env.AD_TLS_CA_FILE, 'utf8') };
}

async function withClient<T>(fn: (client: Client) => Promise<T>): Promise<T> {
  if (!isAdConfigured()) {
    throw new AdNotConfiguredError();
  }

  const client = new Client({ url: env.AD_URL!, tlsOptions: buildTlsOptions() });
  try {
    await client.bind(env.AD_BIND_DN!, env.AD_BIND_PASSWORD!);
    return await fn(client);
  } catch (err) {
    // Qualquer erro tipado deste módulo passa intacto — ver o comentário de
    // `AdError`. Só erro CRU da lib/rede é que vira AdRequestError aqui.
    if (err instanceof AdError) throw err;
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

    // `paged: true` — ACHADO da revisão crítica (suspeita, não confirmada
    // contra um AD real): sem paginação explícita, uma OU com mais
    // usuários que o `MaxPageSize` do DC (1000 por padrão) faria o AD
    // recusar com SizeLimitExceededError, e a listagem inteira viraria um
    // 502 sem pista nenhuma da causa. Barato de evitar, sem downside.
    const { searchEntries } = await client.search(env.AD_USERS_OU!, {
      scope: 'sub',
      filter,
      attributes: USER_SEARCH_ATTRIBUTES,
      paged: true,
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

// DN derivado do domínio configurado (AD_BASE_DN, ex. "DC=empresa,DC=local"
// -> "empresa.local") — ACHADO da revisão crítica (suspeita, não confirmada
// contra um AD real): sem `mail`, o UPN virava só `sAMAccountName` pelado,
// sem sufixo de domínio nenhum — o AD aceita isso via LDAP, mas não é um UPN
// de logon válido (`user@dominio`). Deriva o sufixo do próprio `AD_BASE_DN`
// em vez de inventar um domínio — é a fonte de verdade que este módulo já
// tem configurada, mesmo raciocínio de nunca supor um valor que já está
// disponível em outro lugar.
function domainSuffixFromBaseDn(baseDn: string): string {
  return baseDn
    .split(',')
    .map((rdn) => rdn.trim())
    .filter((rdn) => rdn.toUpperCase().startsWith('DC='))
    .map((rdn) => rdn.slice(3))
    .join('.');
}

// ACHADO GRAVE da revisão crítica: o DN era montado por concatenação crua
// (`CN=${displayName},...`), sem nenhum escape — um `displayName` com
// vírgula (ex.: "Silva, João", nome brasileiro comum) produzia um DN
// SINTATICAMENTE INVÁLIDO (a vírgula separa RDNs em LDAP), e um valor como
// "hacker,OU=Servidores" produzia um DN válido mas apontando pra outro
// container, driblando a OU pretendida. Corrigido usando `sAMAccountName`
// (não `displayName`) como CN — é único por definição (já é a chave de
// busca de todo o resto deste serviço) e mais curto/restrito (a rota já
// valida até 20 caracteres, o limite do próprio AD) — e escapado de verdade
// via `DN`/`addPairRDN` do `ldapts` (o mesmo `Filter.escape`-like usado
// internamente pela lib), em vez de reimplementar escape de DN à mão.
function buildUserDn(sAMAccountName: string): string {
  return `${new DN().addPairRDN('CN', sAMAccountName).toString()},${env.AD_USERS_OU}`;
}

// Cria o usuário em 2 operações LDAP (reduzido de 3 pela revisão crítica —
// ver achado abaixo): técnica padrão documentada pela Microsoft pra criar
// contas via LDAP puro (sem ADSI/PowerShell AD module): o AD recusa
// `unicodePwd` no mesmo `add` que cria o objeto, então (1) cria o objeto já
// com UF_PASSWD_NOTREQD (senão o `add` falha por "sem senha"), (2) UM ÚNICO
// `modify` atômico que define a senha (unicodePwd) E habilita a conta
// (remove UF_PASSWD_NOTREQD/UF_ACCOUNTDISABLE) E, se pedido, força troca no
// próximo logon (pwdLastSet=0) — os 3 atributos no mesmo `client.modify`
// (LDAP garante atomicidade entre changes da mesma requisição: ou todos
// aplicam, ou nenhum aplica). Antes da revisão crítica, os passos 2 e 3
// eram `modify`s SEPARADOS — havia uma janela real entre "senha definida"
// e "conta habilitada" onde uma falha no meio perdia a senha gerada sem
// deixar rastro. Combinando num só, a garantia "nunca uma conta habilitada
// sem senha" fica estrutural (não depende de nenhum dos dois `modify`
// terem rodado em sequência), e só resta uma janela entre o `add` (passo 1)
// e o `modify` atômico (passo 2) — se o `modify` falhar de um jeito
// ambíguo (sem confirmar se aplicou), a conta fica desabilitada+sem senha
// (seguro, igual antes) OU já habilitada+com a senha pretendida — nunca um
// meio-termo perigoso. Essa janela ainda pode perder a única cópia da senha
// gerada, por isso o `catch` abaixo a preserva via AdPasswordAmbiguousError
// (mesma disciplina de PrinterSwsPasswordVerificationError, achado grave da
// revisão crítica).
export async function createUser(input: CreateAdUserInput): Promise<AdUser> {
  const mustChangePassword = input.mustChangePasswordAtNextLogon ?? true;
  const dn = buildUserDn(input.sAMAccountName);
  const domainSuffix = domainSuffixFromBaseDn(env.AD_BASE_DN ?? '');
  const userPrincipalName = input.mail ?? (domainSuffix ? `${input.sAMAccountName}@${domainSuffix}` : input.sAMAccountName);

  return withClient(async (client) => {
    await client.add(dn, {
      objectClass: ['top', 'person', 'organizationalPerson', 'user'],
      cn: input.sAMAccountName,
      sAMAccountName: input.sAMAccountName,
      userPrincipalName,
      displayName: input.displayName,
      ...(input.mail ? { mail: input.mail } : {}),
      userAccountControl: String(UF_NORMAL_ACCOUNT | UF_ACCOUNTDISABLE | UF_PASSWD_NOTREQD),
    });

    const changes = [
      new Change({
        operation: 'replace',
        modification: new Attribute({ type: 'unicodePwd', values: [encodeAdPassword(input.password)] }),
      }),
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

    try {
      await client.modify(dn, changes);
    } catch (err) {
      // Estado AMBÍGUO: o `add` já aconteceu (a conta existe, desabilitada
      // e sem senha exigida) e este `modify` pode ou não ter aplicado a
      // senha antes de falhar — não dá pra saber sem reler o objeto, e
      // mesmo relendo não dá pra confirmar a SENHA (unicodePwd nunca é
      // legível via LDAP). Preserva a senha tentada em vez de descartá-la
      // num erro genérico.
      throw new AdPasswordAmbiguousError(input.sAMAccountName, input.password, err);
    }

    // ACHADO da 2ª revisão crítica: esta releitura acontece DEPOIS do
    // `modify` ter CONFIRMADO — a conta já está habilitada e já exige a
    // senha gerada. Se a busca falhar aqui (rede caindo entre as duas
    // operações, ou replicação do DC ainda não propagada), o erro
    // genérico/404 descartava a única cópia da senha: exatamente o achado
    // bloqueante nº 3 da 1ª revisão, sobrevivendo neste caminho. A senha é
    // preservada, e desta vez `accountEnabled` é afirmável (`true`).
    try {
      const entry = await findUserEntry(client, input.sAMAccountName);
      return toAdUser(entry, asString(entry.distinguishedName) ?? dn);
    } catch (err) {
      throw new AdPasswordAmbiguousError(input.sAMAccountName, input.password, err, true);
    }
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
    const currentUac = asNumber(entry.userAccountControl);
    // ACHADO da revisão crítica: assumir UF_NORMAL_ACCOUNT quando o atributo
    // não vem legível (ex.: a conta de serviço do bind sem permissão de
    // leitura nesse campo específico) fazia esta função GRAVAR um valor
    // adivinhado por cima da configuração real — apagando em silêncio
    // qualquer outro bit já setado (DONT_EXPIRE_PASSWORD, SMARTCARD_REQUIRED
    // etc.), a mesma classe de bug já corrigida em `extractAdminField`
    // (printer-hp-sws.service.ts). Recusar a escrita é mais seguro do que
    // adivinhar o estado atual de uma credencial mestra de acesso à rede.
    if (currentUac === null) {
      throw new AdRequestError(
        `Não foi possível ler userAccountControl de "${username}" antes de ${enabled ? 'habilitar' : 'desabilitar'} — recusando a escrita para não sobrescrever bits desconhecidos.`,
      );
    }
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

// ACHADO GRAVE da revisão crítica, corrigido: os dois `modify` (senha +
// pwdLastSet) eram chamadas SEPARADAS — se a segunda falhasse depois da
// primeira ter sucesso, a senha do usuário JÁ TINHA MUDADO no AD, mas a
// única cópia da senha nova (gerada aleatoriamente quando o chamador não
// informa uma) morria num erro genérico, sem `pwdLastSet=0` aplicado.
// Combinadas num ÚNICO `client.modify(dn, [...])`, o LDAP garante
// atomicidade entre as changes da mesma requisição — ou as duas aplicam,
// ou nenhuma aplica. Se a chamada falhar de um jeito que não confirma qual
// dos dois casos aconteceu, a senha tentada é preservada via
// AdPasswordAmbiguousError (nunca descartada num erro genérico).
export async function resetPassword(
  username: string,
  newPassword: string,
  mustChangePasswordAtNextLogon = true,
): Promise<void> {
  return withClient(async (client) => {
    const entry = await findUserEntry(client, username);
    const dn = asString(entry.distinguishedName) ?? (entry.dn as unknown as string);

    const changes = [
      new Change({
        operation: 'replace',
        modification: new Attribute({ type: 'unicodePwd', values: [encodeAdPassword(newPassword)] }),
      }),
    ];
    if (mustChangePasswordAtNextLogon) {
      changes.push(
        new Change({
          operation: 'replace',
          modification: new Attribute({ type: 'pwdLastSet', values: ['0'] }),
        }),
      );
    }

    try {
      await client.modify(dn, changes);
    } catch (err) {
      throw new AdPasswordAmbiguousError(username, newPassword, err);
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

// --- Membership de grupo — mecanismo comum a "Grupos/privilégios" e à
// ponte 802.1X (item "Ponte 802.1X" do escopo funcional): no AD, privilégio
// É pertencer a um grupo. `applyGroupMembership` é o ÚNICO ponto do módulo
// que despacha um `add`/`delete` de `member` — extraído nesta subtarefa
// (grupos) a partir do que já existia em grantNetworkAccess/
// revokeNetworkAccess, para que a garantia de idempotência abaixo proteja
// os DOIS caminhos (rede 802.1X e grupo genérico) de uma vez só, em vez de
// duplicada em dois lugares que podiam divergir com o tempo.
//
// ACHADO da revisão crítica da PR #25 (preservado, agora generalizado): a
// ponte 802.1X não era idempotente — conceder acesso a quem já tem (o AD
// recusa com TypeOrValueExistsError/AlreadyExistsError) ou revogar de quem
// já não tem (NoSuchAttributeError) virava um 502 genérico. Numa ação de
// SEGURANÇA (é literalmente "esta pessoa tem ou não tem este privilégio
// agora"), um operador vendo 502 ao revogar acesso durante um incidente
// pode concluir, errado, que a pessoa AINDA tem acesso — o pior tipo de
// ambiguidade nesta função específica. Tratar o estado final desejado como
// sucesso (idempotente) é mais seguro do que expor a distinção "já estava
// assim" vs "acabei de aplicar". Vale igualmente para um grupo de
// privilégio qualquer (achado desta subtarefa): um operador adicionando
// alguém a um grupo administrativo que a pessoa já integra, ou removendo de
// um que ela já não integra, não deveria ver um erro genérico.
// Releitura do `member` do grupo. Devolve TRÊS estados, nunca dois: o
// terceiro (`undetermined`) existe porque "não consegui ler os membros" NÃO
// é a mesma afirmação que "não é membro" — colapsar os dois faria uma
// revogação que nunca leu o diretório relatar SUCESSO, o falso positivo
// exato que `applyGroupMembership` existe para evitar. Casos reais de AD
// que caem em `undetermined`:
//   - a busca `base` não devolve entrada nenhuma (grupo removido/renomeado
//     entre o modify e a releitura, referral, ACL sobre o OBJETO inteiro);
//   - RANGE RETRIEVAL: acima de ~1500 membros o AD não devolve `member` e
//     sim `member;range=0-1499`, então `entry.member` vem `undefined` num
//     grupo que está cheio;
//   - a própria busca falhar.
//
// LIMITE CONHECIDO, NÃO COBERTO — leia antes de confiar nesta função como
// garantia absoluta: `member` ausente SEM nenhum `member;range=` é tratado
// como grupo genuinamente VAZIO (`not-member`). Um AD que filtre o
// atributo `member` por ACL — bind que enxerga o objeto mas não a lista de
// membros — devolve exatamente a mesma resposta, e aí `not-member` é uma
// afirmação FALSA: a revogação relataria sucesso sem ter revogado. As duas
// respostas são indistinguíveis no protocolo, então não há correção
// possível aqui dentro; fechar isso exigiria um sinal independente (o
// `memberOf` do próprio usuário, por exemplo). Registrado como limitação,
// não como segurança — um comentário anterior afirmava que esse caso caía
// em `undetermined`, e afirmava errado.
type MembershipState = 'member' | 'not-member' | 'undetermined';

async function readMembership(client: Client, groupDn: string, memberDn: string): Promise<MembershipState> {
  let entry: Record<string, string | string[] | Buffer | Buffer[]> | undefined;
  try {
    const { searchEntries } = await client.search(groupDn, { scope: 'base', attributes: ['member'] });
    entry = searchEntries[0] as unknown as Record<string, string | string[] | Buffer | Buffer[]> | undefined;
  } catch {
    return 'undetermined';
  }
  if (!entry) return 'undetermined';
  const memberValue = entry.member;
  if (memberValue === undefined) {
    const ranged = Object.keys(entry).some((k) => k.toLowerCase().startsWith('member;range='));
    return ranged ? 'undetermined' : 'not-member';
  }
  const members = Array.isArray(memberValue) ? memberValue : [memberValue];
  const targetLower = memberDn.toLowerCase();
  return members.some((m) => (asString(m) ?? '').toLowerCase() === targetLower) ? 'member' : 'not-member';
}

// ACHADO de um teste de fumaça supervisionado contra um AD REAL (Windows
// Server 2016, 2026-09-11): o catch por classe de erro abaixo, escrito só
// contra o `fake-ldap-server` (que segue a RFC ao pé da letra), não cobre
// o que o AD real de fato devolve. Medido:
//   - add de quem JÁ é membro -> 68 AlreadyExistsError (cobria)
//   - delete de quem JÁ NÃO é membro -> 53 UnwillingToPerformError, NÃO 16
//     NoSuchAttributeError (não cobria — QUEBRAVA a idempotência que este
//     comentário histórico abaixo promete)
// O código 53 é genérico demais para capturar: o AD também o usa para
// recusas LEGÍTIMAS (restrição de schema, membro obrigatório, grupo
// protegido) — tratar todo 53 como "já estava assim" trocaria um falso
// negativo (erro onde não devia) por um falso positivo (sucesso onde
// devia ter falhado de verdade), pior numa função de segurança.
// A garantia de verdade não pode depender de prever todo resultCode de
// todo AD: em caso de falha, RELEIA o grupo e confira o estado final.
// Atingiu o estado desejado -> sucesso (mesmo princípio da verificação por
// relogin da troca de senha da HP). Não atingiu -> propaga o erro
// ORIGINAL da operação de modify (não um erro genérico da releitura, que
// perderia a causa raiz).
// A releitura vem PRIMEIRO e é a única palavra sempre que houver estado
// legível; os catches por classe de erro só decidem quando ela devolve
// `undetermined`. A ordem importa: com os catches na frente, o ramo de
// `add` era inalcançável na prática (o AD real devolve 68, que o catch
// já tratava) e ficava indefeso contra regressão.
async function applyGroupMembership(client: Client, groupDn: string, memberDn: string, operation: 'add' | 'delete'): Promise<void> {
  try {
    await client.modify(groupDn, new Change({ operation, modification: new Attribute({ type: 'member', values: [memberDn] }) }));
  } catch (err) {
    const state = await readMembership(client, groupDn, memberDn);

    if (state === 'undetermined') {
      // Só aqui a classe do erro volta a decidir — é o único caso em que
      // não há estado lido para consultar: a releitura falhou, não trouxe
      // entrada, ou trouxe o grupo com `member;range=`. (NÃO é o caso de
      // ACL sobre o atributo `member`, que é indistinguível de grupo vazio
      // e nem chega aqui — ver o limite registrado em `readMembership`.)
      if (operation === 'add' && (err instanceof TypeOrValueExistsError || err instanceof AlreadyExistsError)) return;
      if (operation === 'delete' && err instanceof NoSuchAttributeError) return;
      throw err;
    }

    if (operation === 'add' && state === 'member') return;
    if (operation === 'delete' && state === 'not-member') return;
    throw err;
  }
}

export async function grantNetworkAccess(username: string): Promise<void> {
  if (!env.AD_NETWORK_ACCESS_GROUP_DN) throw new AdNetworkAccessGroupNotConfiguredError();

  return withClient(async (client) => {
    const entry = await findUserEntry(client, username);
    const dn = asString(entry.distinguishedName) ?? (entry.dn as unknown as string);
    await applyGroupMembership(client, env.AD_NETWORK_ACCESS_GROUP_DN!, dn, 'add');
  });
}

export async function revokeNetworkAccess(username: string): Promise<void> {
  if (!env.AD_NETWORK_ACCESS_GROUP_DN) throw new AdNetworkAccessGroupNotConfiguredError();

  return withClient(async (client) => {
    const entry = await findUserEntry(client, username);
    const dn = asString(entry.distinguishedName) ?? (entry.dn as unknown as string);
    await applyGroupMembership(client, env.AD_NETWORK_ACCESS_GROUP_DN!, dn, 'delete');
  });
}

// --- Grupos / privilégios (item "Grupos / privilégios" do escopo
// funcional — subtarefa 3, ver docs/ad-module-plan.md) ---
//
// Mesma disciplina do bloco de usuários: nunca concatenação crua de DN/
// filtro (achado bloqueante da PR #25 — um grupo é AINDA mais sensível que
// um usuário, é o próprio mecanismo de privilégio do AD), busca sempre
// paginada, `member` exposto como lista de DNs (não resolvido para
// sAMAccountName — resolver cada membro custaria uma busca por membro, sem
// pedido explícito para isso no escopo funcional).

// Um membro de grupo RESOLVIDO: sabemos se é uma pessoa ou outro GRUPO.
//
// Essa distinção não é cosmética — é o bug de produção que motivou a
// Decisão 2 desta onda. Medido contra o AD real em 2026-09-14: o grupo de
// acesso à rede tinha 20 membros diretos, dos quais 12 eram grupos
// departamentais inteiros, carregando 61 pessoas por HERANÇA. Remover
// alguém que entrou por herança é impossível pela membership direta: a
// operação retorna SUCESSO e a pessoa continua com acesso.
//
// `type: 'group'` é, portanto, o aviso de que aquela linha traz gente que o
// dashboard NÃO controla. `'unknown'` quando o objeto não pôde ser
// resolvido (ACL, ou membro de outro domínio) — nunca chutado para 'user',
// porque o chute cairia justamente no lado que não gera aviso.
export interface AdGroupMember {
  dn: string;
  name: string;
  type: 'user' | 'group' | 'unknown';
}

export interface AdGroup {
  dn: string;
  cn: string;
  description: string | null;
  members: string[];
  // Só preenchido por `getGroup` (o detalhe de UM grupo). `searchGroups`
  // deixa `undefined`: resolver membros de todos os grupos do domínio numa
  // listagem custaria uma busca por grupo sem ninguém ter pedido.
  memberDetails?: AdGroupMember[];
}

const GROUP_SEARCH_ATTRIBUTES = ['distinguishedName', 'cn', 'description', 'member'];

function toAdGroup(entry: Record<string, string | string[] | Buffer | Buffer[]>, dn: string): AdGroup {
  const memberValue = entry.member;
  const members = memberValue === undefined ? [] : Array.isArray(memberValue) ? memberValue.map((m) => asString(m) ?? '') : [asString(memberValue) ?? ''];

  return {
    dn,
    cn: asString(entry.cn) ?? '',
    description: asString(entry.description),
    members: members.filter((m) => m.length > 0),
  };
}

// Busca um grupo pelo `cn` (RDN convencional de grupo no AD) dentro de uma
// conexão JÁ aberta — mesmo papel de `findUserEntry`: nunca constrói um DN
// "adivinhado" a partir do nome, sempre resolve via busca real primeiro.
// Escopo é AD_BASE_DN (a raiz do domínio), não AD_GROUPS_OU — grupos de
// segurança no AD real frequentemente vivem fora de qualquer OU dedicada
// (ex.: o container padrão "CN=Users", onde a própria
// AD_NETWORK_ACCESS_GROUP_DN de exemplo deste projeto vive), e restringir a
// busca a AD_GROUPS_OU faria "buscar/listar" (que não deveria depender de
// onde o grupo foi CRIADO) não encontrar um grupo pré-existente do domínio.
async function findGroupEntry(client: Client, name: string): Promise<Record<string, string | string[] | Buffer | Buffer[]>> {
  const { searchEntries } = await client.search(env.AD_BASE_DN!, {
    scope: 'sub',
    filter: escapeFilter`(&(objectClass=group)(cn=${name}))`,
    attributes: GROUP_SEARCH_ATTRIBUTES,
  });

  const entry = searchEntries[0];
  if (!entry) throw new AdGroupNotFoundError(name);
  return entry as unknown as Record<string, string | string[] | Buffer | Buffer[]>;
}

export async function searchGroups(query?: string): Promise<AdGroup[]> {
  return withClient(async (client) => {
    const filter = query
      ? escapeFilter`(&(objectClass=group)(|(cn=*${query}*)(description=*${query}*)))`
      : '(objectClass=group)';

    // `paged: true` — mesma razão de searchUsers: uma base com mais grupos
    // que o MaxPageSize do DC (1000 por padrão) recusaria com
    // SizeLimitExceededError sem isto.
    const { searchEntries } = await client.search(env.AD_BASE_DN!, {
      scope: 'sub',
      filter,
      attributes: GROUP_SEARCH_ATTRIBUTES,
      paged: true,
    });

    return searchEntries.map((entry) =>
      toAdGroup(entry as unknown as Record<string, string | string[] | Buffer | Buffer[]>, entry.dn),
    );
  });
}

// Resolve a lista de DNs de `member` em objetos que dizem o que cada um É.
//
// UMA busca só, com um OR de distinguishedName — não uma busca por membro.
// Um grupo com 20 membros custaria 20 round-trips ao DC pelo caminho
// ingênuo; aqui custa 1. (O comentário original deste bloco dizia que
// resolver membros "custaria uma busca por membro" e por isso não era
// feito — custaria, do jeito ingênuo. Não é o jeito usado aqui.)
//
// Um DN que a busca não devolver vira `'unknown'`, nunca `'user'`: o
// palpite cairia justamente no lado que NÃO gera aviso na tela.
async function resolveGroupMembers(client: Client, memberDns: string[]): Promise<AdGroupMember[]> {
  if (memberDns.length === 0) return [];

  const filter = `(|${memberDns.map((dn) => escapeFilter`(distinguishedName=${dn})`).join('')})`;
  const { searchEntries } = await client.search(env.AD_BASE_DN!, {
    scope: 'sub',
    filter,
    attributes: ['distinguishedName', 'cn', 'sAMAccountName', 'objectClass'],
    paged: true,
  });

  const porDn = new Map<string, Record<string, string | string[] | Buffer | Buffer[]>>();
  for (const raw of searchEntries) {
    const e = raw as unknown as Record<string, string | string[] | Buffer | Buffer[]>;
    const dn = asString(e.distinguishedName) ?? (raw.dn as unknown as string);
    porDn.set(dn.toLowerCase(), e);
  }

  return memberDns.map((dn) => {
    const e = porDn.get(dn.toLowerCase());
    if (!e) return { dn, name: rdnValue(dn), type: 'unknown' as const };

    const ocRaw = e.objectClass;
    const oc = (Array.isArray(ocRaw) ? ocRaw : ocRaw ? [ocRaw] : []).map((v) => (asString(v) ?? '').toLowerCase());
    const type = oc.includes('group') ? ('group' as const) : oc.includes('user') ? ('user' as const) : ('unknown' as const);

    return { dn, name: asString(e.cn) ?? asString(e.sAMAccountName) ?? rdnValue(dn), type };
  });
}

// Extrai o valor do primeiro RDN de um DN para exibição, respeitando o
// escape com barra invertida (`CN=Silva\, João,OU=...` é UM componente, não
// dois) — dividir por vírgula crua partiria nomes brasileiros no meio.
function rdnValue(dn: string): string {
  // A máscara PRECISA preservar o COMPRIMENTO do original: o índice achado
  // aqui é usado para cortar `dn`, não `semEscape`. Trocar 2 caracteres por
  // 1 desalinharia tudo depois do primeiro escape.
  const semEscape = dn.replace(/\\./g, '\u0000\u0000');
  const corte = semEscape.indexOf(',');
  const primeiro = corte === -1 ? dn : dn.slice(0, corte);
  const igual = primeiro.indexOf('=');
  const valor = igual === -1 ? primeiro : primeiro.slice(igual + 1);
  return unescapeRdnValue(valor);
}

// Desfaz o escape de um valor de RDN (RFC 4514 §2.4). São DUAS formas, e
// tratar só a primeira era um bug: `\,` (barra + caractere) E `\2C` (barra
// + par hexadecimal). Um AD grava vírgula em CN das duas maneiras dependendo
// da ferramenta que criou o objeto — `CN=Silva\2C João` é tão válido quanto
// `CN=Silva\, João`, e a versão anterior devolvia "Silva2C João" na tela.
function unescapeRdnValue(valor: string): string {
  return valor.replace(/\\([0-9a-fA-F]{2}|.)/g, (_todo, capturado: string) =>
    capturado.length === 2 && /^[0-9a-fA-F]{2}$/.test(capturado)
      ? String.fromCharCode(Number.parseInt(capturado, 16))
      : capturado,
  );
}


export async function getGroup(name: string): Promise<AdGroup> {
  return withClient(async (client) => {
    const entry = await findGroupEntry(client, name);
    const group = toAdGroup(entry, asString(entry.distinguishedName) ?? (entry.dn as unknown as string));
    return { ...group, memberDetails: await resolveGroupMembers(client, group.members) };
  });
}

export interface CreateAdGroupInput {
  name: string;
  description?: string;
}

// DN derivado de AD_GROUPS_OU, escapado via `DN.addPairRDN` — mesma técnica
// (e mesmo motivo, ver `buildUserDn` acima) de `buildUserDn`: nunca
// concatenação crua. Um `name` como "x,OU=Servidores" (que a rota já barra
// por Zod, mas o serviço precisa continuar seguro por conta própria —
// defesa em profundidade, mesmo raciocínio da PR #25) não pode produzir um
// DN válido apontando para fora de AD_GROUPS_OU.
function buildGroupDn(name: string): string {
  return `${new DN().addPairRDN('CN', name).toString()},${env.AD_GROUPS_OU}`;
}

// Grupo de segurança global — groupType -2147483646 é o valor documentado
// publicamente pela Microsoft para "security group, global scope" (o tipo
// mais comum para privilégio de aplicação/rede, o mesmo tipo do grupo de
// exemplo AD_NETWORK_ACCESS_GROUP_DN). Criado em UMA única operação (`add`)
// — diferente de `createUser`, não há um segredo (senha) cuja perda exigiria
// o cuidado de AdPasswordAmbiguousError: se o `add` falhar, nada foi criado,
// e se falhar a releitura pós-criação, o chamador só perde a confirmação
// de campos (o grupo já existe de qualquer forma, recuperável por uma busca
// normal) — não a mesma classe de dado irrecuperável.
export async function createGroup(input: CreateAdGroupInput): Promise<AdGroup> {
  if (!env.AD_GROUPS_OU) throw new AdGroupsOuNotConfiguredError();
  const dn = buildGroupDn(input.name);

  return withClient(async (client) => {
    await client.add(dn, {
      objectClass: ['top', 'group'],
      cn: input.name,
      groupType: '-2147483646',
      ...(input.description ? { description: input.description } : {}),
    });

    const entry = await findGroupEntry(client, input.name);
    return toAdGroup(entry, asString(entry.distinguishedName) ?? dn);
  });
}

// Adiciona/remove um USUÁRIO (identificado por sAMAccountName, mesma chave
// usada no resto do módulo) de um GRUPO (identificado por cn) — reaproveita
// `findUserEntry` (resolve o DN do membro sem adivinhar) + `findGroupEntry`
// (resolve o DN do grupo sem adivinhar) + `applyGroupMembership` (a mesma
// garantia de idempotência da ponte 802.1X, ver comentário acima). Se o
// USUÁRIO não existe, propaga AdUserNotFoundError (falha alto e claro —
// diferente de "já não é membro", que é sucesso; "a pessoa não existe" não
// é um estado de membership válido para tornar idempotente). Se o GRUPO não
// existe, propaga AdGroupNotFoundError.
export async function addGroupMember(groupName: string, username: string): Promise<void> {
  return withClient(async (client) => {
    const userEntry = await findUserEntry(client, username);
    const userDn = asString(userEntry.distinguishedName) ?? (userEntry.dn as unknown as string);
    const groupEntry = await findGroupEntry(client, groupName);
    const groupDn = asString(groupEntry.distinguishedName) ?? (groupEntry.dn as unknown as string);
    await applyGroupMembership(client, groupDn, userDn, 'add');
  });
}

export async function removeGroupMember(groupName: string, username: string): Promise<void> {
  return withClient(async (client) => {
    const userEntry = await findUserEntry(client, username);
    const userDn = asString(userEntry.distinguishedName) ?? (userEntry.dn as unknown as string);
    const groupEntry = await findGroupEntry(client, groupName);
    const groupDn = asString(groupEntry.distinguishedName) ?? (groupEntry.dn as unknown as string);
    await applyGroupMembership(client, groupDn, userDn, 'delete');
  });
}

// --- Computadores (item "Computadores" do escopo funcional — subtarefa 4,
// ver docs/ad-module-plan.md) ---
//
// Mesma disciplina dos blocos anteriores: nunca concatenação crua de DN ou
// filtro, `enabled` é `boolean | null` (nunca assume "habilitado" quando o
// atributo não veio legível), e a escrita recusa se não conseguiu LER o
// estado atual antes — ver o comentário de `setComputerEnabled`.
//
// DUAS PECULIARIDADES do objeto `computer` no AD, que não existem em
// usuário/grupo e que o resto deste arquivo não cobria:
//
//  1. O `sAMAccountName` de um computador termina em `$` (`EA-PC-TI01$`),
//     mas o `cn` NÃO (`EA-PC-TI01`). Quem chama a API digita o nome como
//     aparece na tela — sem `$`. Por isso `findComputerEntry` casa nos
//     DOIS: aceitar só uma das formas faria metade das buscas legítimas
//     devolver 404.
//
//  2. `objectClass=computer` casa TAMBÉM controladores de domínio (são
//     computadores, com UF_SERVER_TRUST_ACCOUNT em vez de
//     UF_WORKSTATION_TRUST_ACCOUNT). Eles NÃO são escondidos da listagem —
//     omitir um DC de um inventário seria mentir sobre o que existe no
//     domínio — mas `isDomainController` é exposto para que a interface
//     possa avisar antes de alguém desabilitar um. Desabilitar a conta de
//     um DC derruba o domínio.

export interface AdComputer {
  dn: string;
  // Nome como aparece no ADUC e na tela — sem o `$` do sAMAccountName.
  name: string;
  sAMAccountName: string;
  dnsHostName: string | null;
  operatingSystem: string | null;
  operatingSystemVersion: string | null;
  description: string | null;
  // `null` quando userAccountControl não veio na leitura — mesma regra (e
  // mesma razão) de `AdUser.enabled`: nunca falhar ABERTO afirmando
  // "habilitado" sobre um objeto cujo estado não foi possível ler.
  enabled: boolean | null;
  // `null` pela mesma razão: sem UAC legível não dá para afirmar nem
  // negar. Um `false` aqui seria uma afirmação, não uma lacuna.
  isDomainController: boolean | null;
}

const COMPUTER_SEARCH_ATTRIBUTES = [
  'distinguishedName',
  'cn',
  'sAMAccountName',
  'dNSHostName',
  'operatingSystem',
  'operatingSystemVersion',
  'description',
  'userAccountControl',
];

function toAdComputer(entry: Record<string, string | string[] | Buffer | Buffer[]>, dn: string): AdComputer {
  const uac = asNumber(entry.userAccountControl);
  const sam = asString(entry.sAMAccountName) ?? '';

  return {
    dn,
    // Preferimos o `cn`; o fallback tira o `$` para não vazar a forma
    // interna do AD para a tela quando o `cn` não vier.
    name: asString(entry.cn) ?? sam.replace(/\$$/, ''),
    sAMAccountName: sam,
    // O AD grafa este atributo como `dNSHostName` e o `ldapts` devolve a
    // chave exatamente como o servidor a escreveu. Houve aqui um fallback
    // para a grafia minúscula "por segurança" — a revisão provou por
    // mutação que era CÓDIGO MORTO (removê-lo não matava teste nenhum).
    // Fallback que nada exercita não é defesa, é ruído que finge ser.
    dnsHostName: asString(entry.dNSHostName),
    operatingSystem: asString(entry.operatingSystem),
    operatingSystemVersion: asString(entry.operatingSystemVersion),
    description: asString(entry.description),
    enabled: uac === null ? null : (uac & UF_ACCOUNTDISABLE) === 0,
    isDomainController: uac === null ? null : (uac & (UF_SERVER_TRUST_ACCOUNT | UF_PARTIAL_SECRETS_ACCOUNT)) !== 0,
  };
}

// Normaliza o nome recebido pela API para a forma do `cn` (sem `$`).
function normalizeComputerName(name: string): string {
  return name.endsWith('$') ? name.slice(0, -1) : name;
}

async function findComputerEntry(
  client: Client,
  name: string,
): Promise<Record<string, string | string[] | Buffer | Buffer[]>> {
  const cn = normalizeComputerName(name);
  const sam = `${cn}$`;
  const { searchEntries } = await client.search(env.AD_BASE_DN!, {
    scope: 'sub',
    filter: escapeFilter`(&(objectClass=computer)(|(cn=${cn})(sAMAccountName=${sam})))`,
    attributes: COMPUTER_SEARCH_ATTRIBUTES,
  });

  const entry = searchEntries[0];
  if (!entry) throw new AdComputerNotFoundError(name);
  return entry as unknown as Record<string, string | string[] | Buffer | Buffer[]>;
}

export async function searchComputers(query?: string): Promise<AdComputer[]> {
  return withClient(async (client) => {
    const filter = query
      ? escapeFilter`(&(objectClass=computer)(|(cn=*${query}*)(dNSHostName=*${query}*)(description=*${query}*)))`
      : '(objectClass=computer)';

    // `paged: true` pela mesma razão de searchUsers/searchGroups: um
    // domínio com mais computadores que o MaxPageSize do DC (1000 por
    // padrão) recusaria a busca inteira com SizeLimitExceededError.
    const { searchEntries } = await client.search(env.AD_BASE_DN!, {
      scope: 'sub',
      filter,
      attributes: COMPUTER_SEARCH_ATTRIBUTES,
      paged: true,
    });

    return searchEntries.map((entry) =>
      toAdComputer(entry as unknown as Record<string, string | string[] | Buffer | Buffer[]>, entry.dn),
    );
  });
}

export async function getComputer(name: string): Promise<AdComputer> {
  return withClient(async (client) => {
    const entry = await findComputerEntry(client, name);
    return toAdComputer(entry, asString(entry.distinguishedName) ?? (entry.dn as unknown as string));
  });
}

// Habilita/desabilita a CONTA do computador no domínio.
//
// NÃO é o mesmo que desligar a máquina: desabilitar a conta quebra o canal
// seguro entre o computador e o domínio — quem já está logado continua,
// mas logons novos com credencial de domínio param, e reverter costuma
// exigir reingressar a máquina no domínio. É destrutivo na prática, e por
// isso a rota que expõe isto fica no rate limit restrito.
//
// A recusa quando `userAccountControl` não é legível é o MESMO achado já
// corrigido em `setUserEnabled`: gravar um UAC adivinhado apagaria em
// silêncio os outros bits já setados no objeto. Aqui o risco é MAIOR que
// em usuário — um dos bits que se perderia é justamente o que distingue
// uma estação de um controlador de domínio.
export async function setComputerEnabled(name: string, enabled: boolean): Promise<void> {
  return withClient(async (client) => {
    const entry = await findComputerEntry(client, name);
    const dn = asString(entry.distinguishedName) ?? (entry.dn as unknown as string);
    const currentUac = asNumber(entry.userAccountControl);
    if (currentUac === null) {
      throw new AdRequestError(
        `Não foi possível ler userAccountControl de "${name}" antes de ${enabled ? 'habilitar' : 'desabilitar'} — recusando a escrita para não sobrescrever bits desconhecidos.`,
      );
    }
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
  searchGroups,
  getGroup,
  createGroup,
  addGroupMember,
  removeGroupMember,
  searchComputers,
  getComputer,
  setComputerEnabled,
};
