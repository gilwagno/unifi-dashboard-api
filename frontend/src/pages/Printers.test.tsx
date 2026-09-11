import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthProvider } from '../context/AuthContext';
import { Printers } from './Printers';
import type { PrinterConsumablesResponse, PrinterWithNetwork } from '../lib/api';

vi.mock('../lib/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/api')>();
  return {
    ...actual,
    api: {
      listSites: vi.fn(),
      listPrinters: vi.fn(),
      getPrinter: vi.fn(),
      createPrinter: vi.fn(),
      updatePrinter: vi.fn(),
      deletePrinter: vi.fn(),
      reconnectPrinter: vi.fn(),
      rebootPrinter: vi.fn(),
      // Default resolvido (não um vi.fn() vazio): a página busca consumíveis
      // de TODA impressora assim que a lista carrega (badge de toner na
      // linha da lista), não só quando o usuário clica em "Ver
      // consumíveis" — testes que não se importam com consumíveis não
      // precisam configurar isso individualmente para não quebrar.
      getPrinterConsumables: vi.fn(async () => ({
        printerId: 'unused',
        collectedAt: null,
        pageCount: null,
        lowThresholdPct: null,
        source: 'live' as const,
        supplies: [],
      })),
      setClientAlias: vi.fn(),
      changeAdminPassword: vi.fn(),
    },
    getAccessToken: () => null,
  };
});

import { AdminPasswordAmbiguousError, api, ApiError } from '../lib/api';

function renderPrinters() {
  return render(
    <AuthProvider>
      <MemoryRouter>
        <Printers />
      </MemoryRouter>
    </AuthProvider>,
  );
}

const PRINTER_INTEGRATION: PrinterWithNetwork = {
  id: 'p1',
  name: 'HPLaserMFP135w',
  mac: '50:81:40:d8:6c:7e',
  ipOverride: null,
  snmpVersion: 'v2c',
  maintenance: { intervalDays: null, intervalPages: null, consumableLowThresholdPct: null },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  network: { source: 'integration', online: true, ipAddress: '172.16.0.89', connectionType: 'WIRED', alias: null },
};

const PRINTER_CLASSIC: PrinterWithNetwork = {
  id: 'p2',
  name: 'HLL2360DWVENDAS',
  mac: 'e8:6f:38:ba:b9:32',
  ipOverride: null,
  snmpVersion: 'v1',
  maintenance: { intervalDays: null, intervalPages: null, consumableLowThresholdPct: 20 },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  network: { source: 'classic', online: null, ipAddress: '172.16.0.222', connectionType: 'WIRED', alias: null },
};

const PRINTER_UNKNOWN: PrinterWithNetwork = {
  id: 'p3',
  name: 'BRW849E567E0445',
  mac: '84:9e:56:7e:04:45',
  ipOverride: null,
  snmpVersion: 'v2c',
  maintenance: { intervalDays: null, intervalPages: null, consumableLowThresholdPct: null },
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  network: { source: 'unknown', online: null, ipAddress: null, connectionType: null, alias: null },
};

function mockSites() {
  vi.mocked(api.listSites).mockResolvedValue({ data: [{ id: 's1', name: 'Site 1' }] });
}

// Flusha a fila de microtasks várias vezes seguidas — necessário com fake
// timers ativos, porque a carga inicial passa por mais de um `.then()` em
// cadeia (Layout carregando sites + Printers carregando a lista) e uma única
// volta de `advanceTimersByTimeAsync(0)` só libera um nível da cadeia por vez.
async function flushMicrotasks() {
  for (let i = 0; i < 10; i += 1) {
    await vi.advanceTimersByTimeAsync(0);
  }
}

