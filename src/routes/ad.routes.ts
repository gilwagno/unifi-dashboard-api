import { randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import {
  AdPasswordAmbiguousError,
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
  sAMAccountName: z
    .string()
    .trim()
    .min(1)
    .max(20, 'sAMAccountName do AD tem limite de 20 caracteres')
    // Conjunto de caracteres que o PROPRIO AD recusa em sAMAccountName
    // (virgula, barras, : ; | = + * ? < > " [ ] e caracteres de controle).
    // Barrar aqui e defesa em profundidade sobre o escape de DN do servico:
    // o CN do DN novo vem deste valor, e depender so de a biblioteca escapar
    // certo (ou de o DC recusar depois) deixa a unica barreira fora do nosso
    // codigo. ACHADO da 2a revisao critica.
    .regex(
      /^[^,\\\/:;|=+*?<>\"\[\]\u0000-\u001f]+$/,
      'sAMAccountName contem caractere nao permitido pelo Active Directory',
    ),
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
    let user;
    try {
      user = await createUser({ ...body, password });
    } catch (error) {
      // ACHADO GRAVE da revisão crítica (mesmo precedente de
      // PrinterSwsPasswordVerificationError em printers.routes.ts): o `add`
      // do objeto JÁ ACONTECEU e o `modify` que grava a senha pode ou não
      // ter aplicado antes de falhar. Sem este ramo, uma chamada SEM
      // `password` no corpo (senha gerada aqui por `randomBytes`) perderia
      // pra sempre a única cópia da senha que o AD PODE ter passado a
      // exigir — ela não pode ir pro log (regra do projeto) e morreria no
      // 502 genérico do error handler central. Devolver o valor tentado não
      // cria exposição nova: o caminho de sucesso já devolve a senha em
      // claro pro mesmo chamador autenticado, pelo mesmo canal.
      if (error instanceof AdPasswordAmbiguousError) {
        request.log.error(
          { sAMAccountName: body.sAMAccountName },
          'CRIAÇÃO DE USUÁRIO AD EM ESTADO AMBÍGUO — a conta foi criada (desabilitada) mas não foi possível ' +
            'confirmar se a senha/habilitação aplicaram. A senha tentada foi devolvida em texto puro APENAS no ' +
            'corpo desta resposta HTTP.',
        );
        return reply.code(502).send({
          error: 'Não foi possível confirmar a criação do usuário',
          details: error.message,
          // Única cópia da senha tentada que sai do processo.
          attemptedSAMAccountName: body.sAMAccountName,
          attemptedPassword: error.attemptedPassword,
          // `null` quando nem o proprio servico sabe (a escrita falhou sem
          // confirmar) — nunca afirmar `false` num caso em que o `modify`
          // pode ter aplicado; `true` quando o que falhou foi so a releitura
          // posterior. Ver AdPasswordAmbiguousError.accountEnabled (achado da
          // 2a revisao critica).
          accountEnabled: error.accountEnabled,
        });
      }
      throw error;
    }
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
    try {
      await resetPassword(username, password, body.mustChangePasswordAtNextLogon ?? true);
    } catch (error) {
      // Mesmo raciocínio do POST /ad/users acima — aqui é ainda mais grave:
      // a senha do usuário pode JÁ TER MUDADO no AD, e sem este ramo o
      // operador ficaria sem a única cópia do valor novo.
      if (error instanceof AdPasswordAmbiguousError) {
        request.log.error(
          { username },
          'RESET DE SENHA AD EM ESTADO AMBÍGUO — a escrita já havia sido despachada e não foi possível confirmar ' +
            'o resultado. A senha tentada foi devolvida em texto puro APENAS no corpo desta resposta HTTP.',
        );
        return reply.code(502).send({
          error: 'Não foi possível confirmar a troca de senha',
          details: error.message,
          attemptedPassword: error.attemptedPassword,
        });
      }
      throw error;
    }
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
