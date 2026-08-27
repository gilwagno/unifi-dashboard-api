import type { FastifyInstance } from 'fastify';
import { unifiService } from '../services/unifi.service.js';
import { macParamSchema } from '../validators/mac.js';

export default async function clientsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/clients', async () => {
    const { data } = await unifiService.listClients();
    return { data };
  });

  app.post(
    '/clients/:mac/block',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { mac } = macParamSchema.parse(request.params);
      await unifiService.blockClient(mac);
      return reply.send({ ok: true });
    },
  );

  app.post(
    '/clients/:mac/unblock',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { mac } = macParamSchema.parse(request.params);
      await unifiService.unblockClient(mac);
      return reply.send({ ok: true });
    },
  );
}
