import { createCipheriv, createHash, randomBytes } from 'node:crypto';
import { Agent, fetch as undiciFetch, type RequestInit as UndiciRequestInit, type Response as UndiciResponse } from 'undici';

// Reboot remoto das impressoras HP via SWS (SyncThru Web Service — o painel
// web embarcado, de origem Samsung, que roda na linha "HP Laser MFP 13x";
// Onda 2, subtarefa do reboot HP). Todo o protocolo abaixo foi levantado ao
// vivo contra a HP real do Financeiro (172.16.0.89) e está documentado em
// docs/printers-snmp-research.md, seções "Payload exato do reboot HP" e
// "Login programático — RESOLVIDO". Nada aqui foi inventado/adivinhado:
//   1. GET /sws/data/sws_data.js — nome do produto, número de série e
//      `csrfToken`. O nome do arquivo sugere estático, mas o `csrfToken`
//      MUDA entre uma leitura sem sessão e uma leitura autenticada
//      (confirmado ao vivo) — por isso é sempre lido de novo a cada chamada
//      (`fetchDeviceIdentity`), nunca cacheado entre logins.
//   2. POST /sws/app/gnb/login/login.jsp — login "Ext1": a senha nunca vai
//      em claro, vai cifrada em AES-256-CBC no formato do OpenSSL
//      (`Salted__` + salt + EVP_BytesToKey/MD5), exatamente como a
//      biblioteca `gibberish-aes.pjs` que a própria SWS carrega no navegador.
//   3. POST /sws/app/security/general/reboot/RestartSystem.jsp com
//      `pinCode` = o MAC da própria impressora em MAIÚSCULAS.
//
// IMPORTANTE — isto é ESPECÍFICO da família HP/SWS, do mesmo jeito que
// printer-brother-wbm.service.ts é específico da Brother: o cadastro
// (src/db/printers.db.ts) não tem campo de fabricante, então não há como
// recusar de antemão a chamada contra uma Brother. Chamar isto contra uma
// Brother resulta em erro (a WBM não tem /sws/*: 404 → PrinterSwsRequestError),
// nunca num "sucesso" enganoso.
//
// ESTA AÇÃO REINICIA UM EQUIPAMENTO FÍSICO DE VERDADE. Diferente do
// /reconnect (que só desassocia/reassocia o cliente no controller UniFi),
// aqui a impressora reinicia o firmware: um job em andamento morre. Toda a
// suíte automatizada mocka `undici.fetch` (nunca fala com uma impressora de
// verdade). Diferente da subtarefa anterior de sleep-time/auto-power-off da
// Brother, esta função FOI testada de ponta a ponta contra o equipamento
// real (172.16.0.89, sessão de continuação) — incluindo o próprio reboot,
// disparado deliberadamente pelo usuário no navegador (não por este código
// diretamente) e reproduzido por este código depois, com a resposta real
// `{success:true}` confirmando. Ver o docblock de `rebootHpPrinter` para o
// que essa validação corrigiu.
//
// SEGREDO: a senha do painel nunca é logada, nunca volta em mensagem de erro
// e nunca trafega em claro no corpo (vai dentro do blob AES). Toda mensagem
// de erro derivada de exceção nativa passa por `redact()` antes de subir —
// mesmo raciocínio do sanitizeErrorMessage de printer-snmp.service.ts, onde
// se descobriu que a lib de rede embutia o segredo no texto do próprio erro.

const REQUEST_TIMEOUT_MS = 5000;

