import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { macAddressSchema } from '../validators/mac.js';
import { unifiClassicService } from '../services/unifi-classic.service.js';
import {
  parseWbmCredentials,
  toPublic,
  type CreatePrinterInput,
  type CreateMaintenanceEventInput,
  type PrinterMaintenancePolicy,
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
// `pageCountValue` (subtarefa 12) é a MESMA função usada por
// printer-snmp.service.ts para gravar o histórico — reaproveitada aqui em
// vez de duplicada, para que /consumables e /history nunca divirjam em como
// interpretam um SnmpMeasurement de contador de páginas.
import {
  getLastReading,
  pageCountValue,
  parseSupplyDescription,
  supplyDisplayName,
  type PrinterSnmpReading,
  type PrinterSupply,
} from '../services/printer-snmp.service.js';
// Automação de Sleep Time / Auto Power Off da WBM Brother (spike da
// subtarefa 9 — ver o comentário de topo do serviço para o porquê disto ser
// ESPECÍFICO da família Brother, sem checagem de fabricante no cadastro).
import {
  setAutoPowerOff,
  setSleepTime,
  PrinterUnreachableError,
  PrinterWbmRequestError,
  AUTO_POWER_OFF_HOURS_TO_INDEX,
  type AutoPowerOffHours,
} from '../services/printer-brother-wbm.service.js';
// Reboot remoto via SWS da HP (painel web autenticado) — ESPECÍFICO da
// família HP, ver o comentário de topo do serviço. Nada disto é compartilhado
// com a automação Brother acima: são fabricantes, protocolos e classes de
// erro diferentes.
import {
  rebootHpPrinter,
  changeHpAdminPassword,
  PrinterSwsAuthenticationError,
  PrinterSwsRequestError,
  PrinterSwsUnreachableError,
  PrinterSwsPasswordVerificationError,
} from '../services/printer-hp-sws.service.js';
import { randomBytes } from 'node:crypto';
import type { WbmCredentials } from '../db/printers.db.js';

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

// Caractere de CONTROLE nunca é credencial legítima aqui, e a razão é de
// protocolo, não higiene genérica: o login da SWS cifra literalmente
// "usuário" + CR + "senha" (o CR é o SEPARADOR — ver buildLoginAuthentication em
// printer-hp-sws.service.ts). Um CR dentro do usuário ou da senha faz o
// dispositivo cortar o valor no meio, e a credencial guardada aqui deixa de
// abrir o painel (nem /reboot, nem a troca de senha). ACHADO DO CRÍTICO
// (2026-09-10): recusar na ESCRITA do cadastro, e não só no corpo de
// POST /printers/:id/admin-password, porque essa rota cai no usuário JÁ
// GRAVADO quando o corpo não traz "username" — validar só a entrada da rota
// deixaria o mesmo furo aberto por outro caminho.
const noControlChars = (value: string) => !/[\u0000-\u001f\u007f]/.test(value);

// Credencial de admin do PAINEL WEB (WBM/SWS) — aceita na escrita, NUNCA
// devolvida em leitura (toPublic remove). Não confundir com o segredo SNMP
// acima: o SNMP só lê contadores, esta credencial administra o firmware.
const wbmCredentialsSchema = z.object({
  username: z.string().min(1).max(64).refine(noControlChars, 'Usuário não pode conter caractere de controle'),
  // `min(0)` implícito de propósito: a HP real do Financeiro está com a senha
  // de fábrica EM BRANCO (ver docs/printers-snmp-research.md). Exigir
  // `min(1)` aqui impediria de cadastrar exatamente a impressora que motivou
  // esta feature. O teto de 128 é só sanidade de tamanho.
  password: z.string().max(128).refine(noControlChars, 'Senha não pode conter caractere de controle'),
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
  wbmCredentials: wbmCredentialsSchema.optional(),
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
  // `.nullable()`: omitir mantém a credencial atual, `null` explícito a
  // APAGA (ver UpdatePrinterInput em printers.db.ts). Como a credencial nunca
  // é devolvida em leitura, sem o `null` não haveria como desconfigurá-la
  // depois de cadastrada.
  wbmCredentials: wbmCredentialsSchema.nullable().optional(),
  maintenance: maintenanceSchema.optional(),
});

function toSnmpSecretInput(snmp: z.infer<typeof snmpSchema>): SnmpSecretInput {
  return snmp.version === 'v3' ? { v3Auth: snmp.v3Auth! } : { community: snmp.community! };
}

// --- POST /printers/:id/sleep-time e /auto-power-off (spike, subtarefa 9) ---
//
// Automação da WBM Brother (ver src/services/printer-brother-wbm.service.ts
// para o porquê de ser específica dessa família). O corpo de
// /auto-power-off aceita `hours` (0/1/2/4/8) em vez do índice ordinal cru
// do select B204 — quem chama a API não precisa decorar que "4 horas" é o
// índice 3, não o índice 4 (ver AUTO_POWER_OFF_HOURS_TO_INDEX).

const sleepTimeBody = z.object({
  // Inteiro positivo, teto de 99 minutos: a Brother real mostrou "1" minuto
  // configurado, mas não há confirmação do limite máximo aceito pelo
  // firmware — 99 é só um teto razoável para não mandar um valor absurdo
  // (ex.: 99999) sem que isso implique que o firmware aceite qualquer coisa
  // até 99. O firmware pode rejeitar valores dentro dessa faixa também
  // (ex.: um modelo com teto real de 30 minutos); nesse caso a WBM devolve
  // um status não-2xx e a rota propaga como PrinterWbmRequestError (502).
  minutes: z.number().int().positive().max(99),
});

// Só os 5 valores confirmados ao vivo contra a Brother HL-L2360D real (ver
// docs/printers-snmp-research.md) — qualquer outro número é rejeitado ANTES
// de qualquer chamada de rede à impressora.
const autoPowerOffBody = z.object({
  hours: z.union([z.literal(0), z.literal(1), z.literal(2), z.literal(4), z.literal(8)]),
});

// Origem do IP usado como destino da ESCRITA na WBM. Diferente do poller
// SNMP (que só lê), aqui a origem importa para quem chama:
//   - 'override': `ipOverride` do cadastro — declarado por um operador,
//     estável, a fonte mais confiável.
//   - 'integration': Integration API do UniFi — lista só clientes
//     CONECTADOS AGORA, então é o IP ao vivo.
//   - 'classic': fallback pela API clássica (`/rest/user`), que devolve
//     `last_ip` — o ÚLTIMO IP conhecido, HISTÓRICO (ver o comentário de
//     `ClassicClient` em unifi-classic.service.ts e a nota no CLAUDE.md
//     sobre 172.16.0.85 já ter sido de um iPhone/Watch/Redmi antes de ser
//     de uma impressora).
export type PrinterIpOrigin = 'override' | 'integration' | 'classic';

// Resolve o IP da impressora com EXATAMENTE o mesmo critério do poller SNMP
// (printer-snmp.service.ts, `collectAllReadings`): `ipOverride` do cadastro
// tem precedência; senão usa o merge de status de rede da subtarefa 2/5. A
// diferença é que aqui a ORIGEM é devolvida junto — ver handleWbmAction.
async function resolvePrinterIp(
  record: { mac: string; ipOverride: string | null },
  log: { warn: (obj: unknown, msg: string) => void },
): Promise<{ ipAddress: string; origin: PrinterIpOrigin } | null> {
  if (record.ipOverride) return { ipAddress: record.ipOverride, origin: 'override' };

  const resolveNetwork = await buildNetworkStatusResolver(log);
  const status = resolveNetwork(record.mac);
  if (!status.ipAddress) return null;

  // `source: 'unknown'` nunca vem com ipAddress preenchido (ver
  // UNKNOWN_NETWORK_STATUS), então só 'integration'/'classic' chegam aqui.
  return { ipAddress: status.ipAddress, origin: status.source === 'integration' ? 'integration' : 'classic' };
}

// DECISÃO — códigos HTTP das rotas de automação Brother:
//   - sem IP conhecido (nem ipOverride, nem visto pelo controller): 409
//     Conflict. NÃO é 502/504: nenhuma requisição de rede foi tentada, não
//     houve upstream nenhum para falhar. É um conflito com o estado atual do
//     próprio recurso (o cadastro não tem como ser endereçado agora), e a
//     ação corretiva é do lado do cliente/operador — configurar `ipOverride`
//     via PATCH /printers/:id, ou esperar a impressora aparecer no
//     controller. Um cliente de API que trata 5xx como "erro transitório,
//     tenta de novo" ficaria em retry eterno num estado que retry nunca
//     resolve; 4xx comunica corretamente "não tente de novo sem mudar algo".
//   - PrinterUnreachableError (timeout/rede): 504 Gateway Timeout — a
//     requisição HTTP à WBM não completou dentro do prazo/não foi possível
//     estabelecer conexão, semântica mais específica que um 502 genérico.
//   - PrinterWbmRequestError (a WBM respondeu, mas com status != 2xx): 502
//     Bad Gateway — recebemos uma resposta do "upstream" (a impressora),
//     mas ela sinalizou erro; não sabemos o motivo exato (corpo é HTML, não
//     JSON estruturado), só que a WBM rejeitou a requisição. É também o que
//     acontece ao chamar estas rotas contra uma impressora NÃO-Brother:
//     verificado ao vivo nesta revisão — a HP real (172.16.0.89) devolve 404
//     em /general/sleep.html e /general/powerdown.html, enquanto a Brother
//     (172.16.0.222) devolve 200. Ou seja, o "erro em vez de sucesso
//     enganoso" prometido no comentário do serviço é fato medido, não
//     suposição.
//
// Estes dois erros NÃO vão para o error handler central de src/app.ts (ao
// contrário de /reconnect, que propaga UniFiClassicApiError de propósito):
// lá ficam só os erros TRANSVERSAIS, compartilhados por muitas rotas (APIs
// do UniFi, Zod, rate limit). PrinterUnreachableError/PrinterWbmRequestError
// existem exclusivamente nestas duas rotas — registrá-los no handler global
// faria o app.ts importar um serviço específico da família Brother e
// acumular conhecimento por-feature. O mapeamento local vive num único
// helper compartilhado pelas duas rotas, então não há duplicação. Qualquer
// erro inesperado (nem um nem outro) segue propagando para o handler central
// (500 genérico), de propósito.
async function handleWbmAction(
  reply: FastifyReply,
  target: { ipAddress: string; origin: PrinterIpOrigin } | null,
  printerId: string,
  log: { warn: (obj: unknown, msg: string) => void },
  action: (ip: string) => Promise<void>,
) {
  if (!target) {
    return reply.code(409).send({
      error: 'IP da impressora desconhecido',
      details: `Impressora ${printerId} não tem ipOverride configurado e não foi encontrada pelo controller UniFi.`,
    });
  }

  // ESCRITA sem autenticação num IP possivelmente HISTÓRICO: a WBM da
  // Brother aceita estes POSTs sem login e sem qualquer identificação do
  // aparelho, então não há como o serviço confirmar que o dispositivo do
  // outro lado é a impressora deste cadastro. Com origin 'classic' o IP vem
  // de `last_ip` (histórico) e a rede tem 3 Brothers em DHCP: um IP
  // reciclado pode fazer o POST cair em OUTRA Brother, que aceita e responde
  // 200 — mudaríamos o Sleep Time da impressora errada relatando sucesso.
  // Não bloqueamos (isso inutilizaria a feature para as impressoras em DHCP,
  // que são justamente as Brother — ver achado 1 do CLAUDE.md: só uma delas
  // aparece na Integration API), mas o risco deixa de ser invisível: warn no
  // log e o alvo real da escrita (`ipAddress`/`ipOrigin`) volta na resposta,
  // para o operador/UI conferir. Para escrita, o recomendado é `ipOverride`.
  if (target.origin === 'classic') {
    log.warn(
      { printerId, ipAddress: target.ipAddress, ipOrigin: target.origin },
      'Escrita na WBM usando IP HISTÓRICO da API clássica (last_ip) — não há garantia de que este IP ' +
        'ainda pertence a esta impressora. Configure ipOverride no cadastro para escritas confiáveis.',
    );
  }

  try {
    await action(target.ipAddress);
  } catch (error) {
    if (error instanceof PrinterUnreachableError) {
      return reply.code(504).send({ error: 'Impressora não respondeu', details: error.message });
    }
    if (error instanceof PrinterWbmRequestError) {
      return reply.code(502).send({ error: 'WBM da impressora recusou a requisição', details: error.message });
    }
    throw error;
  }

  return reply.send({ ok: true, ipAddress: target.ipAddress, ipOrigin: target.origin });
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
  // Número de série do cartucho (subtarefa 19), extraído de
  // prtMarkerSuppliesDescription quando a impressora o embute (achado real:
  // as 2 HPs da rede seguem o padrão "<nome> S/N:<serial>"; as 3 Brother
  // reais não têm esse sufixo, então fica `null` para elas — não é ausência
  // de coleta, é a impressora simplesmente não reportar serial por
  // suprimento). Ver `parseSupplyDescription` em printer-snmp.service.ts.
  serialNumber: string | null;
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
      // Reaproveita a MESMA função que o histórico SNMP usa (subtarefa 19)
      // — antes desta subtarefa, cada lugar tinha sua própria cópia do
      // fallback description ?? typeLabel ?? "Suprimento <index>"; agora
      // compartilhada, para que /consumables e /history nunca divirjam em
      // como nomeiam um suprimento (mesmo motivo de pageCountValue já ser
      // compartilhada entre os dois).
      name: supplyDisplayName(supply),
      serialNumber: supply.serialNumber,
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
  // prtMarkerPowerOnCount (subtarefa 19, OID padrão RFC 3805, nunca lido
  // pelo poller antes desta subtarefa) — mesma regra de pageCountValue:
  // sentinela/OID não suportado/erro pontual viram `null`, nunca um número
  // inventado.
  powerOnCount: number | null;
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
      powerOnCount: null,
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
    // Mesma função usada por pageCount em /consumables — reaproveitada aqui
    // (subtarefa 19) porque powerOnCount é o mesmo tipo de dado (um
    // SnmpMeasurement escalar que pode vir com sentinela/erro).
    powerOnCount: pageCountValue(reading.powerOnCount),
  };
}

