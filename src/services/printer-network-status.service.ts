import { unifiService } from './unifi.service.js';
import { unifiClassicService, type ClassicClientNetworkInfo } from './unifi-classic.service.js';
import type { PrinterPublic } from '../db/printers.db.js';

// --- Merge com status ao vivo do UniFi (Onda 2, subtarefa 2) ---
//
// Esta lógica nasceu dentro de src/routes/printers.routes.ts (subtarefa 2) e
// foi movida para cá na subtarefa 5, sem mudança de comportamento: o poller
// SNMP (printer-snmp.service.ts) precisa exatamente do mesmo resolvedor para
// descobrir o IP de uma impressora sem `ipOverride`, e um serviço não pode
// importar um módulo de rota (isso criaria um ciclo assim que a rota
// `GET /printers/:id/consumables` da subtarefa 6 importar o poller). As
// rotas continuam reexportando estes símbolos para não quebrar nenhum
// import existente.
//
// Sinal de REDE apenas (a impressora está associada ao controller agora,
// com qual IP e por qual meio) — não confundir com o sinal de SNMP (a
// impressora responde a SNMP), que é justamente o que o poller mede: são
// dois sinais de saúde distintos, nunca conflacados.
//
// Achado crítico documentado em docs/printers-snmp-research.md: das 3
// impressoras reais da rede, só UMA aparece na Integration API oficial
// (unifiService.listClients()) — as outras 2 só aparecem via API clássica
// (rest/user, via unifiClassicService.getKnownClientsNetworkInfo()). Por
// isso o merge tenta a Integration API primeiro e cai pra API clássica
// quando o MAC não é encontrado lá — nunca confia só na Integration API.
export interface PrinterNetworkStatus {
  source: 'integration' | 'classic' | 'unknown';
  online: boolean | null;
  ipAddress: string | null;
  connectionType: 'WIRED' | 'WIRELESS' | null;
  // Apelido ATUAL do cliente no UniFi (campo `name` do controller) — achado
  // real: o editor "Renomear apelido no UniFi" do frontend nunca expunha o
  // valor atual, só o nome do cadastro local (campo diferente), então o
  // usuário não tinha como saber se o apelido já era aquele valor ou algo
  // completamente diferente antes de editar.
  alias: string | null;
}

export const UNKNOWN_NETWORK_STATUS: PrinterNetworkStatus = {
  source: 'unknown',
  online: null,
  ipAddress: null,
  connectionType: null,
  alias: null,
};

export type PrinterWithNetworkStatus = PrinterPublic & { network: PrinterNetworkStatus };

// Subconjunto mínimo de um logger (compatível com `FastifyBaseLogger` e com
// um logger de console) — o poller não roda dentro de um request, então não
// tem um `request.log` para passar aqui.
export interface NetworkStatusLogger {
  warn: (obj: unknown, msg: string) => void;
}

