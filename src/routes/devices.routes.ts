import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unifiService } from '../services/unifi.service.js';

const idParam = z.object({ id: z.string().min(1) });
const siteQuery = z.object({ siteId: z.string().min(1).optional() });

export default async function devicesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/devices', async (request) => {
    const { siteId } = siteQuery.parse(request.query);
    const { data } = await unifiService.listDevices(siteId);
    return { data };
  });

  app.post(
    '/devices/:id/restart',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { siteId } = siteQuery.parse(request.query);
      await unifiService.restartDevice(id, siteId);
      return reply.send({ ok: true });
    },
  );
}
