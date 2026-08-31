import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { unifiService } from '../services/unifi.service.js';
import { unifiClassicService } from '../services/unifi-classic.service.js';
import { macParamSchema } from '../validators/mac.js';
import { paginate, paginationQuery } from '../validators/pagination.js';

// Mesma regex de IPv4 usada em networks.routes.ts, pro campo `ip` do IP
// fixo por cliente.
const ipv4Regex =
  /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

// `ip` só é obrigatório quando enabled=true (pra desligar o IP fixo não
// precisa informar nenhum IP) — validado com superRefine em vez de um
// discriminatedUnion pra manter a mensagem de erro simples num só campo.
const fixedIpBody = z
  .object({
    enabled: z.boolean(),
    ip: z.string().regex(ipv4Regex, 'ip deve ser um IPv4 válido').optional(),
    networkId: z.string().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (value.enabled && !value.ip) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['ip'], message: 'ip é obrigatório quando enabled=true' });
    }
  });

// Apelido do cliente (campo `name` em /rest/user, ver unifi-classic.service.ts)
// — mesmo limite de tamanho usado pro `name` de outros cadastros do projeto
// (ex.: networks.routes.ts, printers.routes.ts).
const aliasBody = z.object({
  alias: z.string().trim().min(1, 'alias é obrigatório').max(128, 'alias deve ter no máximo 128 caracteres'),
});

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

  // IP fixo (reserva de DHCP) por cliente — só existe na API clássica
  // (ver unifi-classic.service.ts), a Integration API oficial não tem esse
  // conceito.
  app.patch(
    '/clients/:mac/fixed-ip',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { mac } = macParamSchema.parse(request.params);
      const { enabled, ip, networkId } = fixedIpBody.parse(request.body);
      await unifiClassicService.setClientFixedIp(mac, { enabled, ip, networkId });
      return reply.send({ ok: true });
    },
  );

  // Apelido ("Apelido") do cliente exibido no painel do UniFi — rota
  // genérica, reaproveitável em qualquer tela (não específica de
  // impressora). Não confundir com o hostname anunciado pelo próprio
  // dispositivo (não editável por aqui).
  app.patch(
    '/clients/:mac/alias',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { mac } = macParamSchema.parse(request.params);
      const { alias } = aliasBody.parse(request.body);
      await unifiClassicService.setClientAlias(mac, alias);
      return reply.send({ ok: true });
    },
  );
}
