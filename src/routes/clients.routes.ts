import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { unifiService } from '../services/unifi.service.js';
import { macParamSchema } from '../validators/mac.js';
import { paginate, paginationQuery } from '../validators/pagination.js';

const siteQuery = z.object({ siteId: z.string().min(1).optional() });

const listClientsQuery = z
  .object({
    siteId: z.string().min(1).optional(),
    // z.coerce.boolean() trataria "false" como true (Boolean("false") é
    // truthy) — aceitamos só os literais esperados de uma query string.
    blocked: z
      .enum(['true', 'false'])
      .optional()
      .transform((v) => (v === undefined ? undefined : v === 'true')),
    type: z.enum(['WIRED', 'WIRELESS']).optional(),
  })
  .merge(paginationQuery);

export default async function clientsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/clients', async (request) => {
    const { siteId, blocked, type, page, pageSize } = listClientsQuery.parse(request.query);
    const { data } = await unifiService.listClients(siteId);

    const filtered = data.filter(
      (client) =>
        (blocked === undefined || client.blocked === blocked) &&
        (type === undefined || client.type === type),
    );

    return paginate(filtered, page, pageSize);
  });

  app.post(
    '/clients/:mac/block',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { mac } = macParamSchema.parse(request.params);
      const { siteId } = siteQuery.parse(request.query);
      await unifiService.blockClient(mac, siteId);
      return reply.send({ ok: true });
    },
  );

  app.post(
    '/clients/:mac/unblock',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { mac } = macParamSchema.parse(request.params);
      const { siteId } = siteQuery.parse(request.query);
      await unifiService.unblockClient(mac, siteId);
      return reply.send({ ok: true });
    },
  );
}
