// Automação de "Sleep Time" e "Auto Power Off" contra a Web Based Management
// (WBM) das impressoras BROTHER (Onda 2, spike da subtarefa 9 — ver
// docs/printers-snmp-research.md, seção "Spike: Sleep Time/Auto Power Off
// (Brother) + reboot HP + hostname real").
//
// IMPORTANTE — isto é ESPECÍFICO da família Brother, não de todas as
// impressoras cadastradas neste módulo. O cadastro (src/db/printers.db.ts)
// não tem campo de fabricante — não há como filtrar "só chame isto para
// impressoras Brother" na camada de dados. As URLs abaixo (`/general/
// sleep.html`, `/general/powerdown.html`) só existem na WBM da Brother:
// chamar isto contra uma HP (ou qualquer outro fabricante) resulta em erro
// de rede/HTTP não-2xx, o que já é um retorno de erro razoável (nunca um
// "sucesso" enganoso) — não precisa de checagem de fabricante adicional
// agora, seria inventar um campo que não existe no schema.
//
// Confirmado ao vivo contra `HLL2360DWVENDAS` (172.16.0.222, Brother
// HL-L2360D series) nesta sessão: as duas páginas aceitam POST simples,
// SEM LOGIN, sem token CSRF. Isso significa que qualquer dispositivo na
// rede local pode alterar essas configurações — mesma superfície de risco
// que a WBM já expõe nativamente (não introduzida por este serviço).
//
// Estilo de resiliência de rede: timeout curto via AbortController (mesmo
// espírito de SNMP_TIMEOUT_MS em printer-snmp.service.ts) — uma impressora
// desligada/inacessível não pode travar a requisição HTTP do dashboard.

const REQUEST_TIMEOUT_MS = 5000;

// --- Erros -------------------------------------------------------------

// Timeout ou falha de rede (host inalcançável, conexão recusada) ao tentar
// falar com a WBM da impressora — não sabemos se o campo foi ou não
// aplicado, só que não conseguimos completar a requisição.
export class PrinterUnreachableError extends Error {
  constructor(ipAddress: string, cause: unknown) {
    const causeMessage = cause instanceof Error ? cause.message : String(cause);
    super(`Não foi possível falar com a impressora em ${ipAddress}: ${causeMessage}`);
    this.name = 'PrinterUnreachableError';
  }
}

// A WBM respondeu, mas com um status HTTP fora da faixa 2xx — sinal de que
// o campo pode ter sido rejeitado pelo firmware (não temos como ler o corpo
// da resposta com segurança: é uma página HTML de confirmação, não JSON
// estruturado, então não extraímos nada dali além do status).
export class PrinterWbmRequestError extends Error {
  constructor(
    ipAddress: string,
    public readonly status: number,
  ) {
    super(`A WBM da impressora em ${ipAddress} respondeu com status ${status} (esperado 2xx)`);
    this.name = 'PrinterWbmRequestError';
  }
}

// --- Helpers -------------------------------------------------------------

async function postForm(url: string, ipAddress: string, body: string): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res: Response;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
      signal: controller.signal,
    });
  } catch (error) {
    // Timeout (AbortError) ou qualquer outra falha de rede (ECONNREFUSED,
    // EHOSTUNREACH, DNS) chegam aqui como rejeição do `fetch` — tratados de
    // forma igual, pois em ambos os casos não conseguimos completar a
    // requisição (não vale a pena distinguir o motivo exato para quem chama).
    throw new PrinterUnreachableError(ipAddress, error);
  } finally {
    clearTimeout(timer);
  }

  if (!res.ok) {
    throw new PrinterWbmRequestError(ipAddress, res.status);
  }

  // Sucesso: a WBM real responde com uma página HTML de confirmação, não
  // JSON — não há nada útil pra extrair do corpo com segurança, então nem
  // tentamos ler/parsear a resposta.
}

// --- API pública do serviço ----------------------------------------------

/**
 * Define o "Sleep Time" (tempo de inatividade até a impressora entrar em
 * modo de economia de energia) via POST direto na WBM da Brother, sem
 * login — campo `B16` de `/general/sleep.html`.
 *
 * @param ipAddress IP atual da impressora na rede (já resolvido pelo
 *   chamador — ver `buildNetworkStatusResolver`/`ipOverride`).
 * @param minutes Minutos de inatividade antes do modo de economia. A
 *   validação de faixa (inteiro positivo, 1-99) é responsabilidade da ROTA
 *   (`printers.routes.ts`) — este serviço não valida o valor além de
 *   repassá-lo cru no corpo do POST, pois não temos confirmação do limite
 *   real aceito pelo firmware (pode variar por modelo/região).
 * @returns Resolve sem valor quando a WBM aceita a requisição (status 2xx).
 * @throws {PrinterUnreachableError} timeout ou impressora inacessível na rede.
 * @throws {PrinterWbmRequestError} a WBM respondeu com status HTTP não-2xx.
 */
export async function setSleepTime(ipAddress: string, minutes: number): Promise<void> {
  const url = `http://${ipAddress}/general/sleep.html`;
  const body = `pageid=5&postif_registration_reject=1&B16=${encodeURIComponent(String(minutes))}`;
  await postForm(url, ipAddress, body);
}

// Mapeamento hours -> índice ordinal do <select> B204, capturado ao vivo
// contra a Brother HL-L2360D real (ver docs/printers-snmp-research.md).
// NÃO é a hora em si codificada no índice — é a posição da opção na lista:
// 0="Off", 1="1 hour", 2="2 hours", 3="4 hours", 4="8 hours". Expor esse
// índice cru na API pública da rota obrigaria quem chama a decorar essa
// tabela; por isso a rota aceita `hours` e traduz aqui.
export const AUTO_POWER_OFF_HOURS_TO_INDEX = {
  0: 0,
  1: 1,
  2: 2,
  4: 3,
  8: 4,
} as const satisfies Record<number, number>;

export type AutoPowerOffHours = keyof typeof AUTO_POWER_OFF_HOURS_TO_INDEX;

/**
 * Define o "Auto Power Off" (desligamento automático por inatividade) via
 * POST direto na WBM da Brother, sem login — campo `B204` (select) de
 * `/general/powerdown.html`.
 *
 * @param ipAddress IP atual da impressora na rede.
 * @param index Índice ordinal já traduzido do select B204 (0-4 — ver
 *   `AUTO_POWER_OFF_HOURS_TO_INDEX`). A validação do índice (só os 5
 *   valores confirmados) é responsabilidade da ROTA via schema Zod — este
 *   serviço recebe o índice já validado/traduzido, não a quantidade de
 *   horas.
 * @returns Resolve sem valor quando a WBM aceita a requisição (status 2xx).
 * @throws {PrinterUnreachableError} timeout ou impressora inacessível na rede.
 * @throws {PrinterWbmRequestError} a WBM respondeu com status HTTP não-2xx.
 */
export async function setAutoPowerOff(ipAddress: string, index: number): Promise<void> {
  const url = `http://${ipAddress}/general/powerdown.html`;
  const body = `pageid=6&postif_registration_reject=1&B204=${encodeURIComponent(String(index))}`;
  await postForm(url, ipAddress, body);
}