// --- POST/GET /printers/:id/maintenance (Onda 2, subtarefa 8) ---
//
// Histórico de manutenções REALIZADAS (registro manual) + cálculo de
// 'próxima manutenção devida' a partir da política já existente no cadastro
// (maintenance.intervalDays/intervalPages, subtarefa 1) combinada com o
// último evento do histórico. Ver src/db/printers.db.ts para o schema da
// tabela nova (printer_maintenance_events).

const createMaintenanceEventBody = z.object({
  // offset: true aceita qualquer deslocamento de fuso (não só 'Z') — quem
  // registra a manutenção pode estar em outro fuso; o valor é guardado
  // exatamente como recebido (ISO 8601), sem normalização para UTC.
  performedAt: z.string().datetime({ offset: true }).optional(),
  note: z.string().min(1).max(500).optional(),
  // `nonnegative`, não `positive`: 0 é um contador de páginas legítimo
  // (impressora nova cadastrada junto com a manutenção de instalação, ou
  // contador zerado após troca de placa). Rejeitar 0 forçaria quem registra a
  // manutenção a omitir o campo — e omitir é semanticamente diferente
  // (`duePages` fica null, o alerta por páginas desliga), então o 400 aqui
  // trocaria silenciosamente "zerado" por "desconhecido".
  pageCountAtMaintenance: z.number().int().nonnegative().optional(),
});