// DECISÃO — HTTPS com certificado autoassinado aceito (revisão de uma
// decisão anterior que usava HTTP puro).
//
// Achado ao vivo (sessão de continuação): a HP real do Financeiro devolve,
// em HTTP puro, uma página-stub que só redireciona pro HTTPS via JavaScript
// (`checkSSL()`) em vez do conteúdo de `IDENTITY_PATH` — ou seja, o
// pressuposto anterior ("a SWS atende em HTTP puro, confirmado no Feature
// Management") não se sustentou contra o dispositivo real: o Feature
// Management confirma que a PORTA 80 está habilitada, não que o CONTEÚDO
// serve por ela sem redirecionar. Confirmado via HTTPS com o certificado
// autoassinado aceito (`curl -k`) que o conteúdo bate exatamente com o
// documentado (mesmo `productSerial`/`csrfToken`) — é a mesma impressora, só
// que exige HTTPS neste caminho.
//
// Implementação — por que `undici.fetch`/`undici.Agent` e não o `fetch`
// global do Node com um `dispatcher`:
//   - `fetch(url, { dispatcher: new (require('undici').Agent)(...) })`
//     usando o `fetch` GLOBAL do Node (que roda sobre uma cópia INTERNA do
//     undici, embutida no binário) falha com
//     `InvalidArgumentError: invalid onRequestStart method` — incompatibi-
//     lidade de versão entre a cópia interna do Node e o pacote `undici` do
//     npm (medido ao vivo no Node 24.18 deste ambiente). `undici.setGlobal-
//     Dispatcher()` contorna esse erro específico, mas troca o dispatcher do
//     `fetch` GLOBAL pra todo o processo — relaxaria a verificação de TLS de
//     qualquer chamada `fetch()` do backend inteiro (inclusive contra o
//     controller UniFi), não só desta impressora. Mesmo problema, en-
//     capsulado diferente, do `NODE_TLS_REJECT_UNAUTHORIZED=0` já descartado
//     antes por esse motivo.
//   - Usar `fetch`/`Agent` do PRÓPRIO pacote `undici` (em vez do global)
//     evita os dois problemas: mesma versão em ambos, e o `Agent` só afeta
//     as chamadas feitas através dele — nenhum outro `fetch()` do processo é
//     tocado. Confirmado ao vivo contra a impressora real antes de fixar
//     esta abordagem.
//
// Consequência aceita — `rejectUnauthorized: false` desliga a validação de
// certificado por completo (não é "aceitar só o certificado autoassinado
// desta impressora": é aceitar QUALQUER certificado). Um certificado
// autoassinado de impressora não teria o IP no SAN mesmo que se tentasse
// validar, então uma verificação "de verdade" exigiria fixar (pin) o
// certificado específico do dispositivo — não implementado aqui, mesmo
// modelo de confiança já usado para o controller UniFi (`UNIFI_ALLOW_SELF_
// SIGNED`): rede interna administrativa, não uma rede hostil. Nessa mesma
// rede, o material da cifra do login é PÚBLICO (vem do `sws_data.js` sem
// autenticação), então o blob AES nunca foi confidencialidade forte — é a
// proteção que o firmware oferece, nem mais nem menos. Se este módulo algum
// dia sair da LAN administrativa, isto precisa ser revisto antes.
const insecureAgent = new Agent({ connect: { rejectUnauthorized: false } });

function swsUrl(ipAddress: string, path: string): string {
  return `https://${ipAddress}${path}`;
}

// ACHADO AO VIVO (sessão de continuação, depois de migrar pra HTTPS): os dois
// POSTs de escrita (`login.jsp`, `RestartSystem.jsp`) devolvem 400 "Invalid
// Request. Some Error" — uma página genérica do próprio servidor embarcado,
// não da aplicação SWS — quando a requisição não traz `Referer` NEM `Origin`.
// Isolado por bisseção contra o dispositivo real: `Referer` sozinho basta,
// `Origin` sozinho também basta; `User-Agent`/`Accept`/`X-Requested-With`
// sozinhos NÃO bastam. É uma proteção anti-CSRF/hotlink de baixo nível do
// servidor HTTP embarcado (rejeita POSTs "sem origem"), não parte do
// protocolo Ext1/login documentado na pesquisa — um cliente HTTP puro
// (`fetch`, `curl` sem essas opções) nunca teria passado por isso, ao
// contrário de um navegador de verdade, que sempre envia pelo menos um dos
// dois automaticamente em requisições same-origin. Usamos `Origin` (mais
// simples que reproduzir o path exato da página que faria a chamada de
// verdade no navegador).
function swsOrigin(ipAddress: string): string {
  return `https://${ipAddress}`;
}

// ACHADO AO VIVO (mesma captura DevTools do reboot real): `RestartSystem.jsp`
// especificamente também exige `Referer` — só `Origin` (que bastava sozinho
// para `login.jsp`, confirmado por bisseção numa rodada anterior) não é
// suficiente aqui. Não generalizamos mais "um dos dois basta" entre
// endpoints diferentes desta SWS sem confirmar caso a caso. O valor
// observado na captura real era a página do app (`/sws/index.html`) — é o
// que o navegador manda de verdade ao clicar o botão a partir dali.
function swsReferer(ipAddress: string): string {
  return `${swsOrigin(ipAddress)}/sws/index.html`;
}

const IDENTITY_PATH = '/sws/data/sws_data.js';
const LOGIN_PATH = '/sws/app/gnb/login/login.jsp';
const REBOOT_PATH = '/sws/app/security/general/reboot/RestartSystem.jsp';

// --- Erros ---------------------------------------------------------------
//
// Três classes distintas de propósito, porque a rota mapeia cada uma para um
// status HTTP diferente (ver a DECISÃO em src/routes/printers.routes.ts):
// rede/timeout ≠ credencial recusada ≠ resposta inutilizável do firmware.

