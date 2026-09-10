import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { UniFiApiError, unifiService } from '../services/unifi.service.js';
import type { UniFiWifiSecurityConfigurationCreate } from '../types/unifi.js';

// Nome da zona de firewall usada como default quando o body de POST
// /networks não informa `zoneId` explicitamente. Confirmado contra um
// controller real: as networks LAN existentes no ambiente de teste
// (Default, Evok-Corporativa) usam a zona "Internal" — é a zona correta
// pra uma rede local comum (equivalente a LAN/Trusted). O usuário pode
// sempre escolher outra via GET /networks/zones + POST /networks com
// `zoneId` explícito (ex: pra colocar uma VLAN numa zona DMZ/Guest).
const DEFAULT_ZONE_NAME = 'Internal';

async function resolveZoneId(explicitZoneId: string | undefined, siteId: string | undefined): Promise<string> {
  if (explicitZoneId) return explicitZoneId;

  const { data: zones } = await unifiService.listFirewallZones(siteId);
  const defaultZone = zones.find((zone) => zone.name === DEFAULT_ZONE_NAME);
  if (!defaultZone) {
    throw new UniFiApiError(
      502,
      `Nenhuma zona de firewall chamada "${DEFAULT_ZONE_NAME}" foi encontrada neste site — informe ` +
        '"zoneId" explicitamente (veja GET /networks/zones para as zonas disponíveis).',
    );
  }
  return defaultZone.id;
}

// Regex simples de IPv4 (0-255 por octeto) — suficiente pra validar o
// formato de hostIpAddress/fixed_ip antes de mandar pro controller (o
// próprio controller valida a semântica, ex: se o IP pertence à sub-rede).
const ipv4Regex =
  /^((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

function ipv4ToInt(ip: string): number {
  const parts = ip.split('.').map(Number);
  return ((parts[0] << 24) | (parts[1] << 16) | (parts[2] << 8) | parts[3]) >>> 0;
}

function intToIpv4(n: number): string {
  return [24, 16, 8, 0].map((shift) => (n >>> shift) & 0xff).join('.');
}

// Calcula um range de DHCP razoável dentro da sub-rede de hostIpAddress/
// prefixLength: começa 10 endereços depois do início da rede (deixando
// espaço pro gateway e IPs fixos manuais) e termina um endereço antes do
// broadcast. Genérico pra qualquer CIDR — não hardcoda nenhuma sub-rede
// específica. Em sub-redes muito pequenas (prefixLength alto), o range
// colapsa pro menor intervalo válido em vez de ficar invertido.
export function computeDhcpRange(hostIpAddress: string, prefixLength: number): { start: string; stop: string } {
  const hostInt = ipv4ToInt(hostIpAddress);
  const mask = prefixLength === 0 ? 0 : (0xffffffff << (32 - prefixLength)) >>> 0;
  const network = (hostInt & mask) >>> 0;
  const broadcast = (network | (~mask >>> 0)) >>> 0;

  let start = network + 10;
  let stop = broadcast - 1;

  if (start > stop) {
    start = Math.min(network + 1, broadcast);
    stop = start;
  }
  // Evita que o range comece exatamente no IP do gateway/host informado.
  // Compara contra `broadcast` (o limite real da sub-rede) em vez de
  // `stop`: no caminho de colapso acima (sub-redes pequenas, ex: /30),
  // `start` e `stop` já são iguais nesse ponto, então uma comparação
  // `start < stop` nunca é verdadeira e o range acabava ficando igual ao
  // IP do gateway (ex: hostIpAddress=X+1 numa /30 colapsava pro mesmo
  // X+1). Usando `broadcast` como limite, ainda há espaço pra avançar
  // pro próximo IP livre da sub-rede nesses casos.
  if (start === hostInt && start < broadcast) {
    start += 1;
    if (stop < start) stop = start;
  }

  return { start: intToIpv4(start), stop: intToIpv4(stop) };
}

const idParam = z.object({ id: z.string().min(1) });
const siteQuery = z.object({ siteId: z.string().min(1).optional() });

const wifiPassphraseSchema = z
  .string()
  .min(8, 'Senha deve ter no mínimo 8 caracteres')
  .max(63, 'Senha deve ter no máximo 63 caracteres');

// Tipos de segurança Enterprise (WPA*_ENTERPRISE) exigem um perfil RADIUS
// já cadastrado no painel do UniFi (ver GET /wifi/radius-profiles) em vez
// de uma senha — perfis RADIUS são só-leitura via API, então não dá pra
// criar um perfil novo por aqui, só referenciar um existente.
const wifiEnterpriseSecurityTypes = ['WPA2_ENTERPRISE', 'WPA3_ENTERPRISE', 'WPA2_WPA3_ENTERPRISE'] as const;
const wifiSecurityTypeSchema = z.union([z.literal('WPA2_PERSONAL'), z.enum(wifiEnterpriseSecurityTypes)]);

// Validação condicional em vez de z.discriminatedUnion: o body histórico
// (só `name` + `passphrase`, sem `securityType`) precisa continuar válido
// pra não quebrar clientes existentes — discriminatedUnion exigiria que o
// campo discriminador estivesse sempre presente no corpo bruto antes de
// aplicar o default, o que quebraria essa compatibilidade.
const createWifiBody = z
  .object({
    name: z.string().min(1, 'Nome é obrigatório').max(32),
    securityType: wifiSecurityTypeSchema.optional().default('WPA2_PERSONAL'),
    passphrase: wifiPassphraseSchema.optional(),
    radiusProfileId: z.string().min(1).optional(),
    hideName: z.boolean().optional().default(false),
    clientIsolationEnabled: z.boolean().optional().default(false),
  })
  .merge(siteQuery)
  .superRefine((body, ctx) => {
    const isEnterprise = body.securityType !== 'WPA2_PERSONAL';
    if (isEnterprise) {
      if (!body.radiusProfileId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['radiusProfileId'],
          message: 'radiusProfileId é obrigatório quando securityType é Enterprise (veja GET /wifi/radius-profiles)',
        });
      }
      if (body.passphrase) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['passphrase'],
          message: 'passphrase não deve ser informado junto com um securityType Enterprise/RADIUS',
        });
      }
    } else {
      if (!body.passphrase) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['passphrase'],
          message: 'passphrase é obrigatório para securityType WPA2_PERSONAL',
        });
      }
      if (body.radiusProfileId) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['radiusProfileId'],
          message: 'radiusProfileId só é válido com um securityType Enterprise/RADIUS',
        });
      }
    }
  });

