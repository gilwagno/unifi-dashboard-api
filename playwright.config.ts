import { defineConfig, devices } from '@playwright/test';
import {
  BACKEND_PORT,
  BASE_URL,
  CONTROLLER_API_KEY,
  CONTROLLER_CLASSIC_SITE,
  CONTROLLER_PASSWORD,
  CONTROLLER_SITE_ID,
  CONTROLLER_USER,
  DASHBOARD_PASSWORD_HASH,
  DASHBOARD_USER,
  FAKE_CONTROLLER_PORT,
  FRONTEND_PORT,
} from './e2e/e2e.config';

/**
 * Testes e2e full-stack: frontend React real + backend Fastify real +
 * controller UniFi FAKE. O único componente simulado é o controller — login,
 * JWT, rotas e UI são todos os de produção.
 *
 * A configuração vive na RAIZ (e não em frontend/) porque a suíte é
 * cross-projeto: ela sobe os dois projetos e o fake, e precisa das env vars
 * do backend.
 *
 * `reuseExistingServer: false` é deliberado: a suíte nunca aproveita (nem
 * mata) um backend/frontend de desenvolvimento já rodando — as portas abaixo
 * são exclusivas dos testes.
 *
 * `workers: 1` porque os três webServers compartilham UM único controller
 * fake com estado em memória (SSIDs, clientes bloqueados, senha de SSH);
 * rodar specs em paralelo faria um teste enxergar a mutação do outro.
 */
export default defineConfig({
  testDir: './e2e/tests',
  fullyParallel: false,
  workers: 1,
  forbidOnly: !!process.env.CI,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list']],

  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    ...devices['Desktop Chrome'],
  },

  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],

  webServer: [
    {
      // Controller UniFi FAKE — precisa subir antes do backend fazer
      // qualquer chamada, e a ordem entre eles não é crítica.
      //
      // ATENÇÃO (revisão crítica): este comentário dizia "o backend não chama
      // nada no boot". Deixou de ser verdade em geral — `collectOnBoot()`
      // (src/server.ts) dispara uma coleta SNMP logo após o listen. Aqui isso
      // continua sendo um no-op porque `reset-printers-db.mjs` roda ANTES e
      // deixa o cadastro vazio: sem impressora cadastrada, o ciclo retorna sem
      // tocar a rede. Se algum dia a suíte passar a semear impressoras no
      // banco antes de subir o servidor, este boot passará a emitir UDP/161
      // para o IP que o controller fake reportar — semear pela UI (como os
      // specs fazem hoje) não tem esse efeito.
      command: 'node e2e/fake-controller/server.mjs',
      port: FAKE_CONTROLLER_PORT,
      reuseExistingServer: false,
      // Só stderr: o log do Fastify/Vite em stdout inunda a saída do
      // Playwright. Um erro de boot continua visível.
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 60_000,
      env: {
        FAKE_CONTROLLER_PORT: String(FAKE_CONTROLLER_PORT),
        FAKE_CONTROLLER_API_KEY: CONTROLLER_API_KEY,
        FAKE_CONTROLLER_SITE_ID: CONTROLLER_SITE_ID,
        FAKE_CONTROLLER_CLASSIC_SITE: CONTROLLER_CLASSIC_SITE,
        FAKE_CONTROLLER_USER: CONTROLLER_USER,
        FAKE_CONTROLLER_PASSWORD: CONTROLLER_PASSWORD,
      },
    },
    {
      // Backend Fastify REAL, apontado para o fake em 127.0.0.1. As env
      // vars passadas aqui vencem o .env do desenvolvedor (dotenv não
      // sobrescreve variáveis já presentes em process.env), garantindo que
      // nenhum teste toque um controller de verdade.
      // O reset roda ANTES do servidor abrir a conexão SQLite: o cadastro de
      // impressoras é o único estado e2e que sobrevive em disco entre runs, e
      // uma run interrompida no meio (falha/Ctrl+C/`--grep`) envenenaria todas
      // as seguintes. Ver e2e/reset-printers-db.mjs.
      command: 'node e2e/reset-printers-db.mjs && npx tsx src/server.ts',
      port: BACKEND_PORT,
      reuseExistingServer: false,
      // Só stderr: o log do Fastify/Vite em stdout inunda a saída do
      // Playwright. Um erro de boot continua visível.
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 120_000,
      env: {
        PORT: String(BACKEND_PORT),
        CONTROLLER_HOST: `127.0.0.1:${FAKE_CONTROLLER_PORT}`,
        UNIFI_API_KEY: CONTROLLER_API_KEY,
        SITE_ID: CONTROLLER_SITE_ID,
        UNIFI_ALLOW_SELF_SIGNED: 'true',
        UNIFI_CONTROLLER_USER: CONTROLLER_USER,
        UNIFI_CONTROLLER_PASSWORD: CONTROLLER_PASSWORD,
        UNIFI_CONTROLLER_SITE: CONTROLLER_CLASSIC_SITE,
        JWT_SECRET: 'segredo-de-teste-e2e-bem-longo-e-aleatorio',
        ADMIN_USER: DASHBOARD_USER,
        ADMIN_PASSWORD_HASH: DASHBOARD_PASSWORD_HASH,
        // Isola o cadastro de impressoras do e2e do banco real de
        // desenvolvimento (default './printers.db', que hoje guarda as 4
        // impressoras reais da fabrica) -- sem isso, os testes de
        // printers.spec.ts criariam e removeriam registros no arquivo de
        // producao local.
        PRINTERS_DB_FILE: './e2e/.printers-e2e.db',
        // Os fluxos disparam várias ações sensíveis em sequência; sem uma
        // folga aqui o rate limit de produção (10/min) derrubaria a suíte
        // por motivo alheio ao que está sendo testado.
        RATE_LIMIT_MAX: '10000',
        RATE_LIMIT_CLIENT_ACTION_MAX: '1000',
        RATE_LIMIT_DEVICE_RESTART_MAX: '1000',
      },
    },
    {
      // Frontend Vite REAL, com o proxy /api apontando para o backend acima.
      command: `npm run dev -- --port ${FRONTEND_PORT} --strictPort`,
      cwd: 'frontend',
      port: FRONTEND_PORT,
      reuseExistingServer: false,
      // Só stderr: o log do Fastify/Vite em stdout inunda a saída do
      // Playwright. Um erro de boot continua visível.
      stdout: 'ignore',
      stderr: 'pipe',
      timeout: 120_000,
      env: {
        VITE_API_PROXY_TARGET: `http://127.0.0.1:${BACKEND_PORT}`,
      },
    },
  ],
});
