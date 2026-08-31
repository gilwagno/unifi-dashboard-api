import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { macAddressSchema } from '../validators/mac.js';
import { unifiClassicService } from '../services/unifi-classic.service.js';
import {
  toPublic,
  type CreatePrinterInput,
  type SnmpSecretInput,
  type UpdatePrinterInput,
} from '../db/printers.db.js';
import { printersRepository } from '../db/printers.instance.js';
import { buildNetworkStatusResolver, withNetworkStatus } from '../services/printer-network-status.service.js';
// Import com efeito colateral: carregar o módulo do poller SNMP inicia o
// `setInterval` de coleta de consumíveis (mesmo padrão de
// bandwidth-history.service.ts, que sobe junto com bandwidth.routes.ts). O
// timer é unref()'d e não faz coleta imediata no boot, então isso não
// atrasa a subida do app nem segura o processo/os testes.
import '../services/printer-snmp.service.js';

// Cadastro (nome, MAC, segredo SNMP, política de manutenção) do módulo de
// manutenção de impressoras — primeira rota do projeto com persistência em
// disco (ver src/db/printers.db.ts). Esta subtarefa é só schema + CRUD:
// merge com status do UniFi, poller SNMP de verdade, etc. ficam para as
// subtarefas seguintes da Onda 2 (ver CLAUDE.md).
// Reexportado (a instância vive em src/db/printers.instance.ts) para os
// testes de integração conseguirem fechar a conexão antes de apagar o
// diretório temporário do banco (no Windows, apagar um arquivo com um
// handle SQLite ainda aberto falha com EPERM).
export { printersRepository };
// Reexportados daqui por compatibilidade — a implementação do merge com o
// status do UniFi mora em src/services/printer-network-status.service.ts
// desde a subtarefa 5 (ver o comentário de topo daquele arquivo).
export type {
  PrinterNetworkStatus,
  PrinterWithNetworkStatus,
} from '../services/printer-network-status.service.js';

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

  app.get('/printers', async () => {
    const printers = printersRepository.listAll().map(toPublic);
    const resolveNetwork = await buildNetworkStatusResolver(app.log);
    return printers.map((printer) => withNetworkStatus(printer, resolveNetwork));
  });

  app.get('/printers/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const record = printersRepository.getById(id);
    if (!record) {
      return reply.code(404).send({ error: 'Impressora não encontrada' });
    }
    const resolveNetwork = await buildNetworkStatusResolver(request.log);
    return withNetworkStatus(toPublic(record), resolveNetwork);
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

  // --- Reconectar impressora à rede (Onda 2, subtarefa 3) ---
  //
  // IMPORTANTE: isto NÃO é um reboot de hardware. Reaproveita exatamente o
  // mesmo par block-sta/unblock-sta já usado em POST /clients/:mac/block e
  // /unblock (ver clients.routes.ts e unifi-classic.service.ts) — o
  // controller desassocia o cliente da rede e, em seguida, permite a
  // reassociação, forçando o dispositivo a reconectar no Wi-Fi/rede
  // cabeada. A impressora física nunca é desligada por isso: a HP
  // (HPLaserMFP135w) nem tem PoE, liga direto na tomada — um "reconectar"
  // de rede não tem como derrubar a energia dela. Um reboot de verdade do
  // firmware da impressora é a subtarefa 9 (spike), ainda não implementada.
  app.post(
    '/printers/:id/reconnect',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const record = printersRepository.getById(id);
      if (!record) {
        return reply.code(404).send({ error: 'Impressora não encontrada' });
      }

      // Erros do serviço (UnknownClientError -> 404, ClassicApiNotConfiguredError
      // -> 503, qualquer outro UniFiClassicApiError) NÃO são capturados aqui —
      // propagam de propósito para o error handler central (src/app.ts), que já
      // sabe mapear cada um pro status certo (mesmo padrão de /clients/:mac/block).
      await unifiClassicService.blockClient(record.mac);

      // Se blockClient funcionou mas isto falhar, a impressora fica bloqueada
      // e presa sem rede — pior que o estado original antes do reconnect. Não
      // fazemos retry automático (fora de escopo), mas registramos um warn
      // explícito para não deixar esse estado intermediário silencioso: quem
      // for investigar um erro 5xx/502 aqui sabe que precisa checar (ou
      // chamar manualmente) POST /clients/:mac/unblock para essa impressora.
      try {
        await unifiClassicService.unblockClient(record.mac);
      } catch (error) {
        request.log.warn(
          { err: error, printerId: id, mac: record.mac },
          'unblockClient falhou após blockClient ter sido aplicado com sucesso — a impressora pode ter ' +
            'ficado bloqueada/sem rede. Considere chamar POST /clients/:mac/unblock manualmente para este MAC.',
        );
        throw error;
      }

      return reply.send({
        ok: true,
        note: 'Reconexão de rede (bloqueia e desbloqueia o cliente no controller) — não reinicia o equipamento.',
      });
    },
  );
}
