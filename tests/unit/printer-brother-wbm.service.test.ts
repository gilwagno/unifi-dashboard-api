import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  setSleepTime,
  setAutoPowerOff,
  PrinterUnreachableError,
  PrinterWbmRequestError,
  AUTO_POWER_OFF_HOURS_TO_INDEX,
} from '../../src/services/printer-brother-wbm.service.js';

// Testes de src/services/printer-brother-wbm.service.ts (Onda 2, spike da
// subtarefa 9 — automação Sleep Time/Auto Power Off via WBM Brother, sem
// login). Nada de rede real: `global.fetch` é mockado, seguindo o padrão
// comum do Vitest (nenhum outro teste do projeto precisou mockar fetch
// nativo do Node ainda, este é o primeiro serviço que usa `fetch` direto em
// vez de passar por unifi-classic.service.ts/unifi.service.ts).

function fakeResponse(ok: boolean, status: number): Response {
  return { ok, status } as Response;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('timeout de requisição', () => {
  // ACHADO DO CRÍTICO (validação por mutação): não havia NENHUM teste
  // provando que o AbortController existe. Apagar `signal: controller.signal`
  // do fetch deixava as 24 asserções anteriores verdes — os testes de
  // PrinterUnreachableError só provam que uma REJEIÇÃO do fetch é traduzida
  // pro erro certo, e uma rejeição simulada acontece independentemente do
  // timeout estar armado ou não. O `fetch` nativo do Node NÃO tem timeout
  // padrão: contra uma impressora que aceita a conexão TCP e nunca responde
  // (embedded HTTP de impressora ocupada imprimindo é exatamente o caso),
  // a rota do dashboard ficaria pendurada indefinidamente.
  //
  // Este teste usa um fetch que só rejeita quando o SIGNAL dispara, com
  // timers falsos: se o signal não for passado (ou o setTimeout for
  // removido), a promessa nunca resolve e o teste falha por timeout.
  function fetchThatOnlyRespondsToAbort() {
    return vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => {
            reject(new DOMException('The operation was aborted', 'AbortError'));
          });
        }),
    );
  }

  it('aborta com PrinterUnreachableError após 5s de silêncio da WBM (e não antes)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchThatOnlyRespondsToAbort());

    let settled = false;
    const promise = setSleepTime('172.16.0.222', 15).then(
      () => {
        settled = true;
      },
      (error: unknown) => {
        settled = true;
        return error;
      },
    );

    // Antes do prazo, nada de abortar: uma WBM lenta (mas viva) precisa ter
    // chance de responder.
    await vi.advanceTimersByTimeAsync(4_999);
    expect(settled).toBe(false);

    await vi.advanceTimersByTimeAsync(2);
    expect(settled).toBe(true);
    expect(await promise).toBeInstanceOf(PrinterUnreachableError);
  });

  it('setAutoPowerOff também aborta em 5s (o timeout está no helper, não numa das funções só)', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', fetchThatOnlyRespondsToAbort());

    const promise = setAutoPowerOff('172.16.0.222', 3).catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(5_001);

    expect(await promise).toBeInstanceOf(PrinterUnreachableError);
  });
});

describe('setSleepTime', () => {
  it('faz POST form-urlencoded correto para /general/sleep.html e resolve em sucesso (2xx)', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(true, 200));
    vi.stubGlobal('fetch', fetchMock);

    await setSleepTime('172.16.0.222', 15);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://172.16.0.222/general/sleep.html');
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ 'Content-Type': 'application/x-www-form-urlencoded' });
    expect(init.body).toBe('pageid=5&postif_registration_reject=1&B16=15');
  });

  it('lança PrinterUnreachableError quando o fetch rejeita (timeout/rede inacessível)', async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException('The operation was aborted', 'AbortError');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(setSleepTime('172.16.0.222', 15)).rejects.toBeInstanceOf(PrinterUnreachableError);
  });

  it('lança PrinterWbmRequestError quando a WBM responde com status não-2xx', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(false, 500));
    vi.stubGlobal('fetch', fetchMock);

    const error = await setSleepTime('172.16.0.222', 15).catch((e) => e);
    expect(error).toBeInstanceOf(PrinterWbmRequestError);
    expect((error as PrinterWbmRequestError).status).toBe(500);
  });
});

describe('setAutoPowerOff', () => {
  it('faz POST form-urlencoded correto para /general/powerdown.html e resolve em sucesso (2xx)', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(true, 200));
    vi.stubGlobal('fetch', fetchMock);

    await setAutoPowerOff('172.16.0.222', 3);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('http://172.16.0.222/general/powerdown.html');
    expect(init.body).toBe('pageid=6&postif_registration_reject=1&B204=3');
  });

  it('lança PrinterUnreachableError quando o fetch rejeita', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('ECONNREFUSED');
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(setAutoPowerOff('172.16.0.222', 0)).rejects.toBeInstanceOf(PrinterUnreachableError);
  });

  it('lança PrinterWbmRequestError quando a WBM responde com status não-2xx', async () => {
    const fetchMock = vi.fn(async () => fakeResponse(false, 400));
    vi.stubGlobal('fetch', fetchMock);

    await expect(setAutoPowerOff('172.16.0.222', 0)).rejects.toBeInstanceOf(PrinterWbmRequestError);
  });
});

describe('AUTO_POWER_OFF_HOURS_TO_INDEX', () => {
  // Ancora o mapeamento exato capturado ao vivo contra a Brother HL-L2360D
  // real (ver docs/printers-snmp-research.md): o índice do <select> B204 NÃO
  // é a quantidade de horas em si.
  it('mapeia hours para o índice ordinal correto do select B204', () => {
    expect(AUTO_POWER_OFF_HOURS_TO_INDEX).toEqual({ 0: 0, 1: 1, 2: 2, 4: 3, 8: 4 });
  });
});