interface MaintenanceNext {
  dueAt: string | null;
  duePages: number | null;
  currentPageCount: number | null;
  dateOverdue: boolean;
  pagesOverdue: boolean;
}

interface MaintenanceResponse {
  printerId: string;
  policy: Pick<PrinterMaintenancePolicy, 'intervalDays' | 'intervalPages'>;
  events: ReturnType<typeof printersRepository.listMaintenanceEvents>;
  next: MaintenanceNext;
}

// DECISÃO — sem nenhum evento de manutenção registrado ainda, 'next.dueAt' e
// 'next.duePages' ficam null mesmo que a política esteja configurada: não há
// uma manutenção anterior da qual contar o próximo intervalo, e inventar uma
// baseline (ex.: createdAt do cadastro) assumiria que a impressora nunca
// recebeu manutenção antes de ser cadastrada no sistema, o que não é
// necessariamente verdade. 'dateOverdue'/'pagesOverdue' seguem false nesse
// caso — não há como estar atrasado de algo que nunca foi definido.
function computeNextMaintenance(
  policy: PrinterMaintenancePolicy,
  events: ReturnType<typeof printersRepository.listMaintenanceEvents>,
  currentPageCount: number | null,
): MaintenanceNext {
  // events já vem ordenado por performed_at DESC (listMaintenanceEvents) —
  // o índice 0 é sempre o evento mais recente.
  const lastEvent = events[0];

  let dueAt: string | null = null;
  if (lastEvent && policy.intervalDays !== null) {
    const dueMs = new Date(lastEvent.performedAt).getTime() + policy.intervalDays * 24 * 60 * 60 * 1000;
    dueAt = new Date(dueMs).toISOString();
  }

  // duePages exige tanto a política quanto o último evento SABER quantas
  // páginas a impressora tinha na hora da manutenção — sem
  // pageCountAtMaintenance informado naquele evento não há base pra somar o
  // intervalo, mesmo que a política esteja configurada.
  let duePages: number | null = null;
  if (lastEvent && policy.intervalPages !== null && lastEvent.pageCountAtMaintenance !== null) {
    duePages = lastEvent.pageCountAtMaintenance + policy.intervalPages;
  }

  const dateOverdue = dueAt !== null && new Date(dueAt).getTime() < Date.now();
  const pagesOverdue = duePages !== null && currentPageCount !== null && currentPageCount >= duePages;

  return { dueAt, duePages, currentPageCount, dateOverdue, pagesOverdue };
}