// Cria um resolvedor de status por MAC, buscando as duas fontes UMA vez só
// (nunca por impressora) — mesmo padrão de `GET /clients` em
// clients.routes.ts, que busca a lista de clientes uma vez e cruza
// localmente. Usado por GET /printers (N impressoras), GET /printers/:id
// (uma só) e pelo poller SNMP (que resolve o IP de todas num ciclo).
//
// As duas fontes são ENRIQUECIMENTO de um cadastro que vive em SQLite
// local: se o controller estiver fora do ar (ou as credenciais clássicas
// inválidas), o cadastro em si — nome, MAC, versão de SNMP, política de
// manutenção — continua perfeitamente legível. Por isso a falha de
// qualquer uma das fontes é degradada pra "não sabemos" (o mesmo
// `source: 'unknown'` de quando o MAC não é encontrado) em vez de derrubar
// a resposta inteira: um `GET /printers` virar 502/503 só porque o UniFi
// está indisponível seria o mesmo retrocesso que a guarda de
// `isConfigured()` abaixo já evita pro caso "API clássica não
// configurada". O erro é logado como warn (nunca engolido em silêncio).
export async function buildNetworkStatusResolver(
  log: NetworkStatusLogger,
): Promise<(mac: string) => PrinterNetworkStatus> {
  async function tryFetch<T>(source: string, fetchSource: () => Promise<T>): Promise<T | null> {
    try {
      return await fetchSource();
    } catch (error) {
      log.warn(
        { err: error, source },
        `Não foi possível obter o status de rede das impressoras via ${source} — degradando para "desconhecido"`,
      );
      return null;
    }
  }

  const [integrationResult, classicNetworkInfo, connectedMacs] = await Promise.all([
    tryFetch('Integration API', () => unifiService.listClients()),
    unifiClassicService.isConfigured()
      ? tryFetch('API clássica', () => unifiClassicService.getKnownClientsNetworkInfo())
      : Promise.resolve(null as Map<string, ClassicClientNetworkInfo> | null),
    // stat/sta (conectados agora de verdade) — ver a DECISÃO no branch
    // 'classic' abaixo. Fonte própria, busca independente das duas acima
    // (nenhuma falha aqui derruba o merge, mesmo raciocínio de `tryFetch`).
    unifiClassicService.isConfigured()
      ? tryFetch('API clássica (stat/sta)', () => unifiClassicService.getConnectedMacs())
      : Promise.resolve(null as Set<string> | null),
  ]);

  // A Integration API (`GET /sites/{id}/clients`) só lista clientes
  // CONECTADOS agora — presença nesta lista já significa "online". Quando
  // a chamada falhou, `integrationResult` é null e o Map fica vazio: nada
  // é dado como online (nunca afirma `false`, só cai pro fallback).
  const integrationByMac = new Map(
    (integrationResult?.data ?? []).map((client) => [client.macAddress.toLowerCase(), client]),
  );

  return (mac: string): PrinterNetworkStatus => {
    const integrationClient = integrationByMac.get(mac);
    if (integrationClient) {
      return {
        source: 'integration',
        online: true,
        ipAddress: integrationClient.ipAddress ?? null,
        connectionType: integrationClient.type,
        alias:
          typeof integrationClient.name === 'string' && integrationClient.name.length > 0
            ? integrationClient.name
            : null,
      };
    }

    const classicInfo = classicNetworkInfo?.get(mac);
    if (classicInfo) {
      return {
        source: 'classic',
        // /rest/user (API clássica) é o registro de clientes CONHECIDOS
        // pelo controller, não a lista de conectados agora — por isso não dá
        // pra afirmar online/offline só com ele. Cruzamos com /stat/sta
        // (`connectedMacs`, busca própria acima), que É a lista de
        // conectados agora de verdade (mesma fonte que fetchClientSignalStrength
        // já usa, mas sem o filtro de wireless dele — impressora cabeada
        // também deve poder aparecer online).
        //
        // `connectedMacs === null` (API clássica indisponível/erro nesta
        // busca específica) preserva o `null` de "não sabemos" — só quando a
        // busca teve sucesso é que a AUSÊNCIA do MAC no Set vira `false`
        // ("sabemos que não está conectada agora"), nunca o inverso.
        online: connectedMacs ? connectedMacs.has(mac) : null,
        ipAddress: classicInfo.ipAddress,
        connectionType: classicInfo.connectionType,
        alias: classicInfo.alias,
      };
    }

    // Não encontrada em nenhuma das duas fontes (API clássica não
    // configurada, uma das fontes indisponível, ou o MAC realmente não é
    // conhecido pelo controller) — não é um erro: a impressora pode estar
    // desligada há muito tempo ou o MAC pode estar errado no cadastro.
    return UNKNOWN_NETWORK_STATUS;
  };
}

export function withNetworkStatus(
  printer: PrinterPublic,
  resolveNetwork: (mac: string) => PrinterNetworkStatus,
): PrinterWithNetworkStatus {
  return { ...printer, network: resolveNetwork(printer.mac) };
}