/** Timeout ou falha de rede (host inalcançável, conexão recusada). */
export class PrinterSwsUnreachableError extends Error {
  constructor(ipAddress: string, causeMessage: string) {
    super(`Não foi possível falar com a SWS da impressora em ${ipAddress}: ${causeMessage}`);
    this.name = 'PrinterSwsUnreachableError';
  }
}

/**
 * A impressora respondeu, mas de forma inutilizável: status não-2xx, corpo
 * que não é a SWS esperada (ex.: uma Brother devolvendo 404), JSON de login
 * ilegível, ou login "bem-sucedido" sem cookie de sessão.
 */
export class PrinterSwsRequestError extends Error {
  constructor(
    ipAddress: string,
    detail: string,
    public readonly status: number | null = null,
  ) {
    super(`A SWS da impressora em ${ipAddress} respondeu de forma inesperada: ${detail}`);
    this.name = 'PrinterSwsRequestError';
  }
}

/**
 * A SWS processou o login e RECUSOU a credencial (`success !== true`) — é
 * erro de configuração do cadastro, não de rede nem do firmware. Separado de
 * PrinterSwsRequestError para que a rota não devolva "a impressora recusou a
 * requisição" (502) quando o problema real é a senha guardada estar errada.
 *
 * A mensagem NUNCA inclui a senha (nem parte dela) — só o usuário tentado.
 */
export class PrinterSwsAuthenticationError extends Error {
  constructor(ipAddress: string, username: string) {
    super(
      `A SWS da impressora em ${ipAddress} recusou a credencial do usuário "${username}" ` +
        '(verifique a credencial do painel web cadastrada para esta impressora)',
    );
    this.name = 'PrinterSwsAuthenticationError';
  }
}

// --- Criptografia do login (formato OpenSSL, igual ao gibberish-aes) ------

/**
 * Deriva chave e IV a partir de uma senha e um salt pelo EVP_BytesToKey do
 * OpenSSL com MD5 (o esquema legado `openssl enc -aes-256-cbc -md md5`), que
 * é o que a biblioteca `gibberish-aes.pjs` da própria SWS implementa no
 * navegador.
 *
 * Algoritmo: D_1 = MD5(senha ‖ salt); D_i = MD5(D_(i-1) ‖ senha ‖ salt).
 * São necessários 48 bytes (32 de chave AES-256 + 16 de IV), ou seja 3
 * rodadas de MD5 — daí a menção a "3 rounds" na pesquisa.
 *
 * @param password Senha em bytes (UTF-8).
 * @param salt Exatamente 8 bytes de salt.
 * @returns Chave de 32 bytes e IV de 16 bytes.
 */
function evpBytesToKey(password: Buffer, salt: Buffer): { key: Buffer; iv: Buffer } {
  const blocks: Buffer[] = [];
  let previous = Buffer.alloc(0);
  let length = 0;
  while (length < 48) {
    previous = createHash('md5').update(Buffer.concat([previous, password, salt])).digest();
    blocks.push(previous);
    length += previous.length;
  }
  const material = Buffer.concat(blocks);
  return { key: material.subarray(0, 32), iv: material.subarray(32, 48) };
}

/**
 * Cifra um texto no formato "OpenSSL salted" usado pelo login da SWS:
 * base64( "Salted__" ‖ salt(8) ‖ AES-256-CBC(texto) ).
 *
 * @param plaintext Texto a cifrar (UTF-8).
 * @param password Senha simétrica (UTF-8).
 * @param salt Salt de 8 bytes. Só é parametrizável para que o teste possa
 *   comparar a saída com um vetor de referência gerado pelo `openssl enc`
 *   real (com salt aleatório, a saída muda a cada chamada e não haveria como
 *   ancorar o algoritmo). Em produção sempre usa `randomBytes(8)`, como o
 *   OpenSSL.
 * @returns O blob cifrado em base64, pronto pro cabeçalho `Ext1`.
 */
export function opensslAesEncrypt(plaintext: string, password: string, salt: Buffer = randomBytes(8)): string {
  const { key, iv } = evpBytesToKey(Buffer.from(password, 'utf8'), salt);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
  return Buffer.concat([Buffer.from('Salted__', 'utf8'), salt, encrypted]).toString('base64');
}

// Alfabeto restrito a ASCII imprimível "seguro": este valor (`rn`) é usado
// como SENHA de outra cifra e vai cifrado dentro do corpo, então não precisa
// de caractere especial nenhum — evitar `+`/`/`/`=` de um base64 cru elimina
// qualquer dúvida de escaping no caminho.
const RN_ALPHABET = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const RN_LENGTH = 16;

