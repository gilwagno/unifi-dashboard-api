import type { FastifyInstance } from 'fastify';
import { unifiClassicService } from '../services/unifi-classic.service.js';

// Rotas de segurança e auditoria (Prioridade 2) — todas dependem da API
// clássica do controller (ver unifi-classic.service.ts). Sem
// UNIFI_CONTROLLER_USER/UNIFI_CONTROLLER_PASSWORD configurados, cada
// chamada lança ClassicApiNotConfiguredError, que o error handler central
// (src/app.ts) converte em 503 com mensagem explicando o que falta.
export default async function securityRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/security/summary', async () => unifiClassicService.getSecuritySummary());

  app.get('/security/events', async () => ({ data: await unifiClassicService.getCriticalEvents() }));

  app.get('/security/admins', async () => ({ data: await unifiClassicService.getAdmins() }));
}
