import type { FastifyInstance } from 'fastify';
import { bandwidthHistoryService } from '../services/bandwidth-history.service.js';

// Rotas do histórico de uso de banda (Prioridade 3, parte 2). O buffer é
// alimentado por um poller que já roda em background desde que o processo
// subiu (ver bandwidth-history.service.ts) — essas rotas só leem o que já
// foi coletado, não disparam nenhuma chamada nova ao controller.
export default async function bandwidthRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/bandwidth/history', async () => ({ data: bandwidthHistoryService.getHistory() }));

  app.get('/bandwidth/history/summary', async () => ({
    data: bandwidthHistoryService.computeDelta(bandwidthHistoryService.getHistory()),
  }));
}
