import Fastify, { type FastifyInstance, type FastifyError } from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { ZodError } from 'zod';
import { env } from './config/env.js';
import authPlugin from './plugins/auth.js';
import websocketPlugin from './plugins/websocket.js';
import authRoutes from './routes/auth.routes.js';
import bandwidthRoutes from './routes/bandwidth.routes.js';
import clientsRoutes from './routes/clients.routes.js';
import devicesRoutes from './routes/devices.routes.js';
import eventsRoutes from './routes/events.routes.js';
import healthRoutes from './routes/health.routes.js';
import networksRoutes from './routes/networks.routes.js';
import securityRoutes from './routes/security.routes.js';
import sitesRoutes from './routes/sites.routes.js';
import sshRoutes from './routes/ssh.routes.js';
import { UniFiApiError } from './services/unifi.service.js';
import { ClassicApiNotConfiguredError, UniFiClassicApiError } from './services/unifi-classic.service.js';

export async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: true });

  await app.register(cors, { origin: true });
  await app.register(rateLimit, { max: env.RATE_LIMIT_MAX, timeWindow: env.RATE_LIMIT_WINDOW });
  await app.register(authPlugin);
  await app.register(websocketPlugin);

  // Precisa ser registrado ANTES das rotas: cada app.register(rotaX) abaixo
  // cria um contexto encapsulado próprio, e o Fastify fixa nesse contexto o
  // error handler vigente no momento do registro. Se setErrorHandler viesse
  // depois, as rotas ficariam presas ao handler default do Fastify (erro de
  // validação do Zod virando 500 genérico em vez dos 400 esperados).
  app.setErrorHandler((error: FastifyError | UniFiApiError | UniFiClassicApiError, _request, reply) => {
    if (error instanceof UniFiApiError) {
      const status = error.status >= 400 && error.status < 600 ? error.status : 502;
      return reply.code(status).send({ error: 'Erro na API do UniFi', details: error.message });
    }

    if (error instanceof ClassicApiNotConfiguredError) {
      return reply.code(503).send({ error: 'Funcionalidade indisponível', details: error.message });
    }

    if (error instanceof UniFiClassicApiError) {
      const status = error.status >= 400 && error.status < 600 ? error.status : 502;
      return reply.code(status).send({ error: 'Erro na API clássica do UniFi', details: error.message });
    }

    if (error instanceof ZodError) {
      return reply.code(400).send({ error: 'Dados inválidos', details: error.flatten() });
    }

    app.log.error(error);

    // Erros de outros plugins do Fastify (ex: 429 do @fastify/rate-limit)
    // já vêm com o statusCode certo — respeita em vez de forçar tudo pra
    // 500. Só o 500 genérico esconde a mensagem, pra não vazar detalhes
    // internos.
    const status =
      typeof error.statusCode === 'number' && error.statusCode >= 400 && error.statusCode < 600
        ? error.statusCode
        : 500;

    if (status === 500) {
      return reply.code(500).send({ error: 'Erro interno' });
    }
    return reply.code(status).send({ error: error.message });
  });

  await app.register(authRoutes);
  await app.register(clientsRoutes);
  await app.register(devicesRoutes);
  await app.register(sitesRoutes);
  await app.register(eventsRoutes);
  await app.register(securityRoutes);
  await app.register(networksRoutes);
  await app.register(healthRoutes);
  await app.register(bandwidthRoutes);
  await app.register(sshRoutes);

  app.get('/health', async () => ({ status: 'ok' }));

  return app;
}
