import type { AdComputer } from './ad.service.js';
import { searchComputers } from './ad.service.js';
import type { RemoteAccessConnection } from './remote-access.service.js';
import { remoteAccessService } from './remote-access.service.js';

// Sincronização Active Directory → Guacamole (Onda 4, subtarefa 4).
//
// Lê os computadores do AD (`searchComputers`, já aprovado na Onda 3) e faz
// o catálogo de conexões RDP do Guacamole refletir essa lista.
//
// ────────────────────────────────────────────────────────────────────────
// A ÂNCORA — a decisão que define este arquivo
// ────────────────────────────────────────────────────────────────────────
// A correlação é pelo `objectGUID` do computador, gravado no parâmetro
// `ad-object-guid` da conexão (ver AD_OBJECT_GUID_PARAM). Duas razões, e as
// duas foram verificadas contra o sistema real, não deduzidas:
//
//   - `objectGUID` é IMUTÁVEL: sobrevive a renomeação da máquina e a
//     mudança de OU. O nome não sobrevive nem à primeira — casar por nome
//     faria uma máquina renomeada virar uma conexão duplicada.
//   - a âncora é PARÂMETRO, não atributo: o Guacamole aceita atributo custom
//     com HTTP 200 e o descarta em silêncio (sondado). Uma âncora que não
//     grava produz duplicação a cada rodada, com sucesso reportado sempre.
//
// ────────────────────────────────────────────────────────────────────────
// REGRA DE SEGURANÇA: o sync só mexe no que ele mesmo ancorou
// ────────────────────────────────────────────────────────────────────────
// Conexão sem `ad-object-guid` é conexão criada à mão por um operador no
// Guacamole. O sync NUNCA a atualiza nem remove — ele a ignora e a reporta
// em `ignoradas`. Sem esta regra, a primeira execução apagaria todo trabalho
// manual do catálogo, e o relatório dessa execução diria "sucesso".

export interface SyncComputerOutcome {
  computerName: string;
  objectGuid: string;
  connectionIdentifier: string;
}

export interface SyncSkipped {
  computerName: string;
  reason: 'sem-object-guid' | 'sem-hostname' | 'desabilitado-no-ad';
}

export interface SyncResult {
  criadas: SyncComputerOutcome[];
  atualizadas: SyncComputerOutcome[];
  inalteradas: SyncComputerOutcome[];
  /** Conexões cujo computador não existe mais (ou foi desabilitado) no AD. */
  removidas: Array<{ connectionIdentifier: string; connectionName: string; objectGuid: string }>;
  /** Computadores do AD que o sync não conseguiu/não deve representar. */
  puladas: SyncSkipped[];
  /** Conexões do Guacamole sem âncora — criadas à mão, nunca tocadas. */
  ignoradas: Array<{ connectionIdentifier: string; connectionName: string }>;
}

// Endereço que o guacd vai usar para alcançar a máquina.
//
// `dNSHostName` é o FQDN que o próprio computador registrou no AD, e é o
// valor certo. O `name` entra como fallback porque um computador recém
// ingressado (ou com registro de DNS atrasado) pode ainda não ter o FQDN,
// e o nome curto costuma resolver pelo sufixo de busca do domínio.
//
// Deliberadamente NÃO existe fallback para endereço IP: o AD não guarda IP,
// e adivinhar um resolvendo DNS aqui gravaria no catálogo um endereço que
// envelhece — o mesmo erro que o `ipOverride` das impressoras documenta na
// Onda 2 ("curativo que envelhece"; a correção certa é reserva de DHCP).
export function resolveTargetHost(computer: AdComputer): string | null {
  return computer.dnsHostName ?? (computer.name.length > 0 ? computer.name : null);
}

function connectionNameFor(computer: AdComputer): string {
  return computer.name;
}

// Um computador só vira conexão se estiver habilitado no AD.
//
// `enabled === null` (userAccountControl ilegível) conta como NÃO habilitado
// aqui, e a direção importa: este módulo dá acesso à tela de uma máquina, e
// a Onda 3 já fixou a regra de nunca falhar ABERTO num campo de controle de
// acesso que não se conseguiu ler. O custo de errar para o lado fechado é
// uma conexão que falta e aparece no relatório; para o lado aberto, é uma
// conexão que não deveria existir.
function isEligible(computer: AdComputer): boolean {
  return computer.enabled === true;
}

