import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AdComputer } from '../../src/services/ad.service.js';

// Testes de src/services/remote-access-sync.service.ts (Onda 4, subtarefa 4).
//
// Mock na camada de SERVIÇO (ad.service e remote-access.service), nunca na
// implementação interna deles — regra do harness do projeto.

const searchComputers = vi.fn<() => Promise<AdComputer[]>>();
const listConnectionsWithAnchors = vi.fn();
const createRdpConnection = vi.fn();
const updateRdpConnection = vi.fn();
const deleteConnection = vi.fn();

vi.mock('../../src/services/ad.service.js', () => ({
  searchComputers: (...args: unknown[]) => searchComputers(...(args as [])),
}));

vi.mock('../../src/services/remote-access.service.js', () => ({
  remoteAccessService: {
    listConnectionsWithAnchors: (...args: unknown[]) => listConnectionsWithAnchors(...args),
    createRdpConnection: (...args: unknown[]) => createRdpConnection(...args),
    updateRdpConnection: (...args: unknown[]) => updateRdpConnection(...args),
    deleteConnection: (...args: unknown[]) => deleteConnection(...args),
  },
}));

const { syncComputersToGuacamole, resolveTargetHost } = await import(
  '../../src/services/remote-access-sync.service.js'
);

function computer(overrides: Partial<AdComputer> = {}): AdComputer {
  return {
    dn: 'CN=PC-01,OU=EvokAudio,DC=evokaudio,DC=local',
    name: 'PC-01',
    sAMAccountName: 'PC-01$',
    dnsHostName: 'pc-01.evokaudio.local',
    operatingSystem: 'Windows 11 Pro',
    operatingSystemVersion: '10.0',
    description: null,
    enabled: true,
    isDomainController: false,
    objectGuid: 'guid-pc-01',
    ...overrides,
  };
}

function connection(overrides: Record<string, unknown> = {}) {
  return {
    identifier: '1',
    name: 'PC-01',
    protocol: 'rdp',
    hostname: 'pc-01.evokaudio.local',
    activeConnections: 0,
    adObjectGuid: 'guid-pc-01',
    ...overrides,
  };
}

beforeEach(() => {
  searchComputers.mockReset();
  listConnectionsWithAnchors.mockReset();
  createRdpConnection.mockReset();
  updateRdpConnection.mockReset();
  deleteConnection.mockReset();
  createRdpConnection.mockResolvedValue({ identifier: '99' });
  updateRdpConnection.mockResolvedValue({ identifier: '1' });
  deleteConnection.mockResolvedValue({ removed: true });
});

