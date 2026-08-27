import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { unifiEventsHub } from '../services/unifi-events.hub.js';

const historyQuery = z.object({
  limit: z.coerce.number().int().positive().optional(),
});

export default async function eventsRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/events/history', async (request) => {
    const { limit } = historyQuery.parse(request.query);
    const data = limit ? unifiEventsHub.getHistory(limit) : unifiEventsHub.getHistory();
    return { data };
  });
}
