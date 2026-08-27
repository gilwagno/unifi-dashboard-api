import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unifiService } from '../services/unifi.service.js';
import { paginate, paginationQuery } from '../validators/pagination.js';

const idParam = z.object({ id: z.string().min(1) });
const siteQuery = z.object({ siteId: z.string().min(1).optional() });
const listDevicesQuery = siteQuery.merge(paginationQuery);

export default async function devicesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/devices', async (request) => {
    const { siteId, page, pageSize } = listDevicesQuery.parse(request.query);
    const { data } = await unifiService.listDevices(siteId);
    return paginate(data, page, pageSize);
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
