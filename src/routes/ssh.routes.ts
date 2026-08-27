import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { unifiClassicService } from '../services/unifi-classic.service.js';

// Credencial de administração/SSH dos equipamentos (APs/switches) — depende
// da API clássica do controller (ver unifi-classic.service.ts). É uma
// configuração ÚNICA POR SITE, aplicada a TODOS os devices adotados de uma
// vez (não existe SSH por dispositivo separado no UniFi).
//
// SEGURANÇA: GET /ssh-credentials nunca expõe a senha atual (só
// sshUsername/sshEnabled/passwordAuthEnabled — ver SshInfo no service). A
// senha NOVA só aparece em texto puro na resposta de
// POST /ssh-credentials/rotate, uma única vez — é a única forma de quem
// trocou ficar sabendo a senha nova, e não há como recuperá-la depois por
// nenhuma outra rota.
const rotateBody = z.object({
  username: z.string().min(1).optional(),
  password: z.string().min(12).optional(),
});

export default async function sshRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  app.get('/ssh-credentials', async () => unifiClassicService.getSshInfo());

  // Ação sensível e pouco frequente (troca a senha de TODOS os APs/switches
  // adotados do site de uma vez) — mesmo limite de rate usado pra outras
  // ações de credencial/config (ex: PATCH /wifi/:id/password).
  app.post(
    '/ssh-credentials/rotate',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request) => {
      const { username, password } = rotateBody.parse(request.body ?? {});
      // Única rota de todo o módulo onde a senha aparece em texto puro na
      // resposta — não logue este resultado em nenhum log da aplicação.
      return unifiClassicService.rotateSshCredentials({ username, password });
    },
  );
}
