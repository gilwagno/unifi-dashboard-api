// Tipos do `fake-ldap-server` (escrito em `.mjs` puro, sem TypeScript).
//
// Existem porque ligar o typecheck de `tests/` revelou que
// `tests/integration/ad-fake-ldap.test.ts` importava este módulo como `any`
// implícito (TS7016) — e daí cascateava: `entry.attrs`, `entry.dn` e o
// retorno de `startFakeLdapServer` eram todos `unknown`/`{}`, e o
// compilador não podia checar NADA do que aquele arquivo faz com o
// diretório. Um teste que manipula o diretório do fake por dentro sem tipo
// nenhum pode estar lendo um atributo que não existe e ninguém saber.
//
// Declarar o contrato aqui é melhor que espalhar `as` pelos testes: o tipo
// fica num lugar só, e um teste futuro que use o fake errado passa a
// falhar no compilador em vez de silenciosamente não afirmar nada.

/** Uma entrada do diretório em memória: DN + atributos multivalorados. */
export interface FakeLdapEntry {
  dn: string;
  /** Chave em MINÚSCULAS; valores sempre como Buffer, como no BER. */
  attrs: Map<string, Buffer[]>;
}

export interface FakeLdapOptions {
  port?: number;
  baseDn?: string;
  usersOu?: string;
  groupsOu?: string;
  networkAccessGroupDn?: string;
  bindDn?: string;
  bindPassword?: string;
  log?: (msg: string) => void;
}

export interface FakeLdapHandle {
  port: number;
  /** `ldaps://127.0.0.1:<port>` */
  url: string;
  /**
   * Certificado PEM do próprio servidor. Autoassinado, então ele é sua
   * PRÓPRIA CA raiz — quem conectar passa isto como `tlsOptions.ca`, nunca
   * desligando a verificação de certificado.
   */
  caCert: string;
  baseDn: string;
  usersOu: string;
  groupsOu: string;
  networkAccessGroupDn: string;
  bindDn: string;
  bindPassword: string;
  /** Chave: DN normalizado (minúsculas, sem espaço depois da vírgula). */
  directory: Map<string, FakeLdapEntry>;
  stop(): Promise<void>;
}

export function startFakeLdapServer(options?: FakeLdapOptions): Promise<FakeLdapHandle>;
