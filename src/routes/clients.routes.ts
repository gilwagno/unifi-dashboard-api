import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { unifiService } from '../services/unifi.service.js';
import { unifiClassicService } from '../services/unifi-classic.service.js';
import { macParamSchema } from '../validators/mac.js';
import { paginate, paginationQuery } from '../validators/pagination.js';

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

    // A Integration API não expõe de forma confiável se um cliente está
    // bloqueado (esse campo só existe de verdade na API clássica, via
    // /rest/user). Quando a API clássica está configurada, cruza os MACs
    // bloqueados aqui; sem ela, `blocked` fica sempre false — limitação
    // documentada no README.
    let blockedMacs: Set<string> | null = null;
    if (unifiClassicService.isConfigured()) {
      blockedMacs = await unifiClassicService.getBlockedMacs();
    }
    const withBlockedStatus = blockedMacs
      ? data.map((client) => ({ ...client, blocked: blockedMacs.has(client.macAddress.toLowerCase()) }))
      : data;

    const filtered = withBlockedStatus.filter(
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
      await unifiClassicService.blockClient(mac);
      return reply.send({ ok: true });
    },
  );

  app.post(
    '/clients/:mac/unblock',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { mac } = macParamSchema.parse(request.params);
      await unifiClassicService.unblockClient(mac);
      return reply.send({ ok: true });
    },
  );
}