// Monta o securityConfiguration de uma rede Enterprise/RADIUS. `nasId` usa
// `{ type: 'DERIVED', source: 'BSSID' }` — confirmado contra uma rede
// Enterprise real já em produção neste ambiente ("Evok-Corporativa",
// WPA2_WPA3_ENTERPRISE), criada manualmente pelo usuário antes deste
// projeto: o controller aceita e usa esse valor sem exigir nenhuma
// configuração manual adicional (o NAS-Identifier enviado ao RADIUS passa
// a ser o BSSID do rádio que atendeu a conexão). Por isso o frontend não
// pede esse valor no formulário — é sempre este default. O schema oficial
// ("Wifi Radius NAS ID configuration") também aceita `source:
// DEVICE_MAC_ADDRESS/DEVICE_NAME/SITE_NAME` ou `type: USER_DEFINED` com um
// `value` livre, caso um valor diferente seja necessário no futuro.
// `coaEnabled: false` e `fastRoamingEnabled: false` seguem o mesmo default
// conservador já usado pra WPA2_PERSONAL neste arquivo. `securityMode` e
// `pmfMode`/`wpa3FastRoamingEnabled` só existem (e são obrigatórios) nos
// schemas oficiais de WPA3_ENTERPRISE e WPA2_WPA3_ENTERPRISE,
// respectivamente — por isso são adicionados condicionalmente.
function buildEnterpriseSecurityConfiguration(
  securityType: (typeof wifiEnterpriseSecurityTypes)[number],
  radiusProfileId: string,
): UniFiWifiSecurityConfigurationCreate {
  const radiusConfiguration = {
    profileId: radiusProfileId,
    nasId: { type: 'DERIVED' as const, source: 'BSSID' as const },
  };

  if (securityType === 'WPA3_ENTERPRISE') {
    return {
      type: 'WPA3_ENTERPRISE',
      coaEnabled: false,
      fastRoamingEnabled: false,
      securityMode: 'DEFAULT',
      radiusConfiguration,
    };
  }

  if (securityType === 'WPA2_WPA3_ENTERPRISE') {
    return {
      type: 'WPA2_WPA3_ENTERPRISE',
      coaEnabled: false,
      fastRoamingEnabled: false,
      pmfMode: 'OPTIONAL',
      wpa3FastRoamingEnabled: false,
      radiusConfiguration,
    };
  }

  return {
    type: 'WPA2_ENTERPRISE',
    coaEnabled: false,
    fastRoamingEnabled: false,
    radiusConfiguration,
  };
}

const updatePasswordBody = z.object({ passphrase: wifiPassphraseSchema }).merge(siteQuery);
const setEnabledBody = z.object({ enabled: z.boolean() }).merge(siteQuery);

const createNetworkBody = z
  .object({
    name: z.string().min(1, 'Nome é obrigatório').max(64),
    vlanId: z.number().int().min(2, 'vlanId deve estar entre 2 e 4009').max(4009, 'vlanId deve estar entre 2 e 4009'),
    hostIpAddress: z.string().regex(ipv4Regex, 'hostIpAddress deve ser um IPv4 válido'),
    prefixLength: z.number().int().min(1).max(32),
    internetAccessEnabled: z.boolean().optional().default(true),
    isolationEnabled: z.boolean().optional().default(false),
    zoneId: z.string().min(1).optional(),
  })
  .merge(siteQuery);