function randomRn(): string {
  const bytes = randomBytes(RN_LENGTH);
  let out = '';
  for (const byte of bytes) out += RN_ALPHABET[byte % RN_ALPHABET.length];
  return out;
}

/**
 * Monta o valor do cabeçalho/campo `Authentication` do login da SWS,
 * replicando `LOGIN.MakeLoginAuthentication` do `login.js` do dispositivo.
 *
 * @param identity Identidade lida de sws_data.js (nome do produto e série
 *   formam a senha `sec` que protege a chave descartável `rn`).
 * @param credentials Usuário e senha do painel.
 * @param rn Chave simétrica descartável de 16 caracteres. Parametrizável só
 *   para teste determinístico; em produção vem de `randomRn()`.
 * @returns String no formato `Ext1 <sidpw>:<skey>`.
 */
export function buildLoginAuthentication(
  identity: SwsDeviceIdentity,
  credentials: SwsCredentials,
  rn: string = randomRn(),
): string {
  const sec = identity.productName + identity.productSerial;
  const skey = opensslAesEncrypt(rn, sec);
  // O separador entre usuário e senha é um CR (\r), não \n nem ':' — ver a
  // pesquisa. Trocar isso faz o login falhar com credencial correta.
  const sidpw = opensslAesEncrypt(`${credentials.username}\r${credentials.password}`, rn);
  return `Ext1 ${sidpw}:${skey}`;
}

// --- Tipos públicos -------------------------------------------------------

export interface SwsCredentials {
  username: string;
  password: string;
}

export interface SwsDeviceIdentity {
  /** `SWS.DATA.buyorProductName`, ex.: "HP HP Laser MFP 135w". */
  productName: string;
  /** `SWS.DATA.productSerial`, ex.: "BRBSQ2G13Q". */
  productSerial: string;
  /** `SWS.DATA.csrfToken` — muda entre leituras sem sessão e autenticadas. */
  csrfToken: string;
}

/** Sessão autenticada: o cookie (jar completo) a reenviar nas chamadas seguintes. */
export interface SwsSession {
  cookie: string;
}

// ACHADO AO VIVO (captura real via DevTools, sessão de continuação — o
// usuário clicou "Reiniciar agora" de verdade no navegador e a requisição
// RestartSystem.jsp resultante foi capturada por completo): a SWS depende de
// MAIS QUATRO cookies além de `Authentication`, nenhum deles devolvido por
// `Set-Cookie` do `login.jsp` (só `Authentication` vem por ali) — são
// setados no NAVEGADOR via JavaScript (`document.cookie`, a função
// `CreateCookie` que já tínhamos visto em `sws_data.js`) em algum ponto do
// carregamento da SPA depois do login. Sem eles, o POST de
// `RestartSystem.jsp` era aceito pelo servidor (200, chegava na lógica da
// aplicação) mas recusado pela aplicação (`{success:false, errno:2}`) — a
// causa exata do `errno:2` que bloqueou esta feature até esta sessão.
//
// Os quatro valores abaixo são os observados na captura real, tratados como
// CONSTANTES (não são derivados de nada session-específico, ao contrário de
// `Authentication`):
//   - `xuser=SWS2.0`     — identifica a versão do cliente SWS; não parece
//     variar por sessão/dispositivo.
//   - `login=true`       — flag booleano simples, esperado sempre "true"
//     depois de um login aceito.
//   - `language=bp`      — idioma da UI selecionado (esta impressora está em
//     pt-BR — mesmo achado de idioma já documentado no CLAUDE.md).
//   - `ChangePWDFlag=yes` — aviso de "senha ainda é a padrão de fábrica" (a
//     HP do Financeiro está com `admin`/senha em branco, achado de segurança
//     já documentado). **Risco conhecido, não verificado**: se este valor for
//     na verdade calculado a partir da credencial (ex.: "no" para uma senha
//     já trocada), hardcodar "yes" pode voltar a causar recusa numa
//     impressora com senha diferente da de fábrica — não há como testar isso
//     sem uma segunda impressora HP real. Se acontecer, é o primeiro
//     suspeito a revisar.
const SESSION_COOKIE_DEFAULTS = 'xuser=SWS2.0; login=true; language=bp; ChangePWDFlag=yes';

// --- Helpers de rede ------------------------------------------------------

// Remove valores secretos de um texto antes de ele virar mensagem de erro.
// Hoje o único segredo em jogo é a senha do painel; `redactions` é uma lista
// para que qualquer valor sensível futuro (ex.: o `rn`) entre sem mudar a
// assinatura. Senha vazia (padrão de fábrica da HP) é ignorada de propósito:
// `split('')` transformaria a mensagem inteira em [REDACTED].
function redact(message: string, redactions: string[]): string {
  let out = message;
  for (const value of redactions) {
    if (value.length === 0) continue;
    out = out.split(value).join('[REDACTED]');
  }
  return out;
}

