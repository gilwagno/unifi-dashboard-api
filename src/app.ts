import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import authPlugin from './plugins/auth.js';
import websocketPlugin from './plugins/websocket.js';
import authRoutes from './routes/auth.routes.js';
import clientsRoutes from './routes/clients.routes.js';
import devicesRoutes from './routes/devices.routes.js';
import sitesRoutes from './routes/sites.routes.js';
import { UniFiApiError } from './services/unifi.service.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: 100, timeWindow: '1 minute' });
  await app.register(authPlugin);
  await app.register(websocketPlugin);

  await app.register(authRoutes);
  await app.register(clientsRoutes);
  await app.register(devicesRoutes);
  await app.register(sitesRoutes);

  app.get('/health', async () => ({ status: 'ok' }));

  // Handler central: propaga o status real da API do UniFi (ex: 404 se o
  // MAC não existe) em vez de deixar tudo virar 500 genérico, e devolve os
  // detalhes de validação do Zod de forma legível.
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof UniFiApiError) {
      const status = error.status >= 400 && error.status < 600 ? error.status : 502;
      return reply.code(status).send({ error: 'Erro na API do UniFi', details: error.message });
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'Dados inválidos', details: error.flatten() });
    }

    app.log.error(error);
    return reply.code(500).send({ error: 'Erro interno' });
  });

  return app;
}
