import type { FastifyInstance } from 'fastify';
import { unifiClassicService } from '../services/unifi-classic.service.js';

// Rotas de saúde operacional (Prioridade 3, parte 1) — todas dependem da API
// clássica do controller (ver unifi-classic.service.ts). Sem
// UNIFI_CONTROLLER_USER/UNIFI_CONTROLLER_PASSWORD configurados, cada
// chamada lança ClassicApiNotConfiguredError, que o error handler central
// (src/app.ts) converte em 503 com mensagem explicando o que falta.
//
// Prefixo /health/* não conflita com o health-check simples do próprio
// Fastify (GET /health, registrado direto em src/app.ts, sem autenticação) —
// são paths distintos.
export default async function healthRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/health/devices', async () => ({ data: await unifiClassicService.getDeviceHealth() }));

  app.get('/health/clients-signal', async () => ({ data: await unifiClassicService.getClientSignalStrength() }));

  app.get('/health/wan-uptime', async () => ({ data: await unifiClassicService.getWanUptimeHistory() }));
}