// `Headers.getSetCookie()` é a única forma correta de ler MÚLTIPLOS
// Set-Cookie: o `get('set-cookie')` concatena todos numa string única
// separada por ", " (verificado no Node desta versão), e o valor do cookie da
// SWS é um blob `Ext1 <base64>` — separar essa string por vírgula
// corromperia o valor, e não separar faria o primeiro cookie da lista
// (qualquer um, não necessariamente o nosso) vencer. Não há fallback de
// propósito: `getSetCookie` existe em toda versão de Node suportada pelo
// projeto (`engines.node >= 22.5`), então um fallback seria código morto que
// ninguém exercita — e, pior, mascararia com um valor corrompido o dia em que
// a API mudasse.
function readSetCookies(res: UndiciResponse): string[] {
  return res.headers.getSetCookie();
}

interface SwsResponse {
  status: number;
  ok: boolean;
  body: string;
  setCookies: string[];
}

// Uma única porta de saída para a rede: timeout curto por requisição (uma
// impressora desligada, ou ligada e ocupada imprimindo, não pode pendurar a
// rota do dashboard) cobrindo TAMBÉM a leitura do corpo — abortar só o
// handshake deixaria um corpo que nunca termina de chegar travar do mesmo
// jeito. Tipos de `undici` (não os globais de lib.dom): `undiciFetch` exige
// seu próprio `RequestInit`/devolve seu próprio `Response` — misturar com os
// tipos globais falha a compilação (a lib do undici e o `undici-types` que o
// lib.dom usa por baixo dos panos divergem em detalhes como `FormData`).
async function swsRequest(
  ipAddress: string,
  path: string,
  init: UndiciRequestInit,
  redactions: string[],
): Promise<SwsResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await undiciFetch(swsUrl(ipAddress, path), {
      ...init,
      signal: controller.signal,
      dispatcher: insecureAgent,
    });
    const body = await res.text();
    return { status: res.status, ok: res.ok, body, setCookies: readSetCookies(res) };
  } catch (error) {
    const causeMessage = error instanceof Error ? error.message : String(error);
    throw new PrinterSwsUnreachableError(ipAddress, redact(causeMessage, redactions));
  } finally {
    clearTimeout(timer);
  }
}

// --- API pública do serviço ----------------------------------------------

function extractSwsDataString(body: string, key: string): string | null {
  // Regex simples de propósito (não um parser de JS): o arquivo é gerado pelo
  // firmware, uma linha por atribuição, no formato
  // `SWS.DATA.buyorProductName = "HP HP Laser MFP 135w";`.
  const match = new RegExp(`SWS\\.DATA\\.${key}\\s*=\\s*(['"])([\\s\\S]*?)\\1`).exec(body);
  return match ? match[2] : null;
}

// ACHADO AO VIVO: o corpo do `login.jsp` NÃO é JSON estrito — é um literal
// de objeto JavaScript, com as chaves SEM ASPAS
// (`{success: true, passwordExpiration: false}`), confirmado repetidas
// vezes contra a HP real. `JSON.parse` falha nisso sempre. Tenta `JSON.parse`
// primeiro (cobre um firmware/dispositivo futuro que devolva JSON de
// verdade) e só cai pro regex quando o parse falha — mesmo espírito de
// `extractSwsDataString`: extrai só o campo que decide entre "entra" e "não
// entra", sem tentar escrever um parser tolerante completo.
//
// ACHADO DO CRÍTICO (2026-09-09): `RestartSystem.jsp` tem a MESMA
// ambiguidade que `login.jsp` já tinha — responde 200 tanto quando aceita o
// restart quanto quando RECUSA (`{success:false, errno:2}`, confirmado ao
// vivo na investigação do achado 4/errno:2 documentada no CLAUDE.md). Uma
// implementação que só olhasse o status HTTP relataria "reiniciada com
// sucesso" pra um reboot que a impressora recusou de verdade — daí este
// helper ser compartilhado entre `loginToSws` e `rebootHpPrinter`, não só
// do login.
//
// @returns `{ found: false }` quando o corpo está vazio, truncado, ou não
//   contém o campo `success` de jeito nenhum (nem como JSON válido, nem como
//   o literal sem aspas). `{ found: true, value }` caso contrário, com
//   `value` no tipo CRU (não convertido pra boolean) — importante pro login,
//   que precisa distinguir um `true` booleano de um valor truthy-mas-não-
//   -`true` (ex.: a string `"false"`, ou o número `1`): ver o `it.each` de
//   `loginToSws` que ancora essa distinção. Cada chamador decide o que fazer
//   com `found: false` — o login exige um veredito claro (sem campo
//   reconhecível, não dá pra confiar na sessão); o restart trata como
//   sucesso, já que o firmware pode cortar a conexão no meio do reboot de
//   verdade antes de terminar de escrever o corpo.
function extractSwsSuccessField(body: string): { found: boolean; value: unknown } {
  try {
    // JSON válido conta como `found`, mesmo sem a chave `success` — o valor
    // vem `undefined` nesse caso, e cada chamador decide o que fazer com
    // isso (login: `undefined !== true` → recusa; restart: `undefined !==
    // false` → não recusa). Só o caso "corpo nem é JSON nem contém o
    // literal sem aspas" vira `found: false`.
    const parsed = JSON.parse(body) as Record<string, unknown>;
    return { found: true, value: parsed?.success };
  } catch {
    const match = /\bsuccess\s*:\s*(true|false)\b/.exec(body);
    return match ? { found: true, value: match[1] === 'true' } : { found: false, value: undefined };
  }
}

