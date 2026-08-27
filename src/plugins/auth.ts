import fjwt from '@fastify/jwt';
import fp from 'fastify-plugin';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env.js';

export default fp(async function authPlugin(app: FastifyInstance) {
  await app.register(fjwt, { secret: env.JWT_SECRET });

  app.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    } catch {
      reply.code(401).send({ error: 'Não autenticado' });
    }
  });
});
