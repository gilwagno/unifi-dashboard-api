import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { unifiService } from '../services/unifi.service.js';
import { paginate, paginationQuery } from '../validators/pagination.js';

const idParam = z.object({ id: z.string().min(1) });
const portParam = z.object({
  id: z.string().min(1),
  portIdx: z.coerce.number().int().positive(),
});
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
    { config: { rateLimit: { max: env.RATE_LIMIT_DEVICE_RESTART_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { siteId } = siteQuery.parse(request.query);
      await unifiService.restartDevice(id, siteId);
      return reply.send({ ok: true });
    },
  );

  app.get('/devices/:id', async (request) => {
    const { id } = idParam.parse(request.params);
    const { siteId } = siteQuery.parse(request.query);
    return unifiService.getDevice(id, siteId);
  });

  // Power-cycle de porta PoE. A UniFi Integration API não suporta
  // desabilitar porta — só power-cycle. Mesmo nível de disrupção que
  // reiniciar um device inteiro, então reusa o mesmo limite de rate.
  app.post(
    '/devices/:id/ports/:portIdx/power-cycle',
    { config: { rateLimit: { max: env.RATE_LIMIT_DEVICE_RESTART_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { id, portIdx } = portParam.parse(request.params);
      const { siteId } = siteQuery.parse(request.query);
      await unifiService.powerCyclePort(id, portIdx, siteId);
      return reply.send({ ok: true });
    },
  );
}
