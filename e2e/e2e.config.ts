/**
 * Configuração compartilhada pela stack e2e (playwright.config.ts + specs).
 *
 * Portas propositalmente diferentes das de desenvolvimento (backend 3000 /
 * frontend 5173): a suíte sobe a SUA PRÓPRIA stack e nunca reaproveita —
 * nem derruba — os processos de dev que o desenvolvedor esteja rodando.
 */

/** Controller UniFi FAKE (HTTPS, certificado autoassinado em memória). */
export const FAKE_CONTROLLER_PORT = 8443;

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