/**
 * Lê a identidade do dispositivo do arquivo estático `sws_data.js`.
 *
 * ACHADO AO VIVO (captura DevTools de um reboot real): o `csrfToken` deste
 * arquivo MUDA entre uma leitura sem sessão e uma leitura autenticada — e é
 * o valor PÓS-login que a SWS exige em qualquer POST de escrita autenticado
 * (confirmado especificamente contra `RestartSystem.jsp`: usar o csrfToken
 * pré-login, mesmo com sessão/cookies corretos, é recusado). Por isso este
 * helper aceita um `cookie` opcional — sem ele, é o passo inicial sem
 * autenticação (`fetchDeviceIdentity(ipAddress)`, usado antes do login,
 * inclusive pra montar o próprio login); com ele, relê os mesmos dados DEPOIS
 * de autenticado, pra pegar o csrfToken que passa a valer pro resto da
 * sessão (ver `rebootHpPrinter`).
 *
 * @param ipAddress IP já resolvido da impressora (ver resolvePrinterIp na
 *   rota — este serviço nunca resolve IP por conta própria).
 * @param cookie Cookie de sessão já autenticado (ver `SwsSession.cookie`).
 *   Omitido: leitura sem sessão (o único passo do fluxo de login que NÃO
 *   exige autenticação).
 * @returns Nome do produto, número de série e csrfToken (válido pro
 *   contexto — pré ou pós-login — em que foi lido).
 * @throws {PrinterSwsUnreachableError} timeout/falha de rede.
 * @throws {PrinterSwsRequestError} status não-2xx, ou corpo sem os três
 *   campos esperados (o que é o caso de qualquer dispositivo que não seja uma
 *   HP/SWS neste IP).
 */
export async function fetchDeviceIdentity(ipAddress: string, cookie?: string): Promise<SwsDeviceIdentity> {
  const res = await swsRequest(
    ipAddress,
    IDENTITY_PATH,
    { method: 'GET', headers: cookie ? { Cookie: cookie } : undefined },
    [],
  );
  if (!res.ok) {
    throw new PrinterSwsRequestError(ipAddress, `GET ${IDENTITY_PATH} devolveu status ${res.status}`, res.status);
  }

  const productName = extractSwsDataString(res.body, 'buyorProductName');
  const productSerial = extractSwsDataString(res.body, 'productSerial');
  const csrfToken = extractSwsDataString(res.body, 'csrfToken');
  if (productName === null || productSerial === null || csrfToken === null) {
    // NÃO ecoamos o corpo recebido na mensagem: pode ser uma página HTML
    // inteira (a Brother devolve a WBM dela) e nada ali é útil pra quem lê o
    // erro além do fato de não ser uma SWS.
    throw new PrinterSwsRequestError(
      ipAddress,
      `${IDENTITY_PATH} não contém os campos SWS.DATA esperados (buyorProductName/productSerial/csrfToken) — ` +
        'o dispositivo neste IP provavelmente não é uma impressora HP com SWS',
      res.status,
    );
  }

  return { productName, productSerial, csrfToken };
}

// Extrai o cookie `Authentication` do Set-Cookie da resposta de login. O
// valor real é algo como `Authentication=Ext1 <blob>` — devolvemos o par
// `nome=valor` exatamente como veio (só descartando os atributos após o
// primeiro `;`), para reenviá-lo sem reinterpretar nada.
function extractAuthenticationCookie(setCookies: string[]): string | null {
  for (const raw of setCookies) {
    const pair = raw.split(';')[0]?.trim();
    if (pair && /^Authentication=/i.test(pair)) return pair;
  }
  return null;
}

