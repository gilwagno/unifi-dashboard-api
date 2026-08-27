import type { FastifyInstance } from 'fastify';
import { unifiService } from '../services/unifi.service.js';

export default async function sitesRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/sites', async () => {
    const { data } = await unifiService.listSites();
    return { data };
  });
}
