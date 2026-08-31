import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { macAddressSchema } from '../validators/mac.js';
import {
  createPrintersRepository,
  toPublic,
  type CreatePrinterInput,
  type SnmpSecretInput,
  type UpdatePrinterInput,
} from '../db/printers.db.js';

// Cadastro (nome, MAC, segredo SNMP, política de manutenção) do módulo de
// manutenção de impressoras — primeira rota do projeto com persistência em
// disco (ver src/db/printers.db.ts). Esta subtarefa é só schema + CRUD:
// merge com status do UniFi, poller SNMP de verdade, etc. ficam para as
// subtarefas seguintes da Onda 2 (ver CLAUDE.md).
// Exportado só para os testes de integração conseguirem fechar a conexão
// antes de apagar o diretório temporário do banco (no Windows, apagar um
// arquivo com um handle SQLite ainda aberto falha com EPERM). Nenhuma rota
// deste arquivo usa o export — sempre usam a const local.
export const printersRepository = createPrintersRepository(env.PRINTERS_DB_FILE);

const idParam = z.object({ id: z.string().min(1) });

// O MAC é a chave de negócio da impressora (é por ele que a subtarefa 2 vai
// casar o cadastro com o status do UniFi). O controller devolve MACs sempre
// em minúsculas, e `macAddressSchema` aceita as duas caixas, então
// normalizamos aqui na entrada — senão `AA:BB:...` cadastrado pela UI nunca
// casaria com `aa:bb:...` vindo do controller, e passaria pelo teste de
// unicidade como se fosse outra impressora.
const printerMacSchema = macAddressSchema.transform((mac) => mac.toLowerCase());

// SNMPv3 aceita autenticação sem criptografia (só username), então todos os
// campos além de `username` são opcionais aqui — quem decide o que é
// obrigatório de fato é o dispositivo/poller, não esta camada de schema.
const v3AuthSchema = z.object({
  username: z.string().min(1),
  authProtocol: z.enum(['MD5', 'SHA']).optional(),
  authPassword: z.string().min(1).optional(),
  privProtocol: z.enum(['DES', 'AES']).optional(),
  privPassword: z.string().min(1).optional(),
});

// Validação condicional em vez de discriminatedUnion (mesmo motivo do
// createWifiBody em networks.routes.ts): mantém a mensagem de erro
// específica por campo via superRefine, e o PATCH reusa o mesmo shape com
// tudo opcional.
const snmpSchema = z
  .object({
    version: z.enum(['v1', 'v2c', 'v3']),
    community: z.string().min(1).optional(),
    v3Auth: v3AuthSchema.optional(),
  })
  .superRefine((snmp, ctx) => {
    if (snmp.version === 'v1' || snmp.version === 'v2c') {
      if (!snmp.community) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['community'],
          message: 'community é obrigatório quando snmp.version é "v1" ou "v2c"',
        });
      }
      if (snmp.v3Auth) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['v3Auth'],
          message: 'v3Auth só é válido com snmp.version "v3"',
        });
      }
    } else {
      if (!snmp.v3Auth) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['v3Auth'],
          message: 'v3Auth é obrigatório quando snmp.version é "v3"',
        });
      }
      if (snmp.community) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['community'],
          message: 'community só é válido com snmp.version "v1"/"v2c"',
        });
      }
    }
  });

const maintenanceSchema = z.object({
  intervalDays: z.number().int().positive().optional(),
  intervalPages: z.number().int().positive().optional(),
  consumableLowThresholdPct: z.number().min(0).max(100).optional(),
});

const createPrinterBody = z.object({
  name: z.string().min(1, 'Nome é obrigatório').max(64),
  mac: printerMacSchema,
  ipOverride: z.string().min(1).optional(),
  snmp: snmpSchema,
  maintenance: maintenanceSchema.optional(),
});

// No PATCH, `snmp` (quando informado) segue a mesma validação condicional
// do POST — só que o objeto inteiro é opcional (não dá pra trocar o
// segredo sem informar o `snmp` completo, pra evitar um PATCH parcial
// deixar a combinação version/segredo inconsistente).
const updatePrinterBody = z.object({
  name: z.string().min(1).max(64).optional(),
  mac: printerMacSchema.optional(),
  ipOverride: z.string().min(1).nullable().optional(),
  snmp: snmpSchema.optional(),
  maintenance: maintenanceSchema.optional(),
});

function toSnmpSecretInput(snmp: z.infer<typeof snmpSchema>): SnmpSecretInput {
  return snmp.version === 'v3' ? { v3Auth: snmp.v3Auth! } : { community: snmp.community! };
}

export default async function printersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // SEGURANÇA: nenhuma rota abaixo devolve o segredo SNMP (community
  // string ou credenciais SNMPv3) — nem em POST, GET (lista ou individual)
  // nem em PATCH. Ele é aceito na escrita e guardado em disco (ver
  // src/db/printers.db.ts), mas a leitura sempre passa por toPublic(),
  // que remove o campo antes de serializar. Mesmo espírito do
  // GET /ssh-credentials em ssh.routes.ts.

  app.post(
    '/printers',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const body = createPrinterBody.parse(request.body);

      if (printersRepository.findByMac(body.mac)) {
        return reply.code(409).send({ error: 'Já existe uma impressora cadastrada com este MAC' });
      }

      const input: CreatePrinterInput = {
        name: body.name,
        mac: body.mac,
        ipOverride: body.ipOverride ?? null,
        snmpVersion: body.snmp.version,
        snmpSecret: toSnmpSecretInput(body.snmp),
        maintenance: body.maintenance,
      };
      const record = printersRepository.create(input);
      return reply.code(201).send(toPublic(record));
    },
  );

  app.get('/printers', async () => printersRepository.listAll().map(toPublic));

  app.get('/printers/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const record = printersRepository.getById(id);
    if (!record) {
      return reply.code(404).send({ error: 'Impressora não encontrada' });
    }
    return toPublic(record);
  });

  app.patch(
    '/printers/:id',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = updatePrinterBody.parse(request.body);

      // Existência antes do conflito de MAC: um PATCH num id inexistente deve
      // dar 404 mesmo que o MAC enviado pertença a outra impressora.
      if (!printersRepository.getById(id)) {
        return reply.code(404).send({ error: 'Impressora não encontrada' });
      }

      // `exceptId` para que reenviar o MAC que o próprio registro já tem não
      // seja tratado como conflito.
      if (body.mac && printersRepository.findByMac(body.mac, id)) {
        return reply.code(409).send({ error: 'Já existe uma impressora cadastrada com este MAC' });
      }

      const patch: UpdatePrinterInput = {
        name: body.name,
        mac: body.mac,
        ipOverride: body.ipOverride,
        snmpVersion: body.snmp?.version,
        snmpSecret: body.snmp ? toSnmpSecretInput(body.snmp) : undefined,
        maintenance: body.maintenance,
      };

      const record = printersRepository.update(id, patch);
      if (!record) {
        return reply.code(404).send({ error: 'Impressora não encontrada' });
      }
      return toPublic(record);
    },
  );

  app.delete('/printers/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const deleted = printersRepository.delete(id);
    if (!deleted) {
      return reply.code(404).send({ error: 'Impressora não encontrada' });
    }
    return reply.send({ ok: true });
  });
}