function toMaintenanceResponse(
  printerId: string,
  policy: PrinterMaintenancePolicy,
  events: ReturnType<typeof printersRepository.listMaintenanceEvents>,
  reading: PrinterSnmpReading | undefined,
): MaintenanceResponse {
  // Mesma regra de pageCountValue usada em /consumables: só um SnmpMeasurement
  // com status 'ok' vira número utilizável; sentinela/erro/nunca-coletado
  // viram null (nunca NaN/undefined).
  const currentPageCount = reading ? pageCountValue(reading.pageCount) : null;

  return {
    printerId,
    policy: { intervalDays: policy.intervalDays, intervalPages: policy.intervalPages },
    events,
    next: computeNextMaintenance(policy, events, currentPageCount),
  };
}

// --- GET /printers/:id/history (Onda 2, subtarefa 12) ---
//
// Série temporal de leituras SNMP persistidas por printer-snmp.service.ts a
// cada ciclo do poller (ver `persistReadingToHistory` lá e
// `printer_snmp_history` em src/db/printers.db.ts) — diferente de
// /consumables e /diagnostics (que só expõem a ÚLTIMA leitura), este
// endpoint devolve a lista inteira dentro da janela pedida, em ordem
// cronológica, para o frontend plotar tendência (ex.: queda de toner ao
// longo do tempo).

const historyQuery = z.object({
  // `offset: true`: mesmo schema de from/to já usado em
  // /bandwidth/history/long-range (bandwidth.routes.ts) — aceita qualquer
  // fuso, não só 'Z'.
  from: z.string().datetime({ offset: true }).optional(),
  to: z.string().datetime({ offset: true }).optional(),
});

// `collected_at` é gravado sempre em ISO-8601 UTC canônico
// (`new Date().toISOString()`, com milissegundos e sufixo 'Z' — ver
// PrinterSnmpReading.collectedAt em printer-snmp.service.ts), e a
// comparação no SQLite é LEXICOGRÁFICA sobre TEXT. Um `from`/`to` com offset
// de fuso (ex.: '-03:00', aceito pelo schema acima) ou sem milissegundos
// comparado cru contra esse formato dá resultado errado sem erro nenhum —
// mesma armadilha documentada em toCanonicalUtcIso
// (bandwidth-history.service.ts). Convertemos para o mesmo formato canônico
// antes de consultar o repositório.
function toCanonicalUtcIso(value: string): string {
  return new Date(value).toISOString();
}

interface HistoryResponseEntry {
  collectedAt: string;
  pageCount: number | null;
  supplies: Array<{ name: string; levelPercent: number | null }>;
  partial: boolean;
}

interface HistoryResponse {
  printerId: string;
  entries: HistoryResponseEntry[];
}

