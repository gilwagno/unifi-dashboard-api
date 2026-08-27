import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { env } from '../config/env.js';

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1),
});

export default async function authRoutes(app: FastifyInstance) {
  app.post('/auth/login', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'username e password são obrigatórios' });
    }

    const { username, password } = parsed.data;

    const validUser = username === env.ADMIN_USER;
    const validPassword = validUser && (await bcrypt.compare(password, env.ADMIN_PASSWORD_HASH));

    if (!validUser || !validPassword) {
      return reply.code(401).send({ error: 'Credenciais inválidas' });
    }

    const token = app.jwt.sign({ sub: username, type: 'access' }, { expiresIn: '12h' });
    const refreshToken = app.jwt.sign({ sub: username, type: 'refresh' }, { expiresIn: '30d' });
    return { token, refreshToken };
  });

  app.post('/auth/refresh', async (request, reply) => {
    const parsed = refreshSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'refreshToken é obrigatório' });
    }

    try {
      const payload = app.jwt.verify<{ sub: string; type?: 'access' | 'refresh' }>(
        parsed.data.refreshToken,
      );
      if (payload.type !== 'refresh') {
        return reply.code(401).send({ error: 'Token não é um refresh token' });
      }

      const token = app.jwt.sign({ sub: payload.sub, type: 'access' }, { expiresIn: '12h' });
      return { token };
    } catch {
      return reply.code(401).send({ error: 'Refresh token inválido ou expirado' });
    }
  });
}
