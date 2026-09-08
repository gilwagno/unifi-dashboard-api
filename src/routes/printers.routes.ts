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
// Além do efeito colateral de iniciar o poller (setInterval unref()'d, sem
// coleta imediata no boot — mesmo padrão de bandwidth-history.service.ts,
// que sobe junto com bandwidth.routes.ts), este import também traz
// `getLastReading` e os tipos usados por GET /printers/:id/consumables
// (subtarefa 6) para formatar a última leitura SNMP bem-sucedida.
import { getLastReading, type PrinterSnmpReading, type PrinterSupply, type SnmpMeasurement } from '../services/printer-snmp.service.js';

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

// --- GET /printers/:id/consumables (Onda 2, subtarefa 6) ---
//
// Formata a última leitura SNMP bem-sucedida (printer-snmp.service.ts,
// subtarefa 5) para o consumo do frontend: nome do suprimento, percentual
// quando calculável, flag de baixo nível pelo threshold configurado, ou
// "não suportado"/"desconhecido" quando o sentinela indicar isso.

type ConsumableSupplyStatus = 'ok' | 'low' | 'unknown' | 'not-measured' | 'partial' | 'unsupported' | 'error';

interface ConsumableSupply {
  name: string;
  levelPercent: number | null;
  status: ConsumableSupplyStatus;
}

interface ConsumablesResponse {
  printerId: string;
  collectedAt: string | null;
  pageCount: number | null;
  // Threshold de "baixo" efetivamente em vigor nesta resposta, copiado do
  // registro (`maintenance.consumableLowThresholdPct`). `null` = não
  // configurado, e portanto NENHUM suprimento desta resposta pode ter vindo
  // como 'low' (ver a DECISÃO em resolveSupplyStatus). Sem este campo, um
  // toner em 1% chega ao frontend como `status: 'ok'` e é indistinguível de
  // um toner realmente cheio — o consumidor não teria como saber que a
  // checagem simplesmente não está ligada. Expor o threshold mantém a
  // decisão de não inventar um default (o backend continua sem política
  // própria) sem que "nunca alertar" vire um silêncio invisível num módulo
  // cujo objetivo é justamente alertar sobre manutenção.
  lowThresholdPct: number | null;
  supplies: ConsumableSupply[];
}

// DECISÃO — threshold de manutenção não configurado no registro
// (`maintenance.consumableLowThresholdPct`): sem um valor explícito, não há
// como o backend saber o que o dono do cadastro considera "baixo" para
// aquela impressora/suprimento — inventar um default (ex.: 10%) seria uma
// política de negócio que ninguém pediu, e poderia disparar alertas de
// "baixo" que o usuário não configurou para receber. Por isso: sem
// threshold configurado, o status NUNCA vira 'low' — um nível numericamente
// conhecido sempre mapeia para 'ok' nesse caso. Configurar o threshold (já
// suportado desde a subtarefa 1, via POST/PATCH /printers) é o que liga a
// checagem. Para que isso não vire um "nunca alerta" silencioso, a resposta
// carrega `lowThresholdPct` — o consumidor consegue distinguir "cheio" de
// "ninguém configurou o limite" sem o backend inventar política nenhuma.
function resolveSupplyStatus(supply: PrinterSupply, thresholdPct: number | null): ConsumableSupplyStatus {
  // Mapeamento de SnmpMeasurement.status (união discriminada da subtarefa 5)
  // para o status de resposta:
  //   'unknown'     -> 'unknown'      (RFC 3805: valor não pôde ser determinado)
  //   'partial'     -> 'partial'      (RFC 3805: ainda há suprimento, quantidade indeterminada)
  //   'unsupported' -> 'unsupported'  (OID não existe neste modelo)
  //   'error'       -> 'error'        (falha pontual na leitura deste campo)
  //   'other'       -> 'unknown'      (RFC 3805: "condição indeterminada/não-padrão" — não é
  //                                    um dos 2 status "conhecidos" (unsupported/error), então
  //                                    cai junto de 'unknown' em vez de ganhar um rótulo próprio
  //                                    que o frontend precisaria tratar separadamente sem nunca
  //                                    ter sido observado de verdade nas 3 impressoras reais)
  if (supply.level.status !== 'ok') {
    switch (supply.level.status) {
      case 'unknown':
        return 'unknown';
      case 'partial':
        return 'partial';
      case 'unsupported':
        return 'unsupported';
      case 'error':
        return 'error';
      case 'other':
        return 'unknown';
    }
  }

  // level.status === 'ok': há um número de verdade, mas `levelPercent` ainda
  // pode ser `null` (unidade incompatível, sem maxCapacity confiável, ou o
  // bug real da HP de level > maxCapacity — ver computeLevelPercent). Nesse
  // caso não dá pra afirmar "ok" nem "low" com segurança: 'not-measured'.
  if (supply.levelPercent === null) return 'not-measured';

  // Comparação estrita: 'low' é "ABAIXO do threshold". Um nível exatamente
  // igual ao limite configurado (ex.: 20% com threshold 20) ainda é 'ok' —
  // o limite é o piso aceitável, não o primeiro valor a alertar.
  if (thresholdPct !== null && supply.levelPercent < thresholdPct) return 'low';
  return 'ok';
}