export async function syncComputersToGuacamole(): Promise<SyncResult> {
  const computers = await searchComputers();
  const connections = await remoteAccessService.listConnectionsWithAnchors();

  const result: SyncResult = {
    criadas: [],
    atualizadas: [],
    inalteradas: [],
    removidas: [],
    puladas: [],
    ignoradas: [],
  };

  // Índice das conexões ANCORADAS. As sem âncora saem daqui direto para
  // `ignoradas` e não participam de mais nada (regra de segurança do topo).
  const porGuid = new Map<string, RemoteAccessConnection>();
  for (const connection of connections) {
    if (!connection.adObjectGuid) {
      result.ignoradas.push({
        connectionIdentifier: connection.identifier,
        connectionName: connection.name,
      });
      continue;
    }
    porGuid.set(connection.adObjectGuid, connection);
  }

  const vistos = new Set<string>();

  for (const computer of computers) {
    if (!computer.objectGuid) {
      result.puladas.push({ computerName: computer.name, reason: 'sem-object-guid' });
      continue;
    }
    if (!isEligible(computer)) {
      // Não entra em `vistos`: um computador desabilitado cai no laço de
      // remoção abaixo, então desabilitar no AD revoga o acesso remoto.
      result.puladas.push({ computerName: computer.name, reason: 'desabilitado-no-ad' });
      continue;
    }

    const hostname = resolveTargetHost(computer);
    if (!hostname) {
      result.puladas.push({ computerName: computer.name, reason: 'sem-hostname' });
      continue;
    }

    vistos.add(computer.objectGuid);
    const existente = porGuid.get(computer.objectGuid);
    const nome = connectionNameFor(computer);

    if (!existente) {
      const criada = await remoteAccessService.createRdpConnection({
        name: nome,
        hostname,
        adObjectGuid: computer.objectGuid,
      });
      result.criadas.push({
        computerName: computer.name,
        objectGuid: computer.objectGuid,
        connectionIdentifier: criada.identifier,
      });
      continue;
    }

    // IDEMPOTÊNCIA: o computador já tem conexão, então ATUALIZA — nunca
    // recria. E só escreve se algo mudou de fato; uma rodada sem mudança no
    // AD não deve gerar escrita nenhuma no Guacamole.
    const precisaAtualizar = existente.name !== nome || existente.hostname !== hostname;
    const destino = {
      computerName: computer.name,
      objectGuid: computer.objectGuid,
      connectionIdentifier: existente.identifier,
    };

    if (!precisaAtualizar) {
      result.inalteradas.push(destino);
      continue;
    }

    await remoteAccessService.updateRdpConnection(existente.identifier, {
      name: nome,
      hostname,
      adObjectGuid: computer.objectGuid,
    });
    result.atualizadas.push(destino);
  }

  // Conexão ancorada cujo computador não apareceu na varredura de máquinas
  // elegíveis: saiu do AD, ou foi desabilitada.
  //
  // REMOVER, não desabilitar — e a escolha foi VERIFICADA, não presumida:
  // o histórico de sessão do Guacamole não é filho da conexão. Em
  // `guacamole_connection_history`, `connection_id` é ON DELETE SET NULL e
  // `connection_name` é uma cópia NOT NULL. Confirmado por experimento
  // contra o banco real (2026-09-15): depois de apagar a conexão, a linha do
  // histórico permanece, com usuário, nome da conexão e datas intactos — só
  // o `connection_id` vira NULL. Ou seja, remover corta o acesso sem apagar
  // o rastro de quem acessou aquela máquina no passado. Se o histórico
  // caísse junto, a decisão certa seria desabilitar em vez de remover.
  // (O log de auditoria deste projeto é um segundo rastro, independente.)
  for (const [guid, connection] of porGuid) {
    if (vistos.has(guid)) continue;
    await remoteAccessService.deleteConnection(connection.identifier);
    result.removidas.push({
      connectionIdentifier: connection.identifier,
      connectionName: connection.name,
      objectGuid: guid,
    });
  }

  return result;
}

export const remoteAccessSyncService = {
  syncComputersToGuacamole,
};