describe('idempotência — o coração desta subtarefa', () => {
  it('computador novo vira conexão nova, ancorada pelo objectGUID', async () => {
    searchComputers.mockResolvedValue([computer()]);
    listConnectionsWithAnchors.mockResolvedValue([]);

    const result = await syncComputersToGuacamole();

    expect(createRdpConnection).toHaveBeenCalledWith({
      name: 'PC-01',
      hostname: 'pc-01.evokaudio.local',
      adObjectGuid: 'guid-pc-01',
    });
    expect(result.criadas).toHaveLength(1);
    expect(result.atualizadas).toHaveLength(0);
  });

  it('rodar duas vezes NÃO duplica: a segunda rodada não escreve nada', async () => {
    // Esta é a garantia que o usuário pediu explicitamente. A simulação é a
    // real: a primeira rodada cria, a segunda encontra a conexão ancorada.
    searchComputers.mockResolvedValue([computer()]);
    listConnectionsWithAnchors.mockResolvedValueOnce([]).mockResolvedValueOnce([connection()]);

    const primeira = await syncComputersToGuacamole();
    const segunda = await syncComputersToGuacamole();

    expect(primeira.criadas).toHaveLength(1);
    expect(segunda.criadas).toHaveLength(0);
    expect(segunda.inalteradas).toHaveLength(1);
    // Nenhuma escrita na segunda rodada: nem create, nem update, nem delete.
    expect(createRdpConnection).toHaveBeenCalledTimes(1);
    expect(updateRdpConnection).not.toHaveBeenCalled();
    expect(deleteConnection).not.toHaveBeenCalled();
  });

  it('computador RENOMEADO é atualizado, não recriado — a âncora sobrevive ao nome', async () => {
    // O caso que mata a alternativa "casar por nome": o objectGUID não muda,
    // então a conexão existente é reaproveitada. Casando por nome, isto aqui
    // viraria uma conexão duplicada e a antiga ficaria órfã para sempre.
    searchComputers.mockResolvedValue([
      computer({ name: 'PC-01-NOVO-NOME', dnsHostName: 'pc-01-novo-nome.evokaudio.local' }),
    ]);
    listConnectionsWithAnchors.mockResolvedValue([connection()]);

    const result = await syncComputersToGuacamole();

    expect(createRdpConnection).not.toHaveBeenCalled();
    expect(updateRdpConnection).toHaveBeenCalledWith('1', {
      name: 'PC-01-NOVO-NOME',
      hostname: 'pc-01-novo-nome.evokaudio.local',
      adObjectGuid: 'guid-pc-01',
    });
    expect(result.atualizadas).toHaveLength(1);
  });

  it('mudança só de hostname também atualiza', async () => {
    searchComputers.mockResolvedValue([computer({ dnsHostName: 'outro.evokaudio.local' })]);
    listConnectionsWithAnchors.mockResolvedValue([connection()]);

    const result = await syncComputersToGuacamole();

    expect(updateRdpConnection).toHaveBeenCalledTimes(1);
    expect(result.atualizadas).toHaveLength(1);
  });
});

describe('computador que saiu do AD', () => {
  it('conexão ancarada sem computador correspondente é REMOVIDA', async () => {
    searchComputers.mockResolvedValue([]);
    listConnectionsWithAnchors.mockResolvedValue([connection()]);

    const result = await syncComputersToGuacamole();

    expect(deleteConnection).toHaveBeenCalledWith('1');
    expect(result.removidas).toEqual([
      { connectionIdentifier: '1', connectionName: 'PC-01', objectGuid: 'guid-pc-01' },
    ]);
  });

  it('computador DESABILITADO no AD perde a conexão (revogação de acesso)', async () => {
    searchComputers.mockResolvedValue([computer({ enabled: false })]);
    listConnectionsWithAnchors.mockResolvedValue([connection()]);

    const result = await syncComputersToGuacamole();

    expect(deleteConnection).toHaveBeenCalledWith('1');
    expect(result.removidas).toHaveLength(1);
    expect(result.puladas).toEqual([{ computerName: 'PC-01', reason: 'desabilitado-no-ad' }]);
  });

  it('enabled null (UAC ilegível) falha FECHADO: não cria conexão', async () => {
    // Direção deliberada, herdada da Onda 3: num módulo de controle de
    // acesso, nunca afirmar "habilitado" sobre o que não se conseguiu ler.
    searchComputers.mockResolvedValue([computer({ enabled: null })]);
    listConnectionsWithAnchors.mockResolvedValue([]);

    const result = await syncComputersToGuacamole();

    expect(createRdpConnection).not.toHaveBeenCalled();
    expect(result.puladas).toEqual([{ computerName: 'PC-01', reason: 'desabilitado-no-ad' }]);
  });
});

