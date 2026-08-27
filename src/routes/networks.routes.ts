import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../config/env.js';
import { UniFiApiError, unifiService } from '../services/unifi.service.js';

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
function computeDhcpRange(hostIpAddress: string, prefixLength: number): { start: string; stop: string } {
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
  if (start === hostInt && start < stop) start += 1;

  return { start: intToIpv4(start), stop: intToIpv4(stop) };
}

const idParam = z.object({ id: z.string().min(1) });
const siteQuery = z.object({ siteId: z.string().min(1).optional() });

const wifiPassphraseSchema = z
  .string()
  .min(8, 'Senha deve ter no mínimo 8 caracteres')
  .max(63, 'Senha deve ter no máximo 63 caracteres');

const createWifiBody = z
  .object({
    name: z.string().min(1, 'Nome é obrigatório').max(32),
    passphrase: wifiPassphraseSchema,
    hideName: z.boolean().optional().default(false),
    clientIsolationEnabled: z.boolean().optional().default(false),
  })
  .merge(siteQuery);

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

  app.post(
    '/wifi',
    { config: { rateLimit: { max: env.RATE_LIMIT_CLIENT_ACTION_MAX, timeWindow: env.RATE_LIMIT_WINDOW } } },
    async (request, reply) => {
      const { name, passphrase, hideName, clientIsolationEnabled, siteId } = createWifiBody.parse(request.body);
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
          network: { type: 'NATIVE' },
          securityConfiguration: { type: 'WPA2_PERSONAL', passphrase, fastRoamingEnabled: false },
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

  app.delete('/wifi/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { siteId } = siteQuery.parse(request.query);
    await unifiService.deleteWifiBroadcast(id, siteId);
    return reply.send({ ok: true });
  });

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

  app.delete('/networks/:id', async (request, reply) => {
    const { id } = idParam.parse(request.params);
    const { siteId } = siteQuery.parse(request.query);
    await unifiService.deleteNetwork(id, siteId);
    return reply.send({ ok: true });
  });
}
