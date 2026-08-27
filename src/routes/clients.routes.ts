import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unifiService } from '../services/unifi.service.js';
import { macParamSchema } from '../validators/mac.js';

const siteQuery = z.object({ siteId: z.string().min(1).optional() });

export default async function clientsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/clients', async (request) => {
    const { siteId } = siteQuery.parse(request.query);
    const { data } = await unifiService.listClients(siteId);
    return { data };
  });

  app.post(
    '/clients/:mac/block',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { mac } = macParamSchema.parse(request.params);
      const { siteId } = siteQuery.parse(request.query);
      await unifiService.blockClient(mac, siteId);
      return reply.send({ ok: true });
    },
  );

  app.post(
    '/clients/:mac/unblock',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { mac } = macParamSchema.parse(request.params);
      const { siteId } = siteQuery.parse(request.query);
      await unifiService.unblockClient(mac, siteId);
      return reply.send({ ok: true });
    },
  );
}