export default async function printersRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // SEGURANÇA: nenhuma rota abaixo devolve o segredo SNMP (community
  // string ou credenciais SNMPv3) — nem em POST, GET (lista ou individual)
  // nem em PATCH. Ele é aceito na escrita e guardado em disco (ver
  // src/db/printers.db.ts), mas a leitura sempre passa por toPublic(),
  // que remove o campo antes de serializar. Mesmo espírito do
  // GET /ssh-credentials em ssh.routes.ts. As rotas de sleep-time/
  // auto-power-off abaixo também não têm segredo nenhum envolvido (a WBM
  // Brother não pede login para essas páginas), mas seguem a mesma
  // disciplina por hábito do projeto: nunca ecoam nada do registro além do
  // necessário para a ação pedida.

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
        wbmCredentials: body.wbmCredentials,
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

  // --- GET /printers/discover-candidates (achado 10 do CLAUDE.md) ---
  //
  // Registrada ANTES de `/printers/:id` de propósito (documentação de
  // leitura, não requisito do Fastify — o router dele já prioriza rotas
  // estáticas sobre `:id` independente da ordem de registro): fica claro que
  // "discover-candidates" nunca é interpretado como um `:id`.
  //
  // Não faz nenhuma varredura de rede ativa — só cruza o que o controller
  // UniFi já sabe (`unifiClassicService.getPrinterDiscoveryCandidates`,
  // filtro por fabricante/hostname) contra o cadastro já existente. Nunca
  // cadastra nada sozinho: só lista candidatos para confirmação manual.
  app.get('/printers/discover-candidates', async (_request, reply) => {
    if (!unifiClassicService.isConfigured()) {
      return reply.code(503).send({
        error: 'API clássica do controller não configurada',
        details: 'Configure UNIFI_CONTROLLER_USER/UNIFI_CONTROLLER_PASSWORD para usar a descoberta de impressoras.',
      });
    }

    const candidates = await unifiClassicService.getPrinterDiscoveryCandidates();
    const registeredMacs = new Set(printersRepository.listAll().map((printer) => printer.mac));
    const data = candidates.filter((candidate) => !registeredMacs.has(candidate.mac));
    return reply.send({ data });
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

  // --- GET /printers/:id/history (subtarefa 12) ---
  app.get('/printers/:id/history', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const record = printersRepository.getById(id);
    if (!record) {
      return reply.code(404).send({ error: 'Impressora não encontrada' });
    }

    const query = historyQuery.parse(request.query);
    const from = query.from ? toCanonicalUtcIso(query.from) : undefined;
    const to = query.to ? toCanonicalUtcIso(query.to) : undefined;

    const entries = printersRepository.listSnmpHistory(id, { from, to });
    const response: HistoryResponse = {
      printerId: id,
      entries: entries.map((entry) => ({
        collectedAt: entry.collectedAt,
        pageCount: entry.pageCount,
        // Normaliza o nome NA LEITURA (achado real da revisão crítica da
        // subtarefa 19): antes dela, `suppliesForHistory` gravava o nome
        // cru com "S/N:..." embutido (ex.: "Black Toner
        // S/N:CRUM-210729A5BB3"); depois dela, grava sem o serial ("Black
        // Toner"). Sem normalizar aqui, linhas gravadas ANTES do deploy
        // (que continuam intactas no banco, retenção de 90 dias) fariam o
        // MESMO cartucho físico aparecer como dois suprimentos distintos
        // na série temporal — um que "termina" no instante do deploy e
        // outro que "começa" ali. `parseSupplyDescription` é idempotente
        // (um nome que já não tem "S/N:" não muda), então isso corrige as
        // linhas antigas sem tocar o banco nem depender de uma migração.
        supplies: entry.supplies.map((supply) => ({
          ...supply,
          name: parseSupplyDescription(supply.name).name ?? supply.name,
        })),
        partial: entry.partial,
      })),
    };
    return response;
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
        wbmCredentials: body.wbmCredentials,
        maintenance: body.maintenance,
      };

      const record = printersRepository.update(id, patch);
      if (!record) {
        return reply.code(404).send({ error: 'Impressora não encontrada' });
      }
      return toPublic(record);
    },
  );

  app.delete(
    '/printers/:id',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const deleted = printersRepository.delete(id);
      if (!deleted) {
        return reply.code(404).send({ error: 'Impressora não encontrada' });
      }
      return reply.send({ ok: true });
    },
  );

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

  // --- Sleep Time / Auto Power Off da WBM Brother (spike da subtarefa 9) ---
  //
  // ESPECÍFICO DA FAMÍLIA BROTHER — ver o comentário de topo de
  // printer-brother-wbm.service.ts. O cadastro deste módulo não tem campo
  // de fabricante, então não há como recusar a chamada de antemão para uma
  // HP/outro fabricante: o resultado nesse caso é um erro de rede/HTTP
  // (504/502 abaixo), nunca um "sucesso" enganoso.

  app.post(
    '/printers/:id/sleep-time',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = sleepTimeBody.parse(request.body);

      const record = printersRepository.getById(id);
      if (!record) {
        return reply.code(404).send({ error: 'Impressora não encontrada' });
      }

      const target = await resolvePrinterIp(record, request.log);
      return handleWbmAction(reply, target, id, request.log, (ip) => setSleepTime(ip, body.minutes));
    },
  );

  app.post(
    '/printers/:id/auto-power-off',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = autoPowerOffBody.parse(request.body);

      const record = printersRepository.getById(id);
      if (!record) {
        return reply.code(404).send({ error: 'Impressora não encontrada' });
      }

      const target = await resolvePrinterIp(record, request.log);
      const index = AUTO_POWER_OFF_HOURS_TO_INDEX[body.hours as AutoPowerOffHours];
      return handleWbmAction(reply, target, id, request.log, (ip) => setAutoPowerOff(ip, index));
    },
  );

  // --- POST /printers/:id/reboot — reboot REAL do equipamento (HP/SWS) ---
  //
  // ATENÇÃO: isto REINICIA A IMPRESSORA FÍSICA (firmware), ao contrário de
  // /reconnect logo acima, que só desassocia/reassocia o cliente no
  // controller UniFi. Um job em impressão morre. O frontend confirma com o
  // usuário antes de chamar.
  //
  // ESPECÍFICO DA FAMÍLIA HP (SWS) — ver o comentário de topo de
  // printer-hp-sws.service.ts. Reboot remoto na família Brother foi
  // investigado e CONFIRMADO INVIÁVEL (a WBM só expõe resets destrutivos, ver
  // CLAUDE.md, achado 3), então não há rota equivalente para ela: chamar esta
  // rota apontando para uma Brother resulta em 502 (a WBM não tem /sws/*),
  // nunca num sucesso enganoso.
  //
  // DECISÃO — códigos HTTP (parte segue a mesma lógica já documentada em
  // handleWbmAction, parte é específica desta rota):
  //   - credencial do painel web não configurada no cadastro: 409 Conflict.
  //     Mesmo raciocínio do "sem IP conhecido": nenhuma chamada de rede foi
  //     tentada, é estado do próprio recurso e a ação corretiva é do
  //     operador (PATCH /printers/:id com `wbmCredentials`). Um 5xx faria um
  //     cliente com retry automático insistir num estado que retry nunca
  //     resolve.
  //   - sem IP conhecido: 409, idêntico às rotas Brother.
  //   - PrinterSwsUnreachableError (timeout/rede): 504.
  //   - PrinterSwsAuthenticationError (a SWS recusou a credencial): 403
  //     Forbidden. Escolhido em vez de 401 por um motivo concreto, não
  //     estético: 401 é o status que ESTA API usa para o próprio JWT
  //     (app.authenticate), e o cliente do frontend trata 401 como "token
  //     expirado" — ele chama /auth/refresh e REEXECUTA a requisição
  //     original (ver `request()` em frontend/src/lib/api.ts). Numa rota de
  //     reboot isso significaria disparar o comando DUAS vezes por causa de
  //     uma senha de painel errada. 403 comunica "autenticado neste
  //     dashboard, porém a credencial guardada não foi aceita pelo
  //     equipamento" sem colidir com o fluxo de sessão. Não é 502 (que
  //     usamos para "a impressora recusou a requisição" genérico) porque
  //     aqui a causa é conhecida e acionável: a credencial cadastrada está
  //     errada.
  //   - PrinterSwsRequestError (não-2xx, corpo inutilizável, dispositivo que
  //     não é uma SWS): 502.
  // Nenhum destes erros é registrado no error handler central de src/app.ts,
  // pelo mesmo motivo já documentado para os erros da Brother: são
  // exclusivos desta rota.
  app.post(
    '/printers/:id/reboot',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const record = printersRepository.getById(id);
      if (!record) {
        return reply.code(404).send({ error: 'Impressora não encontrada' });
      }

      // Credencial ANTES de resolver o IP: sem ela a ação é impossível, e
      // resolver o IP custa uma (ou duas) chamadas ao controller UniFi que
      // seriam desperdiçadas.
      const credentials = parseWbmCredentials(record.wbmCredentials);
      if (!credentials) {
        return reply.code(409).send({
          error: 'Credencial do painel web não configurada',
          details:
            'Configure a credencial do painel web desta impressora (campo wbmCredentials em ' +
            'PATCH /printers/:id) antes de reiniciar remotamente.',
        });
      }

      const target = await resolvePrinterIp(record, request.log);
      if (!target) {
        return reply.code(409).send({
          error: 'IP da impressora desconhecido',
          details: `Impressora ${id} não tem ipOverride configurado e não foi encontrada pelo controller UniFi.`,
        });
      }

      // Mesmo risco de IP histórico já documentado em handleWbmAction, porém
      // com consequência PIOR: aqui o efeito colateral de acertar o
      // dispositivo errado é reiniciar um equipamento que ninguém pediu. Não
      // bloqueamos (as impressoras em DHCP ficariam sem a feature), mas o
      // aviso é explícito e o alvo real volta na resposta. Note que, na
      // prática, o passo de identidade (`fetchDeviceIdentity`) já protege
      // bastante: um dispositivo que não seja uma HP/SWS falha com 502 antes
      // de qualquer POST de escrita.
      if (target.origin === 'classic') {
        request.log.warn(
          { printerId: id, ipAddress: target.ipAddress, ipOrigin: target.origin },
          'REBOOT usando IP HISTÓRICO da API clássica (last_ip) — não há garantia de que este IP ainda ' +
            'pertence a esta impressora. Configure ipOverride no cadastro para ações de escrita confiáveis.',
        );
      }

      try {
        await rebootHpPrinter(target.ipAddress, record.mac, credentials);
      } catch (error) {
        if (error instanceof PrinterSwsUnreachableError) {
          return reply.code(504).send({ error: 'Impressora não respondeu', details: error.message });
        }
        if (error instanceof PrinterSwsAuthenticationError) {
          return reply.code(403).send({ error: 'Credencial do painel web recusada', details: error.message });
        }
        if (error instanceof PrinterSwsRequestError) {
          return reply.code(502).send({ error: 'Painel da impressora recusou a requisição', details: error.message });
        }
        throw error;
      }

      return reply.send({ ok: true, ipAddress: target.ipAddress, ipOrigin: target.origin });
    },
  );

  // --- POST /printers/:id/admin-password — troca a senha de admin da SWS (HP) ---
  //
  // Onda 3, subtarefa 11 — reaberta por pedido explícito do usuário (estava
  // fechada desde 2026-09-08, ver CLAUDE.md). É a ação de MAIOR risco do
  // projeto: mexe na credencial mestra do painel admin de um equipamento de
  // produção real, sem forma de ler a senha de volta se algo der errado. Ver
  // o comentário de topo da seção "Troca de senha de admin" em
  // printer-hp-sws.service.ts para o protocolo completo (payload real
  // capturado ao vivo, cifra Ext1/AES obrigatória no campo de senha) e a
  // DECISÃO de verificar por relogin antes de persistir qualquer coisa.
  //
  // ESPECÍFICO DA FAMÍLIA HP (SWS) — mesma ressalva do /reboot: chamar contra
  // uma Brother resulta em 502 (a WBM não tem /sws/*), nunca sucesso enganoso.
  //
  // Corpo: `{ username?, password? }`, ambos opcionais — mesmo espírito do
  // já existente `POST /ssh-credentials/rotate`
  // (`unifi-classic.service.ts#generateStrongPassword`): sem `password`, gera
  // uma forte aleatória aqui mesmo. `password` limitado a 18 caracteres — o
  // MESMO limite (`maxLength: 18`) do campo `GSI_ADMIN_WUI_LOGIN_PASS` no
  // formulário real da SWS (confirmado lendo `Admin.js` ao vivo); mandar algo
  // maior arriscaria uma truncagem silenciosa no firmware que a verificação
  // por relogin ainda pegaria, mas só depois de já ter mexido na senha real.
  //
  // DECISÃO — a resposta devolve `username`/`password` em texto puro (mais
  // `ipAddress`/`ipOrigin`, como as outras escritas deste arquivo, e o mesmo
  // par em `attemptedUsername`/`attemptedPassword` no 502 ambíguo — ver o
  // catch): é a ÚNICA vez que a senha nova aparece em claro em qualquer lugar da API,
  // mesmo padrão do `ssh-credentials/rotate` (não existe outra rota que
  // devolva isso depois — se for perdida, só gerando outra). Diferente do SSH,
  // aqui a credencial TAMBÉM é persistida em `wbmCredentials` (obrigatório:
  // /reboot e as automações Brother-equivalentes desta família dependem dela
  // para continuar funcionando depois da troca).
  //
  // ACHADO DO CRÍTICO (2026-09-10) — nem `username` nem `password` podem
  // conter caractere de CONTROLE, e isso não é higiene genérica de input: o
  // login da SWS cifra literalmente `usuário\rsenha` (CR como separador, ver
  // `buildLoginAuthentication`). Uma senha (ou usuário) com `\r` seria
  // aceita pelo firmware no SetAdmin.jsp — que cifra o campo sozinho, sem
  // separador — e depois NENHUM login montado por este projeto conseguiria
  // reproduzi-la: o dispositivo cortaria no primeiro CR. Resultado: a
  // verificação por relogin falha, e a impressora fica com uma senha que o
  // dashboard nunca mais consegue usar (nem pro /reboot). Rejeitar antes de
  // qualquer chamada de rede é a única correção barata. Nenhum desses
  // caracteres é digitável no formulário real da SWS, então isto não recusa
  // nada que um operador consiga configurar pelo painel. O mesmo
  // `noControlChars` guarda `wbmCredentialsSchema` (a ESCRITA do cadastro) —
  // sem os dois lados, o caminho "sem `username` no corpo" reintroduziria o
  // furo usando o valor já gravado.
  const adminPasswordBody = z.object({
    username: z
      .string()
      .min(1)
      .max(18)
      .refine(noControlChars, 'Usuário não pode conter caractere de controle')
      .optional(),
    // 8-18: sem mínimo documentado pelo próprio firmware (só o maxLength do
    // formulário), mas exigir algum mínimo evita gerar/aceitar uma senha
    // trivial para a credencial mestra do painel.
    password: z
      .string()
      .min(8)
      .max(18)
      .refine(noControlChars, 'Senha não pode conter caractere de controle')
      .optional(),
  });

  app.post(
    '/printers/:id/admin-password',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = adminPasswordBody.parse(request.body ?? {});
      const record = printersRepository.getById(id);
      if (!record) {
        return reply.code(404).send({ error: 'Impressora não encontrada' });
      }

      const currentCredentials = parseWbmCredentials(record.wbmCredentials);
      if (!currentCredentials) {
        return reply.code(409).send({
          error: 'Credencial do painel web não configurada',
          details:
            'Configure a credencial ATUAL do painel web desta impressora (campo wbmCredentials em ' +
            'PATCH /printers/:id) antes de trocar a senha — é preciso logar com ela primeiro.',
        });
      }

      const target = await resolvePrinterIp(record, request.log);
      if (!target) {
        return reply.code(409).send({
          error: 'IP da impressora desconhecido',
          details: `Impressora ${id} não tem ipOverride configurado e não foi encontrada pelo controller UniFi.`,
        });
      }

      if (target.origin === 'classic') {
        request.log.warn(
          { printerId: id, ipAddress: target.ipAddress, ipOrigin: target.origin },
          'TROCA DE SENHA DE ADMIN usando IP HISTÓRICO da API clássica (last_ip) — não há garantia de que ' +
            'este IP ainda pertence a esta impressora. Configure ipOverride antes de trocar credenciais.',
        );
      }

      const newUsername = body.username ?? currentCredentials.username;
      const newPassword = body.password ?? randomBytes(12).toString('base64url');

      try {
        await changeHpAdminPassword(target.ipAddress, currentCredentials, newUsername, newPassword);
      } catch (error) {
        if (error instanceof PrinterSwsUnreachableError) {
          return reply.code(504).send({ error: 'Impressora não respondeu', details: error.message });
        }
        if (error instanceof PrinterSwsAuthenticationError) {
          return reply.code(403).send({ error: 'Credencial ATUAL do painel web recusada', details: error.message });
        }
        // ACHADO DO CRÍTICO (2026-09-10) — o pior caminho desta rota, e o
        // único que pode INUTILIZAR um equipamento de produção: aqui o POST
        // de escrita já saiu e não deu pra confirmar o resultado (ver
        // PrinterSwsPasswordVerificationError). Não persistir a credencial
        // nova está certo (o dispositivo pode ter ficado com a antiga), mas a
        // versão anterior desta rota também DESCARTAVA o valor tentado: numa
        // chamada sem `password` no corpo (senha gerada aqui por
        // `randomBytes`), a única cópia existente da senha que a impressora
        // PODE ter passado a exigir morria neste `return` — sem aparecer na
        // resposta, e sem poder aparecer no log (regra do projeto: senha nunca
        // vai pro log). O operador ficaria trancado fora do painel de uma
        // impressora de produção, sem recuperação a não ser reset de fábrica.
        // Devolver o valor tentado não cria exposição nova: esta mesma rota já
        // devolve a senha em claro no caminho de sucesso, pro mesmo chamador
        // autenticado, pelo mesmo canal (a DECISÃO acima).
        if (error instanceof PrinterSwsPasswordVerificationError) {
          request.log.error(
            { printerId: id, ipAddress: target.ipAddress, ipOrigin: target.origin },
            'TROCA DE SENHA DE ADMIN EM ESTADO AMBÍGUO — o POST de escrita já havia sido despachado e não foi ' +
              'possível confirmar o resultado. O cadastro NÃO foi alterado (segue com a credencial antiga); a ' +
              'credencial tentada foi devolvida em texto puro APENAS no corpo desta resposta HTTP.',
          );
          return reply.code(502).send({
            error: 'Não foi possível confirmar a troca de senha',
            details: error.message,
            // Estes dois campos são a ÚNICA cópia da credencial tentada que
            // sai do processo — sem eles não há como recuperar o acesso se a
            // troca tiver colado de verdade no dispositivo.
            attemptedUsername: newUsername,
            attemptedPassword: newPassword,
            persisted: false,
            ipAddress: target.ipAddress,
            ipOrigin: target.origin,
          });
        }
        if (error instanceof PrinterSwsRequestError) {
          return reply.code(502).send({ error: 'Painel da impressora recusou a requisição', details: error.message });
        }
        throw error;
      }

      // Só chega aqui depois do relogin de verificação ter confirmado a senha
      // nova de verdade (ver changeHpAdminPassword) — persistir antes disso
      // deixaria o cadastro dessincronizado se a troca real tivesse falhado
      // parcialmente.
      const newCredentials: WbmCredentials = { username: newUsername, password: newPassword };
      printersRepository.update(id, { wbmCredentials: newCredentials });

      // `ipAddress`/`ipOrigin` na resposta pelo mesmo motivo já documentado em
      // handleWbmAction e /reboot (as outras rotas de ESCRITA deste arquivo, que
      // já devolvem os dois): quem chama precisa saber em qual endereço a
      // escrita caiu de fato, e se ele veio do `last_ip` HISTÓRICO da API
      // clássica. ACHADO DO CRÍTICO (2026-09-10): esta rota era a única escrita
      // do arquivo sem isso, justamente a de maior consequência ao acertar o
      // dispositivo errado (trocar a senha de admin de um equipamento que
      // ninguém pediu) — o aviso existia só no log do servidor.
      return reply.send({
        username: newUsername,
        password: newPassword,
        ipAddress: target.ipAddress,
        ipOrigin: target.origin,
      });
    },
  );

  // --- Agenda de manutenção (Onda 2, subtarefa 8) ---

  app.post(
    '/printers/:id/maintenance',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const body = createMaintenanceEventBody.parse(request.body);

      if (!printersRepository.getById(id)) {
        return reply.code(404).send({ error: 'Impressora não encontrada' });
      }

      const input: CreateMaintenanceEventInput = {
        performedAt: body.performedAt,
        note: body.note,
        pageCountAtMaintenance: body.pageCountAtMaintenance,
      };
      const event = printersRepository.createMaintenanceEvent(id, input);
      return reply.code(201).send(event);
    },
  );

  app.get('/printers/:id/maintenance', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const record = printersRepository.getById(id);
    if (!record) {
      return reply.code(404).send({ error: 'Impressora não encontrada' });
    }

    const events = printersRepository.listMaintenanceEvents(id);
    return toMaintenanceResponse(id, record.maintenance, events, getLastReading(id));
  });
}