/**
 * Autentica na SWS ("Ext1") e devolve a sessão a ser reenviada.
 *
 * @param ipAddress IP já resolvido da impressora.
 * @param credentials Usuário/senha do painel web (do cadastro — nunca
 *   valores hardcoded: a senha padrão de fábrica pode e deve mudar).
 * @param identity Identidade já lida por `fetchDeviceIdentity`. Recebida
 *   como parâmetro (em vez de buscada aqui) para não fazer duas vezes o
 *   mesmo GET num fluxo que também precisa do `csrfToken` depois.
 * @returns A sessão autenticada (cookie).
 * @throws {PrinterSwsUnreachableError} timeout/falha de rede.
 * @throws {PrinterSwsAuthenticationError} a SWS recusou a credencial.
 * @throws {PrinterSwsRequestError} status não-2xx, corpo de login ilegível,
 *   ou sucesso sem cookie de sessão.
 */
export async function loginToSws(
  ipAddress: string,
  credentials: SwsCredentials,
  identity: SwsDeviceIdentity,
): Promise<SwsSession> {
  const authentication = buildLoginAuthentication(identity, credentials);
  const body = new URLSearchParams({
    Authentication: authentication,
    'csrf-token': identity.csrfToken,
  }).toString();

  const res = await swsRequest(
    ipAddress,
    LOGIN_PATH,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: swsOrigin(ipAddress) },
      body,
    },
    [credentials.password],
  );

  if (!res.ok) {
    throw new PrinterSwsRequestError(ipAddress, `POST ${LOGIN_PATH} devolveu status ${res.status}`, res.status);
  }

  // A SWS responde 200 tanto no sucesso quanto na recusa da credencial — o
  // que distingue os dois é o `success` do corpo, não o status HTTP. Ver
  // `extractSwsSuccessField` (helper compartilhado com `rebootHpPrinter` —
  // achado do crítico: o restart tem a MESMA ambiguidade 200+success:false).
  const successField = extractSwsSuccessField(res.body);
  if (!successField.found) {
    throw new PrinterSwsRequestError(
      ipAddress,
      `a resposta de ${LOGIN_PATH} não é JSON nem contém um campo "success" reconhecível`,
      res.status,
    );
  }

  // Comparação ESTRITA com `true` (não `!successField.value`) de propósito —
  // ver o `it.each` de teste: um `success` truthy-mas-não-`true` (ex.: a
  // string `"false"`) precisa ser tratado como recusa, não como sucesso.
  if (successField.value !== true) {
    throw new PrinterSwsAuthenticationError(ipAddress, credentials.username);
  }

  const authCookie = extractAuthenticationCookie(res.setCookies);
  if (!authCookie) {
    // Sucesso declarado sem cookie: qualquer requisição seguinte seria
    // anônima. Falhar aqui é obrigatório — um POST de reboot anônimo poderia
    // ser rejeitado silenciosamente e nós relataríamos "reiniciada".
    throw new PrinterSwsRequestError(
      ipAddress,
      'login bem-sucedido mas sem cookie de sessão Authentication na resposta',
      res.status,
    );
  }

  // `SESSION_COOKIE_DEFAULTS` — ver a DECISÃO logo acima de `SwsSession`:
  // sem esses 4 cookies extras (setados só no navegador via JS, nunca por
  // `Set-Cookie` daqui), o POST de restart é aceito pelo servidor mas
  // recusado pela aplicação. Combinado uma única vez aqui, no jar devolvido
  // por `loginToSws` — qualquer chamada futura autenticada (não só o reboot)
  // reaproveita o mesmo jar completo automaticamente.
  return { cookie: `${authCookie}; ${SESSION_COOKIE_DEFAULTS}` };
}

