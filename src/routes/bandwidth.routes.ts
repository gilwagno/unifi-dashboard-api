import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bandwidthHistoryService } from '../services/bandwidth-history.service.js';
import { macAddressSchema } from '../validators/mac.js';

// Rotas do histórico de uso de banda (Prioridade 3, parte 2). O buffer é
// alimentado por um poller que já roda em background desde que o processo
// subiu (ver bandwidth-history.service.ts) — essas rotas só leem o que já
// foi coletado, não disparam nenhuma chamada nova ao controller.
//
// `mac` aceita qualquer caixa (mesma normalização de printers.routes.ts):
// os dados persistidos vêm do controller já em minúsculas, então
// normalizamos o filtro para casar com o que está no banco.
const longRangeQuery = z.object({
  mac: macAddressSchema.transform((mac) => mac.toLowerCase()).optional(),
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

export default async function bandwidthRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/bandwidth/history', async () => ({ data: bandwidthHistoryService.getHistory() }));

  app.get('/bandwidth/history/summary', async () => ({
    data: bandwidthHistoryService.computeDelta(bandwidthHistoryService.getHistory()),
  }));

  // Histórico de longo prazo (além das 24h do buffer em memória) —
  // combina, de forma transparente para quem consome, o trecho recente
  // (bandwidth_samples, grão fino de 5 min, até 48h) com o trecho mais
  // antigo (bandwidth_hourly_rollup, grão de 1h, até 30 dias). Ver o
  // comentário de topo de getLongRange() em bandwidth-history.service.ts
  // para a decisão de formato de resposta (reaproveita BandwidthDelta, o
  // mesmo shape de /bandwidth/history/summary).
  app.get('/bandwidth/history/long-range', async (request) => {
    const query = longRangeQuery.parse(request.query);
    return { data: bandwidthHistoryService.getLongRange(query) };
  });
}