function pageCountValue(pageCount: SnmpMeasurement): number | null {
  return pageCount.status === 'ok' ? pageCount.value : null;
}

function toConsumablesResponse(
  printerId: string,
  reading: PrinterSnmpReading | undefined,
  thresholdPct: number | null,
): ConsumablesResponse {
  if (!reading) {
    // Cadastrada, mas o poller ainda não coletou nada dela (recém-criada ou
    // sempre offline até agora) — estado válido, não um erro.
    return { printerId, collectedAt: null, pageCount: null, lowThresholdPct: thresholdPct, supplies: [] };
  }

  return {
    printerId,
    collectedAt: reading.collectedAt,
    // `pageCount` também é um SnmpMeasurement (subtarefa 5): o contador pode
    // vir com sentinela (-1/-2/-3) ou falha de leitura, e nesses casos vira
    // `null` — nunca NaN/undefined. `collectedAt` continua preenchido, então
    // "coletei, mas o contador não é legível" segue distinguível de "nunca
    // coletei" (que é collectedAt null + supplies vazio).
    pageCount: pageCountValue(reading.pageCount),
    lowThresholdPct: thresholdPct,
    supplies: reading.supplies.map((supply) => ({
      name: supply.description ?? supply.typeLabel ?? `Suprimento ${supply.index}`,
      levelPercent: supply.levelPercent,
      status: resolveSupplyStatus(supply, thresholdPct),
    })),
  };
}

// --- GET /printers/:id/diagnostics (Onda 2, subtarefa 7) ---
//
// Somente-leitura: modelo/firmware e erros ativos da última leitura SNMP
// bem-sucedida (printer-snmp.service.ts, subtarefa 5). Mesmo padrão de
// /consumables (subtarefa 6): "cadastrada mas nunca coletada" é resposta
// válida com campos vazios/nulos, não erro 404/500.

// Só os 5 rótulos da RFC 2790 (hrDeviceStatus, valores 1-5 — ver
// DEVICE_STATUS_LABELS em printer-snmp.service.ts) descrevem um status
// REPORTADO pela impressora. 'not-measured' é deste endpoint: cobre tanto
// "nunca coletado" quanto "o varbind veio com sentinela/erro/OID não
// suportado neste ciclo" — em nenhum desses casos dá pra afirmar
// running/warning/testing/down/unknown(RFC) com segurança.
type DiagnosticsDeviceStatus = 'unknown' | 'running' | 'warning' | 'testing' | 'down' | 'not-measured';

interface DiagnosticsResponse {
  printerId: string;
  collectedAt: string | null;
  // DECISÃO — mapeamento sysDescr vs deviceDescr (confirmado empiricamente
  // contra as 3 impressoras reais, ver docs/printers-snmp-research.md,
  // seção "Identificação real"): `hrDeviceDescr.1` é sempre um nome de
  // modelo limpo e curto ("HP Laser MFP 131 133 135-138", "Brother
  // HL-L2360D series"), por isso vira `model`. `sysDescr` TAMBÉM embute a
  // versão de firmware, mas em formato livre e diferente por fabricante (HP:
  // "...; V3.82.01.10 DEC-09-2019; Engine V1.00.11; ..."; Brother:
  // "...,Firmware Ver.Z ," ou "...,Firmware Ver.1.46 ,..."). Não existe um
  // separador estável entre fabricantes pra extrair só o número de versão
  // sem regras específicas por fabricante que ninguém pediu ainda — parsear
  // isso seria frágil e quebraria silenciosamente a cada modelo novo (ou
  // fabricante novo) que a rede real ganhar. Por isso devolvemos o texto
  // inteiro como `systemInfo`: quem consome (frontend/humano) já consegue
  // ler a versão de firmware dali, sem o backend fingir uma extração
  // confiável que não é.
  model: string | null;
  systemInfo: string | null;
  deviceStatus: DiagnosticsDeviceStatus;
  // Nomes já decodificados do bitmap hrPrinterDetectedErrorState (RFC 2790,
  // ver decodeErrorStateBitmap em printer-snmp.service.ts) — já são rótulos
  // amigáveis o bastante ('jammed', 'lowToner', 'doorOpen', ...); reaplicar
  // uma segunda tradução aqui só duplicaria a mesma tabela sem ganho real.
  // `null` = OID não suportado/falhou (não é o mesmo que "sem erro ativo",
  // que é lista vazia — a mesma distinção que o serviço já faz).
  activeErrors: string[] | null;
  // true quando a última leitura tinha ao menos um campo incompleto
  // (repassado de `PrinterSnmpReading.partial`) — o consumidor sabe que o
  // que veio é utilizável, mas não é a leitura inteira.
  partial: boolean;
}