/**
 * Reinicia a impressora HP de verdade: lê a identidade sem sessão, autentica
 * na SWS, relê a identidade JÁ AUTENTICADO (csrfToken novo — ver a DECISÃO em
 * `fetchDeviceIdentity`) e só então dispara o POST de restart.
 *
 * **CONFIRMADO AO VIVO POR COMPLETO** (não é mais suposição): um reboot real
 * foi disparado e capturado via DevTools contra a HP do Financeiro
 * (172.16.0.89) numa sessão de continuação, com a página `Segurança → System
 * Security → Reiniciar dispositivo` aberta e o botão "Reiniciar agora"
 * clicado de propósito. Fechou 3 lacunas que a implementação anterior
 * (baseada só na leitura do código-fonte do `Reboot.js`, nunca testada
 * contra o dispositivo) tinha:
 *   1. **Método é POST**, não GET — a pesquisa anterior tratava isso como
 *      suposição; a captura real confirma.
 *   2. **`Referer` é obrigatório** neste endpoint especificamente (`Origin`
 *      sozinho, que basta pro `login.jsp`, NÃO basta aqui — sem os dois, a
 *      SWS recusa a requisição antes até de chegar na lógica da aplicação,
 *      com uma página de erro genérica do próprio servidor embarcado).
 *   3. **4 cookies extras são obrigatórios** além de `Authentication` — ver
 *      `SESSION_COOKIE_DEFAULTS`. Sem eles (e mesmo com Origin/Referer
 *      certos), a aplicação aceita a requisição mas RECUSA o reboot
 *      (`{success:false, errno:2}`) — só descoberto porque a diferença entre
 *      "aceito pelo servidor" e "aceito pela aplicação" é sutil o bastante
 *      pra não aparecer em nenhum teste que não seja contra o dispositivo
 *      real.
 *
 * O `pinCode` exigido pelo firmware é literalmente o MAC da própria
 * impressora em MAIÚSCULAS com dois-pontos (confirmado ao vivo lendo
 * `reboot.json` — ver a pesquisa). Por isso NÃO precisamos chamar
 * `reboot.json`: o MAC já está no cadastro. O `csrf-token` vai no corpo,
 * junto do `pinCode` — confirmado que é exatamente esses 2 campos, nada mais
 * (o corpo capturado ao vivo bate byte a byte com o que este código monta).
 *
 * @param ipAddress IP já resolvido da impressora.
 * @param mac MAC da impressora, como está no cadastro (minúsculo com
 *   dois-pontos) — a normalização para maiúsculas é feita aqui.
 * @param credentials Usuário/senha do painel web (do cadastro).
 * @returns Resolve sem valor quando a SWS aceita o comando de restart.
 * @throws {PrinterSwsUnreachableError} timeout/falha de rede em qualquer um
 *   dos quatro passos.
 * @throws {PrinterSwsAuthenticationError} credencial recusada no login.
 * @throws {PrinterSwsRequestError} resposta inutilizável/não-2xx em qualquer
 *   um dos quatro passos.
 */
export async function rebootHpPrinter(
  ipAddress: string,
  mac: string,
  credentials: SwsCredentials,
): Promise<void> {
  const identity = await fetchDeviceIdentity(ipAddress);
  const session = await loginToSws(ipAddress, credentials, identity);

  // Relê a identidade AUTENTICADA (mesmo endpoint, agora com o cookie de
  // sessão) — o csrfToken pré-login usado pra montar o login não é o que a
  // SWS aceita nos POSTs de escrita seguintes. Ver a DECISÃO no docblock de
  // `fetchDeviceIdentity`.
  const sessionIdentity = await fetchDeviceIdentity(ipAddress, session.cookie);

  const body = new URLSearchParams({
    pinCode: mac.toUpperCase(),
    'csrf-token': sessionIdentity.csrfToken,
  }).toString();

  const res = await swsRequest(
    ipAddress,
    REBOOT_PATH,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: swsOrigin(ipAddress),
        Referer: swsReferer(ipAddress),
        Cookie: session.cookie,
      },
      body,
    },
    [credentials.password],
  );

  if (!res.ok) {
    throw new PrinterSwsRequestError(ipAddress, `POST ${REBOOT_PATH} devolveu status ${res.status}`, res.status);
  }

  // ACHADO DO CRÍTICO (2026-09-09): status 2xx sozinho NÃO significa que a
  // SWS aceitou o reboot — confirmado ao vivo (investigação do errno:2,
  // documentada no CLAUDE.md) que `RestartSystem.jsp` responde 200 tanto
  // quando aceita quanto quando RECUSA (`{success:false, errno:2}`, ex.: uma
  // sessão que perdeu validade entre o login e o restart). A versão anterior
  // deste código não olhava o corpo — um reboot recusado seria relatado ao
  // operador como "reiniciada com sucesso", exatamente o tipo de falha
  // silenciosa que este projeto trata como bug sério (mesma classe dos
  // achados de "invisibilidade silenciosa" de outras subtarefas).
  //
  // Só falha em `success === false` explícito — corpo vazio/truncado/sem o
  // campo (`found: false`) continua sendo tratado como sucesso, porque a
  // impressora pode legitimamente cortar a conexão no meio do reboot de
  // verdade antes de terminar de escrever a resposta.
  const successField = extractSwsSuccessField(res.body);
  if (successField.found && successField.value === false) {
    throw new PrinterSwsRequestError(
      ipAddress,
      `${REBOOT_PATH} recusou o reboot (success:false) — verifique se a credencial do painel ainda é válida`,
      res.status,
    );
  }
}
