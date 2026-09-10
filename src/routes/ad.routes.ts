import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import {
  createUser,
  deleteUser,
  getUser,
  grantNetworkAccess,
  resetPassword,
  revokeNetworkAccess,
  searchUsers,
  setUserEnabled,
  setUserWorkstations,
  unlockUser,
  updateUser,
} from '../services/ad.service.js';

// Rotas de usuários do Active Directory (Onda 3, escopo funcional — ver
// docs/ad-module-plan.md). Mesmo padrão do resto do projeto: hook de auth
// central, rate limit restrito (RATE_LIMIT_CLIENT_ACTION_MAX) em toda
// mutação, Zod para validar body/params. Os erros tipados do serviço
// (AdNotConfiguredError, AdUserNotFoundError, AdNetworkAccessGroupNotConfiguredError,
// AdRequestError) são mapeados pelo error handler central em src/app.ts —
// nenhum try/catch aqui, mesmo padrão de ClassicApiNotConfiguredError.
//
// Grupos e computadores (demais itens do escopo funcional do plano) ficam
// para subtarefas seguintes — este arquivo cobre só "Usuários" +
// "Ponte 802.1X", nesta ordem porque é a base que os outros dois dependem
// (nenhuma operação de grupo/computador precisa existir para usuário
// funcionar, o inverso não é verdade).

const usernameParam = z.object({
  username: z.string().trim().min(1, 'username é obrigatório'),
});

const searchQuery = z.object({
  query: z.string().trim().min(1).optional(),
});

const createUserBody = z.object({
  sAMAccountName: z.string().trim().min(1).max(20, 'sAMAccountName do AD tem limite de 20 caracteres'),
  displayName: z.string().trim().min(1),
  mail: z.string().trim().email().optional(),
  // Omitir gera uma senha aleatória — mesmo padrão de
  // POST /printers/:id/admin-password (printers.routes.ts): nem toda
  // chamada precisa que o operador escolha a senha na hora.
  password: z.string().min(8).max(255).optional(),
  mustChangePasswordAtNextLogon: z.boolean().optional(),
});

const updateUserBody = z
  .object({
    displayName: z.string().trim().min(1).optional(),
    mail: z.string().trim().email().optional(),
    department: z.string().trim().min(1).optional(),
    title: z.string().trim().min(1).optional(),
  })
  .refine((body) => Object.values(body).some((v) => v !== undefined), {
    message: 'Informe ao menos um campo para atualizar',
  });

const resetPasswordBody = z.object({
  password: z.string().min(8).max(255).optional(),
  mustChangePasswordAtNextLogon: z.boolean().optional(),
});

const workstationsBody = z.object({
  // Lista vazia remove a restrição (ver setUserWorkstations no serviço).
  workstations: z.array(z.string().trim().min(1)),
});

// Mesmo padrão de generatePrinterAdminPassword em printers.routes.ts: senha
// aleatória legível o bastante para ser digitada manualmente uma vez, sem
// caracteres ambíguos.
function generatePassword(): string {
  return randomBytes(18).toString('base64url');
}

export default async function adRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  const mutationConfig = { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } };

  app.get('/ad/users', async (request) => {
    const { query } = searchQuery.parse(request.query);
    const data = await searchUsers(query);
    return { data };
  });

  app.get('/ad/users/:username', async (request) => {
    const { username } = usernameParam.parse(request.params);
    return getUser(username);
  });

  app.post('/ad/users', mutationConfig, async (request, reply) => {
    const body = createUserBody.parse(request.body);
    const password = body.password ?? generatePassword();
    const user = await createUser({ ...body, password });
    // Mesma disciplina do segredo SNMP/senha admin da HP: a senha só
    // aparece UMA VEZ, na resposta de sucesso desta chamada — nunca em log,
    // nunca devolvida por GET /ad/users/:username depois.
    return reply.code(201).send({ ...user, password });
  });

  app.patch('/ad/users/:username', mutationConfig, async (request) => {
    const { username } = usernameParam.parse(request.params);
    const updates = updateUserBody.parse(request.body);
    return updateUser(username, updates);
  });

  app.delete('/ad/users/:username', mutationConfig, async (request, reply) => {
    const { username } = usernameParam.parse(request.params);
    await deleteUser(username);
    return reply.send({ ok: true });
  });

  app.post('/ad/users/:username/enable', mutationConfig, async (request, reply) => {
    const { username } = usernameParam.parse(request.params);
    await setUserEnabled(username, true);
    return reply.send({ ok: true });
  });

  app.post('/ad/users/:username/disable', mutationConfig, async (request, reply) => {
    const { username } = usernameParam.parse(request.params);
    await setUserEnabled(username, false);
    return reply.send({ ok: true });
  });

  app.post('/ad/users/:username/unlock', mutationConfig, async (request, reply) => {
    const { username } = usernameParam.parse(request.params);
    await unlockUser(username);
    return reply.send({ ok: true });
  });

  app.post('/ad/users/:username/reset-password', mutationConfig, async (request, reply) => {
    const { username } = usernameParam.parse(request.params);
    const body = resetPasswordBody.parse(request.body ?? {});
    const password = body.password ?? generatePassword();
    await resetPassword(username, password, body.mustChangePasswordAtNextLogon ?? true);
    // Mesma disciplina de POST /ad/users: única vez que a senha aparece.
    return reply.send({ ok: true, password });
  });

  app.patch('/ad/users/:username/workstations', mutationConfig, async (request, reply) => {
    const { username } = usernameParam.parse(request.params);
    const { workstations } = workstationsBody.parse(request.body);
    await setUserWorkstations(username, workstations);
    return reply.send({ ok: true });
  });

  // --- Ponte 802.1X ---
  app.post('/ad/users/:username/network-access', mutationConfig, async (request, reply) => {
    const { username } = usernameParam.parse(request.params);
    await grantNetworkAccess(username);
    return reply.send({ ok: true });
  });

  app.delete('/ad/users/:username/network-access', mutationConfig, async (request, reply) => {
    const { username } = usernameParam.parse(request.params);
    await revokeNetworkAccess(username);
    return reply.send({ ok: true });
  });
}