export default async function networksRoutes(app: FastifyInstance) {
  app.addHook('preHandler', app.authenticate);

  // --- Wi-Fi (SSIDs) ---

  app.get('/wifi', async (request) => {
    const { siteId } = siteQuery.parse(request.query);
    return unifiService.listWifiBroadcasts(siteId);
  });

  // Perfis RADIUS cadastrados manualmente no painel do UniFi (ex: "RADIUS
  // Windows AD", apontando pro NPS do Windows Server) — usado pelo
  // frontend pra popular o select de rede Enterprise em vez de aceitar
  // qualquer profileId arbitrário.
  app.get('/wifi/radius-profiles', async (request) => {
    const { siteId } = siteQuery.parse(request.query);
    return unifiService.listRadiusProfiles(siteId);
  });

  app.post(
    '/wifi',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { name, securityType, passphrase, radiusProfileId, hideName, clientIsolationEnabled, siteId } =
        createWifiBody.parse(request.body);

      const securityConfiguration: UniFiWifiSecurityConfigurationCreate =
        securityType === 'WPA2_PERSONAL'
          ? { type: 'WPA2_PERSONAL', passphrase: passphrase!, fastRoamingEnabled: false }
          : buildEnterpriseSecurityConfiguration(securityType, radiusProfileId!);

      const broadcast = await unifiService.createWifiBroadcast(
        {
          type: 'STANDARD',
          name,
          enabled: true,
          hideName,
          channel2gLockedTo6: false,
          clientIsolationEnabled,
          dtimPeriod2gLockedTo3: false,
          multicastToUnicastConversionEnabled: false,
          uapsdEnabled: false,
          advertiseDeviceName: false,
          arpProxyEnabled: false,
          bssTransitionEnabled: true,
          broadcastingFrequenciesGHz: [2.4, 5],
          // Confirmado contra um controller real: sem `network` e sem
          // `fastRoamingEnabled`, o controller responde 400 ("WPA2 personal
          // security requires exactly one of [preshared keys setting, all
          // of [network setting, passphrase setting]], WPA security
          // combined with standard WiFi requires fast roaming setting").
          // Aplica-se tanto a WPA2_PERSONAL quanto às variantes Enterprise
          // criadas aqui (todas ficam na network NATIVE por padrão).
          network: { type: 'NATIVE' },
          securityConfiguration,
        },
        siteId,
      );
      return reply.code(201).send(broadcast);
    },
  );

  app.patch(
    '/wifi/:id/password',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { passphrase, siteId } = updatePasswordBody.parse(request.body);
      const broadcast = await unifiService.updateWifiBroadcastPassword(id, passphrase, siteId);
      return reply.send(broadcast);
    },
  );

  app.patch(
    '/wifi/:id/enabled',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { enabled, siteId } = setEnabledBody.parse(request.body);
      const broadcast = await unifiService.setWifiBroadcastEnabled(id, enabled, siteId);
      return reply.send(broadcast);
    },
  );

  app.delete(
    '/wifi/:id',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { siteId } = siteQuery.parse(request.query);
      await unifiService.deleteWifiBroadcast(id, siteId);
      return reply.send({ ok: true });
    },
  );

  // --- Networks (VLANs) ---

  app.get('/networks', async (request) => {
    const { siteId } = siteQuery.parse(request.query);
    return unifiService.listNetworks(siteId);
  });

  // Zonas de firewall disponíveis (ex: "Internal", "External", "DMZ") —
  // usado pelo frontend pra deixar o usuário escolher a zona de uma VLAN
  // nova em vez de ficar preso ao default "Internal".
  app.get('/networks/zones', async (request) => {
    const { siteId } = siteQuery.parse(request.query);
    return unifiService.listFirewallZones(siteId);
  });

  app.post(
    '/networks',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { name, vlanId, hostIpAddress, prefixLength, internetAccessEnabled, isolationEnabled, zoneId, siteId } =
        createNetworkBody.parse(request.body);
      // O OpenAPI oficial declara ipAddressRange/leaseTimeSeconds/
      // pingConflictDetectionEnabled (e também zoneId, no nível do body)
      // como opcionais, mas o controller real rejeita a criação com 400
      // sem eles ("zoneId must not be null", entre outros) — por isso são
      // sempre resolvidos/preenchidos aqui.
      const dhcpRange = computeDhcpRange(hostIpAddress, prefixLength);
      const resolvedZoneId = await resolveZoneId(zoneId, siteId);
      const network = await unifiService.createNetwork(
        {
          management: 'GATEWAY',
          name,
          enabled: true,
          vlanId,
          cellularBackupEnabled: false,
          internetAccessEnabled,
          isolationEnabled,
          zoneId: resolvedZoneId,
          ipv4Configuration: {
            autoScaleEnabled: false,
            hostIpAddress,
            prefixLength,
            dhcpConfiguration: {
              mode: 'SERVER',
              ipAddressRange: dhcpRange,
              leaseTimeSeconds: 86400,
              pingConflictDetectionEnabled: false,
            },
          },
        },
        siteId,
      );
      return reply.code(201).send(network);
    },
  );

  app.delete(
    '/networks/:id',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { id } = idParam.parse(request.params);
      const { siteId } = siteQuery.parse(request.query);
      await unifiService.deleteNetwork(id, siteId);
      return reply.send({ ok: true });
    },
  );
}