// `deviceStatusLabel` chega do serviço como `string | null` (ele resolve
// DEVICE_STATUS_LABELS, um Record<number, string>, sem prometer o conjunto
// fechado desta união). Traduzir com um `as DiagnosticsDeviceStatus` seria
// uma promessa que o compilador não tem como cobrar: bastaria alguém
// acrescentar uma 6ª entrada em DEVICE_STATUS_LABELS (ou o serviço passar a
// devolver um rótulo de outra origem) para esta rota emitir, sem erro de
// tsc e sem teste falhando, um `deviceStatus` que não existe no contrato
// documentado acima. Por isso a tradução é uma tabela explícita: rótulo
// desconhecido degrada para 'not-measured' em vez de vazar para o
// frontend um valor que ele não sabe tratar.
const RFC_DEVICE_STATUS_BY_LABEL: Record<string, DiagnosticsDeviceStatus | undefined> = {
  unknown: 'unknown',
  running: 'running',
  warning: 'warning',
  testing: 'testing',
  down: 'down',
};

// `reading.deviceStatus` é um SnmpMeasurement (subtarefa 5): só quando
// `status === 'ok'` o valor numérico é confiável o bastante para virar um
// rótulo RFC 2790 (`deviceStatusLabel`, já resolvido pelo serviço). Em
// qualquer outro caso (sentinela, OID não suportado, falha pontual) não dá
// pra afirmar o status reportado pela impressora — cai em 'not-measured',
// nunca num rótulo inventado. A checagem do `status` é redundante com o
// serviço hoje (ele zera o rótulo quando a medida não é 'ok'), mas é ela que
// garante o invariante deste endpoint mesmo se as duas fontes divergirem —
// tem teste próprio ancorando isso.
function toDiagnosticsDeviceStatus(reading: PrinterSnmpReading): DiagnosticsDeviceStatus {
  if (reading.deviceStatus.status !== 'ok') return 'not-measured';
  // Valor fora de 1..5 no hrDeviceStatus (firmware fora da RFC 2790) chega
  // aqui como `deviceStatusLabel: null` — também 'not-measured'.
  if (reading.deviceStatusLabel === null) return 'not-measured';
  return RFC_DEVICE_STATUS_BY_LABEL[reading.deviceStatusLabel] ?? 'not-measured';
}

function toDiagnosticsResponse(printerId: string, reading: PrinterSnmpReading | undefined): DiagnosticsResponse {
  if (!reading) {
    // Cadastrada, mas o poller ainda não coletou nada dela (recém-criada ou
    // sempre offline até agora) — mesmo estado válido (não erro) de
    // /consumables.
    return {
      printerId,
      collectedAt: null,
      model: null,
      systemInfo: null,
      deviceStatus: 'not-measured',
      activeErrors: null,
      partial: false,
    };
  }

  return {
    printerId,
    collectedAt: reading.collectedAt,
    model: reading.deviceDescr,
    systemInfo: reading.sysDescr,
    deviceStatus: toDiagnosticsDeviceStatus(reading),
    activeErrors: reading.detectedErrorStates,
    partial: reading.partial,
  };
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

  app.get('/printers/:id/consumables', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const record = printersRepository.getById(id);
    if (!record) {
      return reply.code(404).send({ error: 'Impressora não encontrada' });
    }
    return toConsumablesResponse(id, getLastReading(id), record.maintenance.consumableLowThresholdPct);
  });

  app.get('/printers/:id/diagnostics', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const record = printersRepository.getById(id);
    if (!record) {
      return reply.code(404).send({ error: 'Impressora não encontrada' });
    }
    return toDiagnosticsResponse(id, getLastReading(id));
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
