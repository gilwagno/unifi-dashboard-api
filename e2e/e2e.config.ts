/**
 * Configuração compartilhada pela stack e2e (playwright.config.ts + specs).
 *
 * Portas propositalmente diferentes das de desenvolvimento (backend 3000 /
 * frontend 5173): a suíte sobe a SUA PRÓPRIA stack e nunca reaproveita —
 * nem derruba — os processos de dev que o desenvolvedor esteja rodando.
 */

/** Controller UniFi FAKE (HTTPS, certificado autoassinado em memória). */
export const FAKE_CONTROLLER_PORT = 8443;

/**
 * Active Directory FAKE (LDAPS, certificado autoassinado em memória —
 * e2e/fake-ldap-server/server.mjs em modo standalone). Porta fixa, ao
 * contrário da suíte de integração (que usa porta 0), porque o backend
 * precisa da URL em env var ANTES de subir.
 */
export const FAKE_LDAP_PORT = 3636;

/** Onde o fake escreve o PEM da própria CA para o backend confiar nela. */
export const FAKE_LDAP_CA_FILE = './e2e/.fake-ldap-ca.pem';

export const FAKE_LDAP_BASE_DN = 'DC=fakeldap,DC=test';
export const FAKE_LDAP_BIND_DN = `CN=svc-dashboard,CN=Users,${FAKE_LDAP_BASE_DN}`;
export const FAKE_LDAP_BIND_PASSWORD = 'S3nha-Fake-Ldap-2026';
export const FAKE_LDAP_USERS_OU = `OU=Funcionarios,${FAKE_LDAP_BASE_DN}`;
export const FAKE_LDAP_GROUPS_OU = `OU=Grupos,${FAKE_LDAP_BASE_DN}`;
export const FAKE_LDAP_NETWORK_GROUP_DN = `CN=Rede-Permitida,CN=Users,${FAKE_LDAP_BASE_DN}`;

/** Backend Fastify real, apontado para o controller fake. */
export const BACKEND_PORT = 3100;

/** Frontend Vite real, com proxy /api -> backend acima. */
export const FRONTEND_PORT = 5273;

// `localhost` (e não 127.0.0.1) de propósito: no Windows o Vite escuta em
// ::1 por padrão, então navegar por 127.0.0.1 dá ERR_CONNECTION_REFUSED.
export const BASE_URL = `http://localhost:${FRONTEND_PORT}`;

/** Login DO DASHBOARD (ADMIN_USER / ADMIN_PASSWORD_HASH do backend). */
export const DASHBOARD_USER = 'admin';
export const DASHBOARD_PASSWORD = 'e2e-admin-password';
/** bcryptjs.hashSync(DASHBOARD_PASSWORD, 10) — só para os testes. */
export const DASHBOARD_PASSWORD_HASH = '$2a$10$rWNvCxTMyil937eTY2vUEOuunvuS9UsxK8SVYisFmNZkdbdJdPJkO';

/** Login do PAINEL do controller (API clássica) — validado pelo fake. */
export const CONTROLLER_USER = 'controller-admin';
export const CONTROLLER_PASSWORD = 'controller-password';

export const CONTROLLER_API_KEY = 'fake-api-key-e2e';
export const CONTROLLER_SITE_ID = '11111111-2222-3333-4444-555555555555';
export const CONTROLLER_CLASSIC_SITE = 'default';

/** Cliente semeado no fake que o fluxo de bloqueio/desbloqueio exercita. */
export const SEEDED_CLIENT = {
  name: 'Notebook Financeiro',
  mac: 'aa:bb:cc:dd:ee:01',
};

/**
 * Segundo cliente semeado, usado SÓ pelo fluxo de impressoras. É um cliente
 * separado de propósito: esse fluxo RENOMEIA o apelido no controller fake
 * (cujo estado é compartilhado por toda a run, workers: 1), e mexer no
 * `SEEDED_CLIENT` acoplaria clients.spec.ts à ordem de execução dos arquivos
 * — clients.spec.ts afirma o nome original do cliente dele.
 */
export const SEEDED_PRINTER_CLIENT = {
  name: 'Impressora Recepcao',
  mac: 'aa:bb:cc:dd:ee:02',
};

/**
 * Usuário semeado no fake-ldap-server que o fluxo de AD exercita. Separado
 * dos demais: o fluxo o DESABILITA e concede/revoga acesso à rede, e o
 * estado do diretório é compartilhado por toda a run (workers: 1).
 */
export const SEEDED_AD_USER = {
  sAMAccountName: 'jsilva',
  displayName: 'João Silva',
};

/** Grupo semeado COM aninhamento — é o que a tela precisa saber distinguir. */
export const SEEDED_AD_NESTED_GROUP = 'Acesso-Aninhado';

/** Computador semeado, habilitado. */
export const SEEDED_AD_COMPUTER = 'EA-PC-TESTE01';

/** Controlador de domínio semeado — a tela tem que marcá-lo. */
export const SEEDED_AD_DC = 'EA-SRV-FAKE01';
