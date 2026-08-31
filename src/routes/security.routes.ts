import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { auditLogService } from '../services/audit-log.service.js';
import { unifiClassicService } from '../services/unifi-classic.service.js';

const auditLogQuery = z.object({
  limit: z.coerce.number().int().positive().optional(),
});

// Rotas de segurança e auditoria (Prioridade 2) — a maioria depende da API
// clássica do controller (ver unifi-classic.service.ts). Sem
// UNIFI_CONTROLLER_USER/UNIFI_CONTROLLER_PASSWORD configurados, cada
// chamada lança ClassicApiNotConfiguredError, que o error handler central
// (src/app.ts) converte em 503 com mensagem explicando o que falta.
export default async function securityRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/security/summary', async () => unifiClassicService.getSecuritySummary());

  app.get('/security/events', async () => ({ data: await unifiClassicService.getCriticalEvents() }));

  app.get('/security/admins', async () => ({ data: await unifiClassicService.getAdmins() }));

  // Diferente das rotas acima (que auditam o controller UniFi), esta audita
  // o próprio dashboard — não depende da API clássica, sempre disponível.
  app.get('/security/audit-log', async (request) => {
    const { limit } = auditLogQuery.parse(request.query);
    const data = limit ? auditLogService.getHistory(limit) : auditLogService.getHistory();
    return { data };
  });
}