describe('Printers page', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
    sessionStorage.clear();
    mockSites();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('renders the printer list with the right network indicator for integration/classic/unknown sources', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION, PRINTER_CLASSIC, PRINTER_UNKNOWN]);

    renderPrinters();

    expect(await screen.findByText('HPLaserMFP135w')).toBeInTheDocument();
    expect(screen.getByText('HLL2360DWVENDAS')).toBeInTheDocument();
    expect(screen.getByText('BRW849E567E0445')).toBeInTheDocument();

    expect(screen.getByText(/Online · 172\.16\.0\.89/)).toBeInTheDocument();
    // ACHADO AO VIVO (sessão de continuação): a melhoria que faz o backend
    // cruzar a API clássica com stat/sta (online/offline real, não mais
    // sempre desconhecido) tinha suíte verde nos dois lados (backend e
    // frontend) mas a tela continuava sempre mostrando "online desconhecido"
    // pra fontes "classic" de qualquer jeito — o componente nunca olhava pro
    // valor de `network.online`, só pro `network.source`. Sem este teste
    // (que usa `online: null` de propósito, único caso em que o texto
    // continua sendo "desconhecido"), o bug passava despercebido.
    expect(screen.getByText(/Conhecida pelo controller · Online desconhecido · 172\.16\.0\.222/)).toBeInTheDocument();
    expect(screen.getByText('Status de rede desconhecido')).toBeInTheDocument();
  });

  it('mostra Online/Offline de verdade pra fonte "classic" quando o backend já sabe (stat/sta)', async () => {
    const classicOnline: PrinterWithNetwork = {
      ...PRINTER_CLASSIC,
      id: 'p2-online',
      network: { ...PRINTER_CLASSIC.network, online: true },
    };
    const classicOffline: PrinterWithNetwork = {
      ...PRINTER_CLASSIC,
      id: 'p2-offline',
      name: 'DCP-1610NW',
      network: { ...PRINTER_CLASSIC.network, online: false },
    };
    vi.mocked(api.listPrinters).mockResolvedValue([classicOnline, classicOffline]);

    renderPrinters();

    expect(await screen.findByText(/Conhecida pelo controller · Online · 172\.16\.0\.222/)).toBeInTheDocument();
    expect(screen.getByText(/Conhecida pelo controller · Offline · 172\.16\.0\.222/)).toBeInTheDocument();
  });

  // Pedido do usuário: ver o nível de CADA suprimento, colorido, "de cara"
  // na linha da lista (um medidor vertical por cartucho, tipo o app de uma
  // fabricante) — sem precisar clicar em "Ver consumíveis". Por isso a
  // busca de consumíveis passou a ser ANTECIPADA (toda impressora da
  // lista, assim que ela carrega), não mais sob demanda. "Ver consumíveis"
  // continua existindo pro detalhe completo, mas reaproveita o mesmo dado
  // já buscado (não refaz a chamada).
  it('busca consumíveis de toda impressora assim que a lista carrega, mostra um medidor por suprimento na linha, e expandir reaproveita o mesmo dado (sem refazer a chamada)', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    const consumablesResponse: PrinterConsumablesResponse = {
      printerId: 'p1',
      collectedAt: '2026-08-31T12:00:00.000Z',
      pageCount: 1234,
      lowThresholdPct: null,
      source: 'live' as const,
      supplies: [
        { name: 'Black Toner', serialNumber: null, levelPercent: 42, status: 'ok' },
        { name: 'Waste Toner Box', serialNumber: null, levelPercent: null, status: 'unknown' },
        { name: 'Fuser', serialNumber: null, levelPercent: null, status: 'not-measured' },
      ],
    };
    vi.mocked(api.getPrinterConsumables).mockResolvedValue(consumablesResponse);

    const user = userEvent.setup();
    renderPrinters();

    await screen.findByText('HPLaserMFP135w');
    // Busca automática — sem clicar em nada, já chamou.
    await waitFor(() => expect(api.getPrinterConsumables).toHaveBeenCalledWith('p1'));
    // Medidor na linha da lista: "Black Toner" é o único suprimento com
    // percentual conhecido (os outros dois são null, sem medidor pra
    // eles), então é o único que aparece — mesmo antes de expandir o card.
    expect(await screen.findByTitle('Black Toner: 42%')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Ver consumíveis/ }));

    expect(await screen.findByText('Black Toner')).toBeInTheDocument();
    // Reaproveita o dado já buscado — nenhuma chamada nova ao expandir.
    expect(api.getPrinterConsumables).toHaveBeenCalledTimes(1);

    // "42%" aparece 2x agora: o rótulo pequeno do medidor da linha (sempre
    // visível) + o número grande do detalhe expandido.
    expect(screen.getAllByText('42%')).toHaveLength(2);
    const supplyRows = screen.getAllByText('sem dado');
    expect(supplyRows).toHaveLength(2);
    expect(screen.queryByText('0%')).not.toBeInTheDocument();
    expect(screen.queryByText('NaN%')).not.toBeInTheDocument();
    expect(screen.getByText('Desconhecido')).toBeInTheDocument();
    expect(screen.getByText('Sem medição')).toBeInTheDocument();

    // Toggling again should not refetch (cached).
    await user.click(screen.getByRole('button', { name: /Ver consumíveis/ }));
    await user.click(screen.getByRole('button', { name: /Ver consumíveis/ }));
    expect(api.getPrinterConsumables).toHaveBeenCalledTimes(1);
  });

  // Achado real do usuário testando ao vivo, contra a impressora real: o
  // toner preto estava em 0% mas o medidor compacto da linha mostrava 3
  // barras — a 0% e DUAS a 100% — sem nenhum rótulo visível, dando a
  // impressão de "a maioria está bem". As duas de 100% eram rolos do ADF
  // (alimentador de documentos do scanner, não afeta impressão nenhuma). O
  // medidor compacto não deve misturar peça de scanner com toner de verdade.
  // O backend passou a servir a última leitura PERSISTIDA quando o buffer em
  // memória do poller está vazio (o caso normal logo depois de todo restart).
  // Exibir esse dado sem dizer que ele não é o estado corrente seria trocar
  // uma afirmação falsa ("nunca coletado") por outra ("isto é agora").
  it('marca "do histórico" quando a leitura veio do disco, e NÃO marca quando é ao vivo', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.getPrinterConsumables).mockResolvedValue({
      printerId: 'p1',
      collectedAt: '2026-09-11T11:54:06.370Z',
      pageCount: 4821,
      lowThresholdPct: 15,
      source: 'history' as const,
      supplies: [{ name: 'Black Toner', serialNumber: null, levelPercent: 8, status: 'low' }],
    });
    const user = userEvent.setup();
    renderPrinters();
    await user.click(await screen.findByRole('button', { name: /Ver consumíveis/ }));

    expect(await screen.findByText('do histórico')).toBeInTheDocument();
  });

  it('não marca "do histórico" quando a leitura é ao vivo', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.getPrinterConsumables).mockResolvedValue({
      printerId: 'p1',
      collectedAt: '2026-09-11T12:15:16.831Z',
      pageCount: 4615,
      lowThresholdPct: 15,
      source: 'live' as const,
      supplies: [{ name: 'Black Toner', serialNumber: null, levelPercent: 70, status: 'ok' }],
    });
    const user = userEvent.setup();
    renderPrinters();
    await user.click(await screen.findByRole('button', { name: /Ver consumíveis/ }));

    // "Páginas impressas" aparece duas vezes na tela (o StatCard da frota e o
    // detalhe do card) — ancora no valor do detalhe, que é único.
    expect(await screen.findByText('4615')).toBeInTheDocument();
    expect(screen.queryByText('do histórico')).not.toBeInTheDocument();
  });

  it('não mostra peças do ADF no medidor compacto da linha, mesmo com percentual conhecido — só no detalhe expandido', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.getPrinterConsumables).mockResolvedValue({
      printerId: 'p1',
      collectedAt: '2026-09-10T16:44:02.000Z',
      pageCount: 59934,
      lowThresholdPct: 15,
      source: 'live' as const,
      supplies: [
        { name: 'Black Toner', serialNumber: 'CRUM-210729A5BB3', levelPercent: 0, status: 'low' },
        { name: 'Transfer Roller', serialNumber: null, levelPercent: null, status: 'not-measured' },
        { name: 'Fuser Life', serialNumber: null, levelPercent: null, status: 'not-measured' },
        { name: 'Pick-up Roller', serialNumber: null, levelPercent: null, status: 'not-measured' },
        { name: 'ADF Roller', serialNumber: null, levelPercent: 100, status: 'ok' },
        { name: 'ADF Rubber Pad', serialNumber: null, levelPercent: 100, status: 'ok' },
      ],
    });

    const user = userEvent.setup();
    renderPrinters();

    await screen.findByText('HPLaserMFP135w');
    expect(await screen.findByTitle('Black Toner: 0%')).toBeInTheDocument();
    expect(screen.queryByTitle(/ADF Roller:/)).not.toBeInTheDocument();
    expect(screen.queryByTitle(/ADF Rubber Pad:/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /Ver consumíveis/ }));
    expect(await screen.findByText('ADF Roller')).toBeInTheDocument();
    expect(screen.getByText('ADF Rubber Pad')).toBeInTheDocument();
  });

  // Achado da revisão crítica: o medidor compacto existe pra mostrar "de
  // relance, com cor, se precisa trocar" — mas o realce de toner BAIXO não
  // tinha teste nenhum. Mutante executado (`const isLow = false`): suíte
  // 50/50 verde, ou seja, dava pra apagar o único sinal visual de alerta da
  // tela de lista sem nenhuma linha vermelha. Como a diferença é só de
  // classe CSS (anel e texto avermelhados), o teste compara o suprimento
  // 'low' com um 'ok' na MESMA leitura: exige que sejam distinguíveis, sem
  // cravar o valor exato da cor.
  it('destaca visualmente no medidor compacto o suprimento em nível baixo, e só ele', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.getPrinterConsumables).mockResolvedValue({
      printerId: 'p1',
      collectedAt: '2026-09-10T16:44:02.000Z',
      pageCount: 59934,
      lowThresholdPct: 15,
      source: 'live' as const,
      supplies: [
        // Os dois nomes caem no MESMO preenchimento neutro
        // (`NEUTRAL_SUPPLY_FILL`) de propósito: se um fosse "Black Toner", a
        // cor do tubo já os diferenciaria e o teste passaria mesmo com o
        // realce de "baixo" apagado — foi assim que a primeira versão deste
        // teste deixou o mutante `isLow = false` sobreviver.
        { name: 'Fuser Life', serialNumber: null, levelPercent: 4, status: 'low' },
        { name: 'Transfer Roller', serialNumber: null, levelPercent: 80, status: 'ok' },
      ],
    });

    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    const baixo = await screen.findByTitle('Fuser Life: 4%');
    const normal = await screen.findByTitle('Transfer Roller: 80%');

    // Normaliza tudo que é PERCENTUAL (altura do preenchimento e rótulo) para
    // que a única diferença que possa sobrar seja o realce de "baixo".
    const semPercentual = (el: HTMLElement) => el.innerHTML.replace(/\d+(\.\d+)?%/g, 'N%');

    expect(semPercentual(baixo)).not.toEqual(semPercentual(normal));
  });

  // Achado real do usuário testando ao vivo: o poller SNMP do backend
  // coleta a cada 15min, e a lista de impressoras já recarrega sozinha a
  // cada 60s (usePolling) — mas o medidor de toner da linha ficava preso no
  // retrato da PRIMEIRA busca pra sempre (ex.: buscada antes da primeira
  // coleta do poller, "nunca coletado"), porque nada disparava uma busca
  // nova depois. Reproduz o cenário exato: busca inicial sem dado, poller
  // coleta de verdade, ciclo de polling da lista passa, medidor aparece —
  // sem nenhum clique manual do usuário.
  it('atualiza o medidor de toner sozinho depois de um ciclo de polling, quando o poller coleta dado novo', async () => {
    // `mockResolvedValueOnce` (não `mockResolvedValue` com um array fixo)
    // pra cada ciclo — um array literal reaproveitado pelas DUAS chamadas
    // seria a MESMA referência em `printers`, e o React ignoraria o
    // segundo `setPrinters` por `Object.is` achar "nada mudou", mascarando
    // o próprio bug que este teste existe pra travar (na produção, cada
    // resposta HTTP real desserializa um array NOVO, então isso nunca
    // acontece de verdade — é só um detalhe do mock).
    vi.mocked(api.listPrinters).mockResolvedValueOnce([PRINTER_INTEGRATION]);
    vi.mocked(api.listPrinters).mockResolvedValueOnce([{ ...PRINTER_INTEGRATION }]);
    vi.mocked(api.getPrinterConsumables).mockResolvedValueOnce({
      printerId: 'p1',
      collectedAt: null,
      pageCount: null,
      lowThresholdPct: null,
      source: 'live' as const,
      supplies: [],
    });

    vi.useFakeTimers();
    renderPrinters();
    await flushMicrotasks();

    expect(screen.queryByTitle(/Black Toner:/)).not.toBeInTheDocument();

    vi.mocked(api.getPrinterConsumables).mockResolvedValueOnce({
      printerId: 'p1',
      collectedAt: '2026-09-10T16:48:24.000Z',
      pageCount: 500,
      lowThresholdPct: null,
      source: 'live' as const,
      supplies: [{ name: 'Black Toner', serialNumber: null, levelPercent: 55, status: 'ok' }],
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    // `screen.getByTitle` síncrono (não `findByTitle`) — com fake timers
    // ativos, o `waitFor` interno do `findBy*` não teria como avançar
    // sozinho; `flushMicrotasks` acima já garantiu que o estado assentou.
    expect(screen.getByTitle('Black Toner: 55%')).toBeInTheDocument();
    expect(api.getPrinterConsumables).toHaveBeenCalledTimes(2);
  });

  describe('painel de saúde da frota', () => {
    it('mostra tudo em dia quando todas online e sem toner baixo', async () => {
      vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
      vi.mocked(api.getPrinterConsumables).mockResolvedValue({
        printerId: 'p1',
        collectedAt: '2026-08-31T12:00:00.000Z',
        pageCount: 500,
        lowThresholdPct: null,
        source: 'live' as const,
        supplies: [{ name: 'Black Toner', serialNumber: null, levelPercent: 90, status: 'ok' }],
      });

      renderPrinters();

      await screen.findByText('HPLaserMFP135w');
      expect(await screen.findByText('1/1')).toBeInTheDocument();
      expect(screen.getByText('todas operacionais')).toBeInTheDocument();
      // "Precisa de atenção" com valor 0 — o StatCard mostra label e valor em
      // spans irmãos de níveis diferentes, por isso sobe até o card inteiro
      // (`.rounded-xl`) e busca o valor DENTRO dele, não como texto solto na
      // tela (que colidiria com outros "0"/"1" de outros cards).
      const attentionCard = screen.getByText('Precisa de atenção').closest('.rounded-xl') as HTMLElement | null;
      expect(attentionCard).not.toBeNull();
      expect(within(attentionCard!).getByText('0')).toBeInTheDocument();
      expect(screen.getByText('tudo em dia')).toBeInTheDocument();
    });

    it('"Precisa de atenção" conta cada impressora uma vez só, mesmo com mais de um sinal (offline E toner baixo)', async () => {
      const offlineWithLowToner: PrinterWithNetwork = {
        ...PRINTER_CLASSIC,
        network: { ...PRINTER_CLASSIC.network, online: false },
      };
      vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION, offlineWithLowToner]);
      vi.mocked(api.getPrinterConsumables).mockImplementation(async (id: string) =>
        id === 'p1'
          ? {
              printerId: 'p1',
              collectedAt: '2026-08-31T12:00:00.000Z',
              pageCount: 500,
              lowThresholdPct: null,
              source: 'live' as const,
              supplies: [{ name: 'Black Toner', serialNumber: null, levelPercent: 90, status: 'ok' }],
            }
          : {
              // A mesma impressora está OFFLINE *e* com toner baixo — só deve
              // contar 1 vez em "Precisa de atenção", não 2.
              printerId: 'p2',
              collectedAt: '2026-08-31T12:00:00.000Z',
              pageCount: 500,
              lowThresholdPct: 20,
              source: 'live' as const,
              supplies: [{ name: 'Toner Preto', serialNumber: null, levelPercent: 5, status: 'low' }],
            },
      );

      renderPrinters();

      await screen.findByText('HPLaserMFP135w');
      expect(await screen.findByText('1/2')).toBeInTheDocument();
      expect(screen.getByText('1 offline')).toBeInTheDocument();
      const attentionCard = screen.getByText('Precisa de atenção').closest('.rounded-xl') as HTMLElement | null;
      expect(attentionCard).not.toBeNull();
      expect(within(attentionCard!).getByText('1')).toBeInTheDocument();
      // Achado do usuário testando ao vivo: um número sozinho não diz QUAL
      // impressora nem POR QUÊ — o texto precisa nomear a impressora e
      // listar os dois motivos (offline, toner baixo), não um aviso genérico.
      expect(within(attentionCard!).getByText('HLL2360DWVENDAS (offline, toner baixo)')).toBeInTheDocument();
    });

    it('não mostra o painel quando não há impressora nenhuma cadastrada', async () => {
      vi.mocked(api.listPrinters).mockResolvedValue([]);
      renderPrinters();
      await screen.findByText('Nenhuma impressora cadastrada.');
      expect(screen.queryByText('Precisa de atenção')).not.toBeInTheDocument();
    });
  });

  it('shows the serial number under a supply when the backend reports one, and hides the line when it does not', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    const consumablesResponse: PrinterConsumablesResponse = {
      printerId: 'p1',
      collectedAt: '2026-08-31T12:00:00.000Z',
      pageCount: 1234,
      lowThresholdPct: null,
      source: 'live' as const,
      supplies: [
        { name: 'Black Toner', serialNumber: 'CRUM-210729A5BB3', levelPercent: 55, status: 'ok' },
        { name: 'Drum Unit', serialNumber: null, levelPercent: 80, status: 'ok' },
      ],
    };
    vi.mocked(api.getPrinterConsumables).mockResolvedValue(consumablesResponse);

    const user = userEvent.setup();
    renderPrinters();

    await screen.findByText('HPLaserMFP135w');
    await user.click(screen.getByRole('button', { name: /Ver consumíveis/ }));

    expect(await screen.findByText('S/N: CRUM-210729A5BB3')).toBeInTheDocument();
    expect(screen.getByText('Drum Unit')).toBeInTheDocument();
    expect(screen.queryByText(/^S\/N: $/)).not.toBeInTheDocument();
  });

  it('creates a new printer with the correct snmp shape', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([]);
    vi.mocked(api.createPrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();

    await user.click(await screen.findByRole('button', { name: 'Nova impressora' }));

    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Nova Impressora');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '11:22:33:44:55:66');
    await user.type(screen.getByPlaceholderText('ex: public'), 'public');

    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));

    await waitFor(() =>
      expect(api.createPrinter).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Nova Impressora',
          mac: '11:22:33:44:55:66',
          snmp: { version: 'v2c', community: 'public' },
        }),
      ),
    );
  });

  it('calls reconnectPrinter only after confirming, never when the dialog is cancelled', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.reconnectPrinter).mockResolvedValue({ ok: true, note: 'ok' });

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(screen.getByRole('button', { name: /Reconectar/ }));
    expect(api.reconnectPrinter).not.toHaveBeenCalled();

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: /Reconectar/ }));
    await waitFor(() => expect(api.reconnectPrinter).toHaveBeenCalledWith('p1'));
  });

  // O segredo SNMP (community/senhas v3) só pode viver no estado do
  // componente. Este teste cobre os TRÊS momentos em que ele existe na
  // página: logo após ser digitado, DEPOIS DE UM SUBMIT bem-sucedido (o
  // caminho onde o valor de fato passa por handleSubmit/toSnmpInput e é
  // serializado — é aqui que um `localStorage.setItem` de debug esquecido
  // vazaria) e depois de cancelar o formulário. Cobrir só "digitou" deixa
  // o caminho mais perigoso sem rede de proteção.
  function expectNoSecretInStorage(secret: string) {
    expect(JSON.stringify(localStorage)).not.toContain(secret);
    expect(JSON.stringify(sessionStorage)).not.toContain(secret);
    for (const storage of [localStorage, sessionStorage]) {
      for (let i = 0; i < storage.length; i += 1) {
        const key = storage.key(i)!;
        expect(key).not.toContain(secret);
        expect(storage.getItem(key) ?? '').not.toContain(secret);
      }
    }
  }

  it('never persists a typed SNMP secret to storage — after typing, after submitting, or after cancelling', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([]);
    vi.mocked(api.createPrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();

    await user.click(await screen.findByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Nova Impressora');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '11:22:33:44:55:66');
    await user.type(screen.getByPlaceholderText('ex: public'), 'Unique-Community-Secret-77');

    expectNoSecretInStorage('Unique-Community-Secret-77');

    // Caminho crítico: o submit de verdade (o segredo é lido do estado,
    // montado em `snmp` e enviado). Nada disso pode encostar em storage.
    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));
    await waitFor(() => expect(api.createPrinter).toHaveBeenCalled());
    expectNoSecretInStorage('Unique-Community-Secret-77');

    // E o mesmo vale para o segredo do SNMPv3, que passa por outro ramo de
    // toSnmpInput (v3Auth) e nunca pelo campo `community`.
    await user.click(screen.getByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Impressora v3');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '22:33:44:55:66:77');
    await user.selectOptions(screen.getByDisplayValue('v2c'), 'v3');
    await user.type(screen.getByPlaceholderText('usuário'), 'snmpuser');
    // Em v3 o campo `community` não é renderizado: os campos de senha do
    // SNMP são a senha de autenticação e a de privacidade, nessa ordem. A
    // senha do PAINEL WEB (wbmCredentials) também é um input[type=password]
    // do mesmo formulário, mas é de outro domínio (credencial de admin da
    // impressora, não segredo SNMP) e tem cobertura própria mais abaixo —
    // filtramos por aria-label em vez de aumentar o número esperado, para
    // este teste continuar falhando se um campo de segredo SNMP aparecer ou
    // desaparecer.
    const v3PasswordFields = Array.from(
      document.querySelectorAll<HTMLInputElement>('input[type="password"]'),
    ).filter((input) => input.getAttribute('aria-label') !== 'Senha do painel web');
    expect(v3PasswordFields).toHaveLength(2);
    await user.type(v3PasswordFields[0], 'Unique-V3-Auth-Secret-88');
    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));
    await waitFor(() => expect(api.createPrinter).toHaveBeenCalledTimes(2));
    expectNoSecretInStorage('Unique-V3-Auth-Secret-88');

    // E depois de cancelar o formulário (campo limpo).
    await user.click(screen.getByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: public'), 'Unique-Community-Secret-99');
    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expectNoSecretInStorage('Unique-Community-Secret-99');
  });

  it('leaves the secret field empty when editing, and omits snmp from the PATCH when left blank', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.updatePrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    await user.click(screen.getByRole('button', { name: /Editar/ }));

    const communityInput = screen.getByPlaceholderText('deixe em branco para manter a atual') as HTMLInputElement;
    expect(communityInput.value).toBe('');

    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    await waitFor(() => expect(api.updatePrinter).toHaveBeenCalled());
    const [, body] = vi.mocked(api.updatePrinter).mock.calls[0];
    expect(body.snmp).toBeUndefined();
  });

  // `v3AuthSchema.username` é obrigatório no backend (z.string().min(1)).
  // Como o bloco v3 é montado quando QUALQUER credencial v3 é preenchida,
  // digitar só a senha de autenticação enviaria `username: ''` e o usuário
  // levaria um 400 do zod sem entender qual campo faltou.
  it('blocks submit with a clear message when a v3 secret is typed without the required username', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([]);

    const user = userEvent.setup();
    renderPrinters();

    await user.click(await screen.findByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Impressora v3');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '22:33:44:55:66:77');
    await user.selectOptions(screen.getByDisplayValue('v2c'), 'v3');

    const passwordFields = document.querySelectorAll<HTMLInputElement>('input[type="password"]');
    await user.type(passwordFields[0], 'segredo-sem-usuario');
    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));

    expect(await screen.findByText(/usuário SNMPv3 é obrigatório/)).toBeInTheDocument();
    expect(api.createPrinter).not.toHaveBeenCalled();
  });

  // O backend só grava `snmpVersion` junto de `snmpSecret`: um PATCH que
  // omite `snmp` não muda a versão. Trocar o select e salvar sem digitar o
  // segredo retornaria 200 sem mudar nada — precisa ser barrado, não
  // reportado como sucesso.
  it('does not silently no-op when the SNMP version changes without a new secret', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    await user.click(screen.getByRole('button', { name: /Editar/ }));
    await user.selectOptions(screen.getByDisplayValue('v2c'), 'v3');
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    expect(await screen.findByText(/mudar a versão de SNMP de v2c para v3/)).toBeInTheDocument();
    expect(api.updatePrinter).not.toHaveBeenCalled();
  });

  it('deletes a printer after confirming', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.deletePrinter).mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    await user.click(screen.getByRole('button', { name: /Remover/ }));
    await waitFor(() => expect(api.deletePrinter).toHaveBeenCalledWith('p1'));
  });

  // Achado real do usuário testando ao vivo: o rascunho pré-preenchia com o
  // nome do CADASTRO LOCAL (`printer.name`) em vez do apelido REAL no
  // UniFi (`printer.network.alias`) — duas impressoras com o mesmo
  // cadastro local podiam ter apelidos completamente diferentes no UniFi
  // (confirmado contra o controller real: "HP Laser MFP 135w (Financeiro)"
  // no cadastro local vs. "HP Laser MFP 135w (Comercial)" como apelido de
  // verdade), e o usuário não tinha como saber disso antes de editar.
  it('mostra e pré-preenche com o apelido REAL do UniFi (não o nome do cadastro local), e atualiza a tela depois de salvar', async () => {
    const printerWithDifferentAlias: PrinterWithNetwork = {
      ...PRINTER_INTEGRATION,
      network: { ...PRINTER_INTEGRATION.network, alias: 'HP Laser MFP 135w (Comercial)' },
    };
    vi.mocked(api.listPrinters).mockResolvedValue([printerWithDifferentAlias]);
    vi.mocked(api.setClientAlias).mockResolvedValue({ ok: true });

    const user = userEvent.setup();
    renderPrinters();
    const card = (await screen.findByText('HPLaserMFP135w')).closest('div.overflow-hidden') as HTMLElement;

    // Antes de editar: o apelido REAL já aparece na tela (não some, não
    // fica em branco, não mostra o nome do cadastro local).
    expect(within(card).getByText('HP Laser MFP 135w (Comercial)')).toBeInTheDocument();

    await user.click(within(card).getByRole('button', { name: 'Renomear apelido no UniFi' }));
    // O campo abre com o apelido REAL, não com "HPLaserMFP135w" (nome do
    // cadastro local) — esse era o bug.
    const input = within(card).getByDisplayValue('HP Laser MFP 135w (Comercial)');
    await user.clear(input);
    await user.type(input, 'Impressora Financeiro');
    await user.click(within(card).getByRole('button', { name: 'Salvar' }));

    await waitFor(() =>
      expect(api.setClientAlias).toHaveBeenCalledWith('50:81:40:d8:6c:7e', 'Impressora Financeiro'),
    );
    // Pedido direto do usuário: renomear embaixo tem que renomear em cima
    // também, senão cada renomeação criava um desencontro novo entre os
    // dois campos.
    await waitFor(() =>
      expect(api.updatePrinter).toHaveBeenCalledWith('p1', { name: 'Impressora Financeiro' }),
    );
    // Confirmação visível de que a ação teve efeito — sem isto, o usuário
    // não tinha como saber se a troca realmente aconteceu sem sair pro
    // painel do UniFi conferir.
    expect(
      await screen.findByText(/Nome atualizado para "Impressora Financeiro" no UniFi e no cadastro local\./),
    ).toBeInTheDocument();
    // E a lista é recarregada pra refletir o novo apelido, sem esperar o
    // próximo ciclo de polling (até 60s depois).
    await waitFor(() => expect(api.listPrinters).toHaveBeenCalledTimes(2));
  });

  // O usuário voltou a reportar "em cima Financeiro, embaixo Comercial" como
  // bug DEPOIS de a tela já rotular os dois campos. Rotular o desencontro
  // explicou, mas não deu como desfazê-lo — daí o atalho de igualar.
  describe('desencontro entre o nome do cadastro local e o Apelido no UniFi', () => {
    const printerComApelidoDivergente: PrinterWithNetwork = {
      ...PRINTER_INTEGRATION,
      network: { ...PRINTER_INTEGRATION.network, alias: 'HP Laser MFP 135w (Comercial)' },
    };

    it('oferece igualar o apelido ao cadastro, e só chama a API depois de confirmar', async () => {
      vi.mocked(api.listPrinters).mockResolvedValue([printerComApelidoDivergente]);
      vi.mocked(api.setClientAlias).mockResolvedValue({ ok: true });
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

      const user = userEvent.setup();
      renderPrinters();
      const card = (await screen.findByText('HPLaserMFP135w')).closest('div.overflow-hidden') as HTMLElement;

      await user.click(within(card).getByRole('button', { name: /Não confere — igualar a/ }));

      expect(confirmSpy).toHaveBeenCalled();
      await waitFor(() =>
        expect(api.setClientAlias).toHaveBeenCalledWith('50:81:40:d8:6c:7e', 'HPLaserMFP135w'),
      );
      confirmSpy.mockRestore();
    });

    // Duas escritas em sistemas diferentes: se a segunda falha, dizer
    // "atualizado" esconderia que metade não foi aplicada.
    it('relata sucesso PARCIAL (não sucesso) quando o apelido muda mas o cadastro local falha', async () => {
      vi.mocked(api.listPrinters).mockResolvedValue([printerComApelidoDivergente]);
      vi.mocked(api.setClientAlias).mockResolvedValue({ ok: true });
      vi.mocked(api.updatePrinter).mockRejectedValue(new ApiError(500, 'banco indisponível'));

      const user = userEvent.setup();
      renderPrinters();
      const card = (await screen.findByText('HPLaserMFP135w')).closest('div.overflow-hidden') as HTMLElement;

      await user.click(within(card).getByRole('button', { name: 'Renomear apelido no UniFi' }));
      const input = within(card).getByDisplayValue('HP Laser MFP 135w (Comercial)');
      await user.clear(input);
      await user.type(input, 'Impressora Financeiro');
      await user.click(within(card).getByRole('button', { name: 'Salvar' }));

      expect(await screen.findByText(/NÃO foi alterado/)).toBeInTheDocument();
      expect(screen.queryByText(/no UniFi e no cadastro local/)).not.toBeInTheDocument();
      // Achado da revisão crítica: sem esta linha o teste verificava só o
      // TEXTO, e trocar `setError` por `setNotice` (mutante executado) deixava
      // a suíte 50/50 verde — a falha parcial apareceria no balão NEUTRO de
      // sucesso, que é exatamente o "dizer atualizado com metade aplicada"
      // que este teste existe pra impedir.
      expect(within(screen.getByRole('alert')).getByText(/NÃO foi alterado/)).toBeInTheDocument();
      expect(screen.queryByRole('status')).not.toBeInTheDocument();
    });

    // Contrapeso do caso acima: o sucesso REAL tem que continuar caindo no
    // balão neutro, não no de erro. Sem ele, trocar `setNotice` por
    // `setError` no caminho feliz também passaria.
    it('sucesso completo nas duas escritas aparece como aviso neutro, nunca como erro', async () => {
      vi.mocked(api.listPrinters).mockResolvedValue([printerComApelidoDivergente]);
      vi.mocked(api.setClientAlias).mockResolvedValue({ ok: true });
      vi.mocked(api.updatePrinter).mockResolvedValue({ ...printerComApelidoDivergente });

      const user = userEvent.setup();
      renderPrinters();
      const card = (await screen.findByText('HPLaserMFP135w')).closest('div.overflow-hidden') as HTMLElement;

      await user.click(within(card).getByRole('button', { name: 'Renomear apelido no UniFi' }));
      const input = within(card).getByDisplayValue('HP Laser MFP 135w (Comercial)');
      await user.clear(input);
      await user.type(input, 'Impressora Financeiro');
      await user.click(within(card).getByRole('button', { name: 'Salvar' }));

      expect(await screen.findByRole('status')).toHaveTextContent(/no UniFi e no cadastro local/);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('não altera nada se o usuário cancelar a confirmação', async () => {
      vi.mocked(api.listPrinters).mockResolvedValue([printerComApelidoDivergente]);
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

      const user = userEvent.setup();
      renderPrinters();
      const card = (await screen.findByText('HPLaserMFP135w')).closest('div.overflow-hidden') as HTMLElement;

      await user.click(within(card).getByRole('button', { name: /Não confere — igualar a/ }));

      expect(api.setClientAlias).not.toHaveBeenCalled();
      confirmSpy.mockRestore();
    });

    it('não oferece igualar quando os dois nomes já batem (nada a resolver)', async () => {
      vi.mocked(api.listPrinters).mockResolvedValue([
        { ...PRINTER_INTEGRATION, network: { ...PRINTER_INTEGRATION.network, alias: 'HPLaserMFP135w' } },
      ]);
      renderPrinters();
      // Com os dois nomes iguais o texto aparece 2x (título do card + linha
      // do apelido) — pegar o primeiro, que é o título.
      const titles = await screen.findAllByText('HPLaserMFP135w');
      const card = titles[0].closest('div.overflow-hidden') as HTMLElement;
      expect(within(card).queryByRole('button', { name: /Não confere/ })).not.toBeInTheDocument();
    });

    // Status de rede desconhecido = `alias: null` por NÃO SABERMOS, não por
    // "não tem apelido" — oferecer "igualar" aqui proporia sobrescrever um
    // valor que pode existir e ser diferente, sem nunca tê-lo lido.
    it('não oferece igualar quando o status de rede é desconhecido', async () => {
      vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_UNKNOWN]);
      renderPrinters();
      const card = (await screen.findByText(PRINTER_UNKNOWN.name)).closest('div.overflow-hidden') as HTMLElement;
      expect(within(card).queryByRole('button', { name: /Não confere/ })).not.toBeInTheDocument();
    });

    // Achado da revisão crítica: o teste acima NÃO trava a guarda
    // `source !== 'unknown'` — o fixture PRINTER_UNKNOWN também tem
    // `alias: null`, então a cláusula seguinte já o satisfaz sozinha.
    // Mutante executado (`source !== 'unknown'` -> `true`): suíte 50/50
    // verde. Hoje o backend sempre emite `alias: null` junto de
    // `source: 'unknown'` (constante UNKNOWN_NETWORK_STATUS), então a guarda
    // é defesa em profundidade — e é justamente por isso que precisa de um
    // caso que a exercite sozinha: no dia em que um apelido sobreviver a uma
    // leitura degradada, o atalho proporia SOBRESCREVER um valor que nunca
    // chegou a ser lido.
    it('não oferece igualar com status desconhecido mesmo que venha um apelido junto', async () => {
      vi.mocked(api.listPrinters).mockResolvedValue([
        {
          ...PRINTER_UNKNOWN,
          network: { ...PRINTER_UNKNOWN.network, source: 'unknown', alias: 'Um apelido qualquer' },
        },
      ]);
      renderPrinters();
      const card = (await screen.findByText(PRINTER_UNKNOWN.name)).closest('div.overflow-hidden') as HTMLElement;
      expect(within(card).queryByRole('button', { name: /Não confere/ })).not.toBeInTheDocument();
    });
  });

  it('mostra "sem apelido configurado" quando o UniFi não tem nenhum apelido pra esse cliente', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]); // alias: null
    renderPrinters();

    const card = (await screen.findByText('HPLaserMFP135w')).closest('div.overflow-hidden') as HTMLElement;
    expect(within(card).getByText('sem apelido configurado')).toBeInTheDocument();
  });

  it('shows an error message instead of crashing when listPrinters rejects', async () => {
    vi.mocked(api.listPrinters).mockRejectedValue(new Error('Falha ao carregar impressoras'));

    renderPrinters();

    expect(await screen.findByText('Falha ao carregar impressoras')).toBeInTheDocument();
  });

  it('refreshes the printer list after the polling interval passes, without re-showing "Carregando…"', async () => {
    vi.mocked(api.listPrinters).mockResolvedValueOnce([PRINTER_INTEGRATION]);

    // Fake timers precisam estar ativos ANTES do render: o `setInterval` do
    // usePolling é criado no primeiro efeito, e trocar pra fake timers DEPOIS
    // não assume o controle de um timer real já agendado.
    vi.useFakeTimers();

    renderPrinters();
    await flushMicrotasks();
    expect(screen.getByText('HPLaserMFP135w')).toBeInTheDocument();
    expect(screen.queryByText('HLL2360DWVENDAS')).not.toBeInTheDocument();

    vi.mocked(api.listPrinters).mockResolvedValueOnce([PRINTER_INTEGRATION, PRINTER_CLASSIC]);

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    expect(screen.getByText('HLL2360DWVENDAS')).toBeInTheDocument();
    expect(screen.queryByText('Carregando…')).not.toBeInTheDocument();
  });

  // Regressão: o polling fica desligado com o FORMULÁRIO aberto, mas não durante remover/
  // reconectar (que usam `window.confirm`). Nessas ações, um refresh silencioso que já estava
  // em voo não pode resolver depois do `load()` da remoção e ressuscitar na tela a impressora
  // que acabou de sair do cadastro.
  it('does not resurrect a just-deleted printer with a stale in-flight poll response', async () => {
    vi.mocked(api.listPrinters).mockResolvedValueOnce([PRINTER_INTEGRATION, PRINTER_CLASSIC]);
    vi.useFakeTimers();

    renderPrinters();
    await flushMicrotasks();
    expect(screen.getByText('HLL2360DWVENDAS')).toBeInTheDocument();

    // Tick do polling: a listagem fica PENDENTE, ainda com as duas impressoras.
    let resolveStalePoll: (value: PrinterWithNetwork[]) => void = () => {};
    vi.mocked(api.listPrinters).mockImplementationOnce(
      () => new Promise((resolve) => { resolveStalePoll = resolve; }),
    );
    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    // Com o refresh em voo, o usuário remove a segunda impressora; o `load()` da mutação
    // responde primeiro.
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    vi.mocked(api.deletePrinter).mockResolvedValue(undefined as never);
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    const card = screen.getByText('HLL2360DWVENDAS').closest('div.overflow-hidden') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(card).getByRole('button', { name: 'Remover' }));
      await flushMicrotasks();
    });
    expect(screen.queryByText('HLL2360DWVENDAS')).not.toBeInTheDocument();

    // Só agora a resposta atrasada (de antes da remoção) chega.
    await act(async () => {
      resolveStalePoll([PRINTER_INTEGRATION, PRINTER_CLASSIC]);
      await flushMicrotasks();
    });

    expect(screen.queryByText('HLL2360DWVENDAS')).not.toBeInTheDocument();
    expect(screen.getByText('HPLaserMFP135w')).toBeInTheDocument();
  });

  it('does not poll while the create/edit form is open (avoids the list shifting under the user mid-edit)', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);

    // Usa `fireEvent` (síncrono) em vez de `userEvent` aqui: `userEvent`
    // agenda seus próprios timers internos que não convivem bem com fake
    // timers globais, o que travava este teste. `fireEvent.click` dispara o
    // handler de clique diretamente, sem depender de nenhum timer.
    vi.useFakeTimers();

    renderPrinters();
    await flushMicrotasks();
    expect(screen.getByText('HPLaserMFP135w')).toBeInTheDocument();
    expect(api.listPrinters).toHaveBeenCalledTimes(1);

    act(() => {
      fireEvent.click(screen.getByRole('button', { name: 'Nova impressora' }));
    });

    await vi.advanceTimersByTimeAsync(60_000);
    await flushMicrotasks();

    // O polling ficou desligado o tempo todo com o formulário aberto — nenhuma
    // nova chamada de listagem aconteceu além da carga inicial.
    expect(api.listPrinters).toHaveBeenCalledTimes(1);
  });

  // --- Reboot remoto (HP/SWS) + credencial do painel web ---

  it('calls rebootPrinter only after confirming, with a warning that says it restarts the physical device', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.rebootPrinter).mockResolvedValue({ ok: true, ipAddress: '172.16.0.89', ipOrigin: 'override' });

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(screen.getByRole('button', { name: /Reiniciar remotamente/ }));
    expect(api.rebootPrinter).not.toHaveBeenCalled();

    // O texto do aviso é a única proteção contra confundir este botão com o
    // "Reconectar" vizinho, que NÃO desliga nada — se ele deixar de dizer
    // que reinicia o equipamento físico, este teste falha.
    const message = String(confirmSpy.mock.calls[0][0]);
    expect(message).toMatch(/REINICIA O EQUIPAMENTO FÍSICO/);
    expect(message).toMatch(/Reconectar/);
    expect(message).toContain('HPLaserMFP135w');

    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: /Reiniciar remotamente/ }));
    await waitFor(() => expect(api.rebootPrinter).toHaveBeenCalledWith('p1'));

    // Mostra o alvo real da ação (o IP pode ter vindo do histórico do
    // controller — ver ipOrigin).
    expect(await screen.findByText(/Comando de reinício enviado.*172\.16\.0\.89.*override/)).toBeInTheDocument();
  });

  it('mostra o erro da API quando o reboot falha (ex.: 409 sem credencial cadastrada)', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.rebootPrinter).mockRejectedValue(new ApiError(409, 'Credencial do painel web não configurada'));

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: /Reiniciar remotamente/ }));

    expect(await screen.findByText('Credencial do painel web não configurada')).toBeInTheDocument();
  });

  // --- Troca de senha de admin do painel web (HP/SWS) ---

  it('troca a senha de admin só após confirmar, e mostra a credencial nova pra copiar', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.changeAdminPassword).mockResolvedValue({
      username: 'admin',
      password: 'senha-gerada-forte',
      ipAddress: '172.16.0.89',
      ipOrigin: 'override',
    });

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(screen.getByRole('button', { name: /Trocar senha de admin/ }));
    await user.click(screen.getByRole('button', { name: 'Confirmar troca' }));
    expect(api.changeAdminPassword).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Confirmar troca' }));

    await waitFor(() => expect(api.changeAdminPassword).toHaveBeenCalledWith('p1', { username: undefined, password: undefined }));
    expect(await screen.findByText('senha-gerada-forte')).toBeInTheDocument();
    expect(screen.getByText(/Senha trocada e confirmada/)).toBeInTheDocument();
  });

  // ACHADO DO CRÍTICO no backend (2026-09-10): num estado AMBÍGUO, a
  // credencial TENTADA é a única cópia que existe (o cadastro não foi
  // atualizado). Sem este teste, a tela poderia simplesmente tratar isso
  // como "erro comum" e perder o valor no `.catch()`, exatamente o cenário
  // que motivou a correção no backend.
  it('mostra a credencial TENTADA (não perde) quando a verificação por relogin fica ambígua', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.changeAdminPassword).mockRejectedValue(
      new AdminPasswordAmbiguousError(
        'A SWS respondeu sucesso, mas o login com a nova falhou',
        'admin',
        'senha-que-pode-ter-colado',
        '172.16.0.89',
        'override',
      ),
    );

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: /Trocar senha de admin/ }));
    await user.click(screen.getByRole('button', { name: 'Confirmar troca' }));

    expect(await screen.findByText('senha-que-pode-ter-colado')).toBeInTheDocument();
    expect(screen.getByText(/NÃO FOI POSSÍVEL CONFIRMAR/)).toBeInTheDocument();
    expect(screen.getByText(/cadastro NÃO foi atualizado/)).toBeInTheDocument();
  });

  it('mostra o erro da API (não a credencial) quando a troca falha de forma comum (ex.: 403)', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.changeAdminPassword).mockRejectedValue(new ApiError(403, 'Credencial ATUAL do painel web recusada'));

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: /Trocar senha de admin/ }));
    await user.click(screen.getByRole('button', { name: 'Confirmar troca' }));

    expect(await screen.findByText('Credencial ATUAL do painel web recusada')).toBeInTheDocument();
  });

  it('envia wbmCredentials no cadastro quando usuário e senha do painel são informados', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([]);
    vi.mocked(api.createPrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();

    await user.click(await screen.findByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Nova Impressora');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '11:22:33:44:55:66');
    await user.type(screen.getByPlaceholderText('ex: public'), 'public');
    await user.type(screen.getByPlaceholderText('ex: admin'), 'admin');
    await user.type(screen.getByLabelText('Senha do painel web'), 'senha-do-painel');

    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));

    await waitFor(() =>
      expect(api.createPrinter).toHaveBeenCalledWith(
        expect.objectContaining({
          wbmCredentials: { username: 'admin', password: 'senha-do-painel' },
        }),
      ),
    );
  });

  it('aceita usuário do painel com senha em branco (padrão de fábrica da HP real)', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([]);
    vi.mocked(api.createPrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();

    await user.click(await screen.findByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Nova Impressora');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '11:22:33:44:55:66');
    await user.type(screen.getByPlaceholderText('ex: public'), 'public');
    await user.type(screen.getByPlaceholderText('ex: admin'), 'admin');

    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));

    await waitFor(() =>
      expect(api.createPrinter).toHaveBeenCalledWith(
        expect.objectContaining({ wbmCredentials: { username: 'admin', password: '' } }),
      ),
    );
  });

  it('não envia wbmCredentials quando nenhum dos dois campos foi preenchido', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([]);
    vi.mocked(api.createPrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();

    await user.click(await screen.findByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Nova Impressora');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '11:22:33:44:55:66');
    await user.type(screen.getByPlaceholderText('ex: public'), 'public');
    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));

    await waitFor(() => expect(api.createPrinter).toHaveBeenCalled());
    // `undefined` (e não `null`): omitir é o que o backend interpreta como
    // "sem credencial" no POST.
    expect(vi.mocked(api.createPrinter).mock.calls[0][0].wbmCredentials).toBeUndefined();
  });

  it('recusa senha do painel sem usuário, sem chamar a API (a senha não pode ser descartada em silêncio)', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([]);

    const user = userEvent.setup();
    renderPrinters();

    await user.click(await screen.findByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Nova Impressora');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '11:22:33:44:55:66');
    await user.type(screen.getByPlaceholderText('ex: public'), 'public');
    await user.type(screen.getByLabelText('Senha do painel web'), 'senha-orfa');
    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));

    expect(await screen.findByText(/Informe o usuário do painel web/)).toBeInTheDocument();
    expect(api.createPrinter).not.toHaveBeenCalled();
  });

  it('na edição, os campos do painel web nascem VAZIOS e omitir mantém a credencial atual', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.updatePrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    await user.click(screen.getByRole('button', { name: /Editar/ }));

    // O backend nunca devolve a credencial, então não há como repopular —
    // os campos precisam estar vazios (e não com um valor falso qualquer).
    expect(screen.getByPlaceholderText('deixe em branco para manter o atual')).toHaveValue('');
    expect(screen.getByLabelText('Senha do painel web')).toHaveValue('');

    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    await waitFor(() => expect(api.updatePrinter).toHaveBeenCalled());
    expect(vi.mocked(api.updatePrinter).mock.calls[0][1].wbmCredentials).toBeUndefined();
  });

  // ACHADO DO CRÍTICO: na edição, preencher SÓ o usuário do painel mandava
  // `password: ''` e apagava em silêncio a senha guardada (o backend aceita
  // senha vazia de propósito, e nunca devolve a credencial em leitura, então
  // nada nem ninguém percebia — a falha só apareceria depois, como um 403 no
  // reboot). Agora exige confirmação explícita.
  it('na edição, preencher só o usuário do painel exige confirmação antes de gravar senha em branco', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.updatePrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');
    await user.click(screen.getByRole('button', { name: /Editar/ }));

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.type(screen.getByPlaceholderText('deixe em branco para manter o atual'), 'operador');
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    // Cancelou: nada foi salvo (nem o resto do formulário, para não deixar a
    // impressão de que só a credencial ficou de fora).
    expect(api.updatePrinter).not.toHaveBeenCalled();
    const message = String(confirmSpy.mock.calls[0][0]);
    expect(message).toMatch(/SENHA EM BRANCO/);
    expect(message).toMatch(/perdida/);

    // Confirmou: aí sim grava a senha vazia (caso legítimo — o painel da HP
    // real está sem senha de fábrica).
    confirmSpy.mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));
    await waitFor(() => expect(api.updatePrinter).toHaveBeenCalled());
    expect(vi.mocked(api.updatePrinter).mock.calls[0][1].wbmCredentials).toEqual({
      username: 'operador',
      password: '',
    });
  });

  it('na edição, trocar usuário E senha do painel salva direto, sem confirmação', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.updatePrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');
    await user.click(screen.getByRole('button', { name: /Editar/ }));

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.type(screen.getByPlaceholderText('deixe em branco para manter o atual'), 'operador');
    await user.type(screen.getByLabelText('Senha do painel web'), 'senha-nova');
    await user.click(screen.getByRole('button', { name: 'Salvar alterações' }));

    await waitFor(() => expect(api.updatePrinter).toHaveBeenCalled());
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(vi.mocked(api.updatePrinter).mock.calls[0][1].wbmCredentials).toEqual({
      username: 'operador',
      password: 'senha-nova',
    });
  });

  it('no CADASTRO, senha em branco não pede confirmação (não há nada a sobrescrever)', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([]);
    vi.mocked(api.createPrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(await screen.findByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Nova Impressora');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '11:22:33:44:55:66');
    await user.type(screen.getByPlaceholderText('ex: public'), 'public');
    await user.type(screen.getByPlaceholderText('ex: admin'), 'admin');
    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));

    await waitFor(() => expect(api.createPrinter).toHaveBeenCalled());
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('SEGURANÇA: a senha do painel web nunca é gravada em localStorage/sessionStorage', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([]);
    vi.mocked(api.createPrinter).mockResolvedValue({ ...PRINTER_INTEGRATION });

    const user = userEvent.setup();
    renderPrinters();

    await user.click(await screen.findByRole('button', { name: 'Nova impressora' }));
    await user.type(screen.getByPlaceholderText('ex: HPLaserMFP135w'), 'Nova Impressora');
    await user.type(screen.getByPlaceholderText('aa:bb:cc:dd:ee:ff'), '11:22:33:44:55:66');
    await user.type(screen.getByPlaceholderText('ex: public'), 'public');
    await user.type(screen.getByPlaceholderText('ex: admin'), 'admin');
    await user.type(screen.getByLabelText('Senha do painel web'), 'senha-do-painel-secreta');
    expectNoSecretInStorage('senha-do-painel-secreta');

    await user.click(screen.getByRole('button', { name: 'Cadastrar impressora' }));
    await waitFor(() => expect(api.createPrinter).toHaveBeenCalled());
    expectNoSecretInStorage('senha-do-painel-secreta');
  });

  // --- Bugs reais encontrados na página, rodada 1 ---

  it('mostra um rótulo sempre visível diferenciando o nome do cadastro local do Apelido no UniFi', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    renderPrinters();

    const card = (await screen.findByText('HPLaserMFP135w')).closest('div.overflow-hidden') as HTMLElement;
    // Antes da correção, a única explicação de que "HPLaserMFP135w" (nome do
    // cadastro local) e o Apelido no UniFi são campos diferentes era um tooltip
    // (title, só em hover) — este rótulo fixo precisa estar sempre visível.
    expect(within(card).getByText('cadastro local')).toBeInTheDocument();
  });

  it('mostra "apelido desconhecido" (não afirma "sem apelido configurado") quando o status de rede é desconhecido', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_UNKNOWN]);
    renderPrinters();

    const card = (await screen.findByText('BRW849E567E0445')).closest('div.overflow-hidden') as HTMLElement;
    // `alias: null` com `source: 'unknown'` significa "não sabemos", não "não
    // existe" — afirmar "sem apelido configurado" seria uma alegação factual que
    // pode ser falsa (a impressora pode ter um apelido real no UniFi).
    expect(within(card).getByText(/apelido desconhecido/)).toBeInTheDocument();
    expect(within(card).queryByText('sem apelido configurado')).not.toBeInTheDocument();
  });

  it('mantém o "sem apelido configurado" (agora sim uma afirmação verdadeira) quando a fonte de rede respondeu e realmente não há apelido', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]); // source: 'integration', alias: null
    renderPrinters();

    const card = (await screen.findByText('HPLaserMFP135w')).closest('div.overflow-hidden') as HTMLElement;
    expect(within(card).getByText('sem apelido configurado')).toBeInTheDocument();
  });

  it('uma ação em andamento numa impressora não é afetada por uma ação concorrente em OUTRA impressora (pendingId compartilhado)', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION, PRINTER_CLASSIC]);
    let resolveReboot: (value: { ok: true; ipAddress: string; ipOrigin: 'override' }) => void = () => {};
    vi.mocked(api.rebootPrinter).mockImplementation(
      () => new Promise((resolve) => { resolveReboot = resolve; }),
    );
    vi.mocked(api.deletePrinter).mockResolvedValue({ ok: true });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    const cardA = screen.getByText('HPLaserMFP135w').closest('div.overflow-hidden') as HTMLElement;
    const cardB = screen.getByText('HLL2360DWVENDAS').closest('div.overflow-hidden') as HTMLElement;

    // Impressora A: dispara o reboot, cuja resposta fica pendente de propósito.
    await user.click(within(cardA).getByRole('button', { name: /Reiniciar remotamente/ }));
    expect(within(cardA).getByRole('button', { name: /Reiniciar remotamente/ })).toBeDisabled();
    expect(within(cardA).getByRole('button', { name: /Remover/ })).toBeDisabled();

    // Impressora B: remove enquanto o reboot de A ainda está em voo. Antes da
    // correção, isso sobrescrevia o `pendingId` global e reabilitava os botões de A.
    await user.click(within(cardB).getByRole('button', { name: /Remover/ }));
    await waitFor(() => expect(api.deletePrinter).toHaveBeenCalledWith('p2'));

    expect(within(cardA).getByRole('button', { name: /Reiniciar remotamente/ })).toBeDisabled();
    expect(within(cardA).getByRole('button', { name: /Remover/ })).toBeDisabled();

    resolveReboot({ ok: true, ipAddress: '172.16.0.89', ipOrigin: 'override' });
    await waitFor(() =>
      expect(within(cardA).getByRole('button', { name: /Reiniciar remotamente/ })).not.toBeDisabled(),
    );
  });

  it('pede confirmação ao trocar a edição de Apelido para outra impressora sem salvar (rascunho compartilhado)', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION, PRINTER_CLASSIC]);

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    const cardA = screen.getByText('HPLaserMFP135w').closest('div.overflow-hidden') as HTMLElement;
    const cardB = screen.getByText('HLL2360DWVENDAS').closest('div.overflow-hidden') as HTMLElement;

    await user.click(within(cardA).getByRole('button', { name: 'Renomear apelido no UniFi' }));

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(within(cardB).getByRole('button', { name: 'Renomear apelido no UniFi' }));
    expect(confirmSpy).toHaveBeenCalled();
    // Cancelado: o editor de A continua aberto, não foi sobrescrito pelo de B.
    expect(within(cardA).getByRole('button', { name: 'Salvar' })).toBeInTheDocument();
    expect(within(cardB).queryByRole('button', { name: 'Salvar' })).not.toBeInTheDocument();

    confirmSpy.mockReturnValue(true);
    await user.click(within(cardB).getByRole('button', { name: 'Renomear apelido no UniFi' }));
    expect(within(cardB).getByRole('button', { name: 'Salvar' })).toBeInTheDocument();
  });

  it('pede confirmação ao trocar a edição de senha de admin para outra impressora com credencial já digitada', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION, PRINTER_CLASSIC]);

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    const cardA = screen.getByText('HPLaserMFP135w').closest('div.overflow-hidden') as HTMLElement;
    const cardB = screen.getByText('HLL2360DWVENDAS').closest('div.overflow-hidden') as HTMLElement;

    await user.click(within(cardA).getByRole('button', { name: /Trocar senha de admin/ }));
    await user.type(
      within(cardA).getByPlaceholderText('deixe em branco para gerar uma forte automaticamente'),
      'senha-de-A-123',
    );

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(within(cardB).getByRole('button', { name: /Trocar senha de admin/ }));
    expect(confirmSpy).toHaveBeenCalled();
    // Cancelado: o painel de A continua aberto com a senha digitada intacta.
    expect(
      within(cardA).getByPlaceholderText('deixe em branco para gerar uma forte automaticamente'),
    ).toHaveValue('senha-de-A-123');
    expect(within(cardB).queryByPlaceholderText('deixe em branco para gerar uma forte automaticamente')).not.toBeInTheDocument();
  });

  it('pede confirmação ao clicar em Editar de outra impressora com o formulário já aberto', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION, PRINTER_CLASSIC]);

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    const cardA = screen.getByText('HPLaserMFP135w').closest('div.overflow-hidden') as HTMLElement;
    const cardB = screen.getByText('HLL2360DWVENDAS').closest('div.overflow-hidden') as HTMLElement;

    await user.click(within(cardA).getByRole('button', { name: /Editar/ }));
    expect(screen.getByDisplayValue('HPLaserMFP135w')).toBeInTheDocument();

    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    await user.click(within(cardB).getByRole('button', { name: /Editar/ }));
    expect(confirmSpy).toHaveBeenCalled();
    // Cancelado: o formulário continua mostrando os dados de A.
    expect(screen.getByDisplayValue('HPLaserMFP135w')).toBeInTheDocument();

    confirmSpy.mockReturnValue(true);
    await user.click(within(cardB).getByRole('button', { name: /Editar/ }));
    expect(screen.getByDisplayValue('HLL2360DWVENDAS')).toBeInTheDocument();
  });

  it('Cancelar na troca de senha de admin limpa a mensagem de erro (não fica presa na tela) e o botão Fechar também limpa', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);
    vi.mocked(api.changeAdminPassword).mockRejectedValue(new ApiError(400, 'Senha inválida'));

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    vi.spyOn(window, 'confirm').mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: /Trocar senha de admin/ }));
    await user.type(screen.getByPlaceholderText('deixe em branco para gerar uma forte automaticamente'), 'senha12345');
    await user.click(screen.getByRole('button', { name: 'Confirmar troca' }));
    expect(await screen.findByText('Senha inválida')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Cancelar' }));
    expect(screen.queryByText('Senha inválida')).not.toBeInTheDocument();

    // E também dá pra fechar direto pelo botão dedicado, sem precisar reabrir o editor.
    await user.click(screen.getByRole('button', { name: /Trocar senha de admin/ }));
    await user.type(screen.getByPlaceholderText('deixe em branco para gerar uma forte automaticamente'), 'outrasenha12');
    await user.click(screen.getByRole('button', { name: 'Confirmar troca' }));
    expect(await screen.findByText('Senha inválida')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Fechar' }));
    expect(screen.queryByText('Senha inválida')).not.toBeInTheDocument();
  });

  it('valida o tamanho da nova senha de admin ANTES do confirm destrutivo (não assusta o usuário com um aviso irreversível para uma senha que nem seria enviada)', async () => {
    vi.mocked(api.listPrinters).mockResolvedValue([PRINTER_INTEGRATION]);

    const user = userEvent.setup();
    renderPrinters();
    await screen.findByText('HPLaserMFP135w');

    const confirmSpy = vi.spyOn(window, 'confirm');
    await user.click(screen.getByRole('button', { name: /Trocar senha de admin/ }));
    await user.type(screen.getByPlaceholderText('deixe em branco para gerar uma forte automaticamente'), 'curta');
    await user.click(screen.getByRole('button', { name: 'Confirmar troca' }));

    expect(await screen.findByText(/entre 8 e 18 caracteres/)).toBeInTheDocument();
    expect(confirmSpy).not.toHaveBeenCalled();
    expect(api.changeAdminPassword).not.toHaveBeenCalled();
  });
});