describe('regra de segurança — o sync só mexe no que ele mesmo ancorou', () => {
  it('conexão SEM âncora (criada à mão) nunca é removida nem atualizada', async () => {
    // Sem esta regra, a primeira execução do sync apagaria todo trabalho
    // manual no catálogo do Guacamole — e o relatório diria "sucesso".
    searchComputers.mockResolvedValue([]);
    listConnectionsWithAnchors.mockResolvedValue([
      connection({ identifier: '5', name: 'Servidor-feito-a-mao', adObjectGuid: null }),
    ]);

    const result = await syncComputersToGuacamole();

    expect(deleteConnection).not.toHaveBeenCalled();
    expect(updateRdpConnection).not.toHaveBeenCalled();
    expect(result.ignoradas).toEqual([
      { connectionIdentifier: '5', connectionName: 'Servidor-feito-a-mao' },
    ]);
    expect(result.removidas).toHaveLength(0);
  });

  it('uma conexão manual com o MESMO nome de um computador do AD não é sequestrada', async () => {
    // Casar por nome sequestraria a conexão manual. Casando por âncora, o
    // computador ganha a própria conexão e a manual fica intacta.
    searchComputers.mockResolvedValue([computer()]);
    listConnectionsWithAnchors.mockResolvedValue([
      connection({ identifier: '5', name: 'PC-01', adObjectGuid: null }),
    ]);

    const result = await syncComputersToGuacamole();

    expect(createRdpConnection).toHaveBeenCalledTimes(1);
    expect(updateRdpConnection).not.toHaveBeenCalled();
    expect(deleteConnection).not.toHaveBeenCalled();
    expect(result.ignoradas).toHaveLength(1);
  });
});

describe('computadores que o sync não representa', () => {
  it('sem objectGuid é pulado, não criado com âncora vazia', async () => {
    searchComputers.mockResolvedValue([computer({ objectGuid: null })]);
    listConnectionsWithAnchors.mockResolvedValue([]);

    const result = await syncComputersToGuacamole();

    expect(createRdpConnection).not.toHaveBeenCalled();
    expect(result.puladas).toEqual([{ computerName: 'PC-01', reason: 'sem-object-guid' }]);
  });

  it('sem dnsHostName cai para o nome curto', async () => {
    searchComputers.mockResolvedValue([computer({ dnsHostName: null })]);
    listConnectionsWithAnchors.mockResolvedValue([]);

    await syncComputersToGuacamole();

    expect(createRdpConnection).toHaveBeenCalledWith(
      expect.objectContaining({ hostname: 'PC-01' }),
    );
  });

  it('sem nenhum endereço utilizável é pulado', async () => {
    searchComputers.mockResolvedValue([computer({ dnsHostName: null, name: '' })]);
    listConnectionsWithAnchors.mockResolvedValue([]);

    const result = await syncComputersToGuacamole();

    expect(createRdpConnection).not.toHaveBeenCalled();
    expect(result.puladas).toEqual([{ computerName: '', reason: 'sem-hostname' }]);
  });
});

describe('resolveTargetHost', () => {
  it('prefere o FQDN do AD', () => {
    expect(resolveTargetHost(computer())).toBe('pc-01.evokaudio.local');
  });

  it('cai para o nome curto quando não há FQDN', () => {
    expect(resolveTargetHost(computer({ dnsHostName: null }))).toBe('PC-01');
  });

  it('devolve null quando não há nem FQDN nem nome', () => {
    expect(resolveTargetHost(computer({ dnsHostName: null, name: '' }))).toBeNull();
  });
});

describe('relatório da sincronização', () => {
  it('classifica cada computador exatamente uma vez', async () => {
    searchComputers.mockResolvedValue([
      computer({ name: 'NOVO', objectGuid: 'guid-novo' }),
      computer({ name: 'IGUAL', objectGuid: 'guid-igual' }),
      computer({ name: 'MUDOU', objectGuid: 'guid-mudou', dnsHostName: 'mudou.novo.local' }),
    ]);
    listConnectionsWithAnchors.mockResolvedValue([
      connection({ identifier: '2', name: 'IGUAL', adObjectGuid: 'guid-igual' }),
      connection({ identifier: '3', name: 'MUDOU', adObjectGuid: 'guid-mudou' }),
      connection({ identifier: '4', name: 'SUMIU', adObjectGuid: 'guid-sumiu' }),
    ]);

    const result = await syncComputersToGuacamole();

    expect(result.criadas.map((c) => c.computerName)).toEqual(['NOVO']);
    expect(result.inalteradas.map((c) => c.computerName)).toEqual(['IGUAL']);
    expect(result.atualizadas.map((c) => c.computerName)).toEqual(['MUDOU']);
    expect(result.removidas.map((c) => c.objectGuid)).toEqual(['guid-sumiu']);
  });
});
