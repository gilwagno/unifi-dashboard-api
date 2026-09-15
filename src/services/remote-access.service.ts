import { env } from '../config/env.js';

// Cliente da API REST do Apache Guacamole (Onda 4 — Acesso Remoto, ver
// docs/remote-access-plan.md e docs/guacamole-setup.md).
//
// Mesmo espírito de unifi-classic.service.ts e ad.service.ts: uma função
// central que resolve autenticação (`withToken`), erros tipados com uma
// classe base, e a feature inteira desligada de forma explícita quando as
// env vars opcionais não estão configuradas.
//
// O Guacamole é o gateway que fala RDP/VNC/SSH de verdade; este serviço só
// gerencia o CATÁLOGO de conexões dele (criar/listar/remover). Abrir sessão
// é a subtarefa 5 e não mora aqui.
//
// ────────────────────────────────────────────────────────────────────────
// DUAS REGRAS DURAS DESTE MÓDULO — ler antes de mexer
// ────────────────────────────────────────────────────────────────────────
//
// 1. O TOKEN DE SESSÃO NUNCA SAI DAQUI.
//    O Guacamole autentica por um token opaco que, na API dele, viaja como
//    QUERY STRING (`?token=…`). Isso é hostil a um projeto que loga erro:
//    um `fetch` que falha costuma carregar a URL na mensagem, e a URL
//    carrega o token. Por isso:
//      - a URL com token nunca é montada fora de `withToken`;
//      - todo erro lançado daqui passa por `redactToken()` antes de virar
//        mensagem — o token é substituído por `<token>`;
//      - o token não é campo de nenhum erro tipado, nem valor de retorno de
//        nenhuma função exportada.
//    O precedente é o `attemptedPassword` da Onda 3: lá o vazamento chegou
//    ao log pelo serializador do pino, através de uma propriedade
//    enumerável de um Error. Aqui o vetor é a URL, e a defesa é a mesma —
//    o valor não pode existir em nada que seja serializado.
//
// 2. PASSE-THROUGH NÃO PERSISTE CREDENCIAL. (decisão do usuário, 2026-09-15)
//    A autenticação escolhida para as sessões é passe-through: quem abre a
//    sessão usa a PRÓPRIA credencial de domínio, para que o log do PC alvo
//    registre a pessoa real e não uma conta de serviço genérica.
//
//    A consequência, que vale desde já mesmo que a abertura de sessão só
//    chegue na subtarefa 5: as conexões criadas aqui NÃO carregam
//    `username`/`password` nos parâmetros. Um catálogo de conexões RDP com
//    credencial embutida é um cofre de senhas de domínio — persistido num
//    Postgres, alcançável por quem tiver acesso ao Guacamole, e nunca mais
//    auditável de volta a uma pessoa. A credencial de quem acessa é usada
//    para montar a sessão e descartada; nunca é gravada "para reconectar".
//
//    `createRdpConnection` reflete isso estruturalmente: não existe
//    parâmetro para receber credencial. Quem precisar de uma reconexão sem
//    digitar senha está pedindo exatamente o que esta regra proíbe.

// Nome do parâmetro que carrega a ÂNCORA de correlação AD ↔ Guacamole.
//
// Por que PARÂMETRO e não ATRIBUTO: sondado contra o Guacamole real
// (tools/guacamole-attr-probe.mjs, 2026-09-15) — os atributos de conexão são
// um conjunto FECHADO de 7 campos, e um atributo custom é aceito com
// **HTTP 200 e descartado em silêncio**, sem erro nem aviso. Construir o
// sync sobre ele daria uma âncora que parece gravada e não está: o sync
// duplicaria conexão a cada rodada, reportando sucesso todas as vezes.
// Parâmetros, ao contrário, são chave/valor livre e sobrevivem à releitura.
//
// O valor é o `objectGUID` do computador — imutável, sobrevive a renomeação
// e a mudança de OU. Mesmo papel do `external_id` no módulo de VPN.
export const AD_OBJECT_GUID_PARAM = 'ad-object-guid';

// Base comum de todo erro tipado deste módulo — mesmo motivo de `AdError`
// na Onda 3: quem herda daqui atravessa intacto o `catch` central em vez de
// ser reembrulhado em erro genérico, e uma subtarefa futura que adicione um
// erro novo não precisa lembrar de somá-lo a nenhuma lista de `instanceof`.
export class RemoteAccessError extends Error {}

export class RemoteAccessNotConfiguredError extends RemoteAccessError {
  constructor() {
    super(
      'Acesso remoto não configurado: defina GUACAMOLE_URL, GUACAMOLE_USERNAME e ' +
        'GUACAMOLE_PASSWORD no .env (ver docs/guacamole-setup.md).',
    );
    this.name = 'RemoteAccessNotConfiguredError';
  }
}

export class RemoteAccessAuthError extends RemoteAccessError {
  constructor(message: string) {
    super(message);
    this.name = 'RemoteAccessAuthError';
  }
}

export class RemoteAccessRequestError extends RemoteAccessError {
  constructor(
    message: string,
    public readonly status?: number,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = 'RemoteAccessRequestError';
  }
}

export class RemoteAccessConnectionNotFoundError extends RemoteAccessError {
  constructor(identifier: string) {
    super(`Conexão "${identifier}" não existe no Guacamole`);
    this.name = 'RemoteAccessConnectionNotFoundError';
  }
}

export interface RemoteAccessConnection {
  identifier: string;
  name: string;
  protocol: string;
  /** Hostname RDP configurado. `null` quando o Guacamole não devolve os parâmetros. */
  hostname: string | null;
  /** Quantidade de sessões ativas nesta conexão, como o Guacamole reporta. */
  activeConnections: number;
  /**
   * objectGUID do computador do AD que originou esta conexão, quando ela foi
   * criada pelo sync. `null` numa conexão criada à mão no Guacamole — e essa
   * distinção é o que protege o trabalho manual de um operador: o sync só
   * mexe no que ele mesmo ancorou.
   */
  adObjectGuid: string | null;
}

interface GuacamoleConnectionPayload {
  identifier?: string;
  name?: string;
  protocol?: string;
  activeConnections?: number;
  parameters?: Record<string, string>;
}

function isConfigured(): boolean {
  return Boolean(env.GUACAMOLE_URL && env.GUACAMOLE_USERNAME && env.GUACAMOLE_PASSWORD);
}

// Remove qualquer ocorrência de `token=<valor>` de um texto antes de ele
// virar mensagem de erro. Ver a regra 1 no topo do arquivo: a API do
// Guacamole carrega o token na query string, então a URL em si é material
// sensível, e mensagens de erro de rede costumam incluí-la.
//
// Deliberadamente por PADRÃO (`token=…`) e não por comparação com o valor
// atual do token: o valor muda a cada login, e uma redação que dependa de
// ter o valor em mãos falha exatamente no caminho de erro em que o token
// pode ter vindo de outra tentativa.
export function redactToken(text: string): string {
  return text.replace(/([?&]token=)[^&\s"']+/gi, '$1<token>');
}

function redactError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return redactToken(message);
}

// Sessão em memória a nível de módulo, mesmo padrão de
// unifi-classic.service.ts. O token do Guacamole expira por inatividade
// (1h por padrão), então ele é reaproveitado entre chamadas e renovado
// quando o servidor o recusa — ver `withToken`.
let session: { token: string } | null = null;

/** Só para testes: descarta o token em cache. */
export function resetSessionForTests(): void {
  session = null;
}

function baseUrl(): string {
  // `GUACAMOLE_URL` pode vir com ou sem barra no fim; normalizar aqui evita
  // `//api/tokens` (que algumas versões do Tomcat tratam como 404).
  return env.GUACAMOLE_URL!.replace(/\/+$/, '');
}

async function login(): Promise<string> {
  if (!isConfigured()) throw new RemoteAccessNotConfiguredError();

  let res: Response;
  try {
    res = await fetch(`${baseUrl()}/api/tokens`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        username: env.GUACAMOLE_USERNAME!,
        password: env.GUACAMOLE_PASSWORD!,
      }),
    });
  } catch (error) {
    throw new RemoteAccessRequestError(
      `Guacamole inalcançável em ${baseUrl()}: ${redactError(error)}`,
      undefined,
      error,
    );
  }

  if (res.status === 403 || res.status === 401) {
    // Sem eco da credencial na mensagem — nem do usuário, que já identifica
    // qual segredo rotacionar para quem lê o log.
    throw new RemoteAccessAuthError(
      'Guacamole recusou a credencial do usuário de serviço (GUACAMOLE_USERNAME/GUACAMOLE_PASSWORD).',
    );
  }
  if (!res.ok) {
    throw new RemoteAccessRequestError(`Login no Guacamole falhou com HTTP ${res.status}`, res.status);
  }

  const body = (await res.json().catch(() => null)) as { authToken?: unknown } | null;
  if (!body || typeof body.authToken !== 'string' || body.authToken.length === 0) {
    throw new RemoteAccessRequestError('Login no Guacamole não devolveu authToken');
  }
  return body.authToken;
}

type UrlBuilder = (path: string, query?: Record<string, string>) => string;

// Executa uma chamada autenticada. O callback recebe uma função que monta a
// URL — o token nunca é entregue ao chamador, só interpolado aqui dentro
// (regra 1 do topo).
//
// Um token expirado devolve 401/403; nesse caso a chamada é repetida UMA vez
// com token novo. Só uma: se a credencial de serviço estiver errada, o
// segundo login falha em `login()` com erro claro, em vez de o serviço
// entrar em laço contra o Guacamole.
async function withToken<T>(fn: (url: UrlBuilder) => Promise<T>): Promise<T> {
  if (!isConfigured()) throw new RemoteAccessNotConfiguredError();

  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (!session) session = { token: await login() };
    const token = session.token;

    const url: UrlBuilder = (path, query = {}) => {
      const params = new URLSearchParams({ ...query, token });
      return `${baseUrl()}/api/session/data/${encodeURIComponent(env.GUACAMOLE_DATA_SOURCE)}${path}?${params}`;
    };

    try {
      return await fn(url);
    } catch (error) {
      const expired =
        error instanceof RemoteAccessRequestError &&
        (error.status === 401 || error.status === 403) &&
        attempt === 0;
      if (!expired) throw error;
      // Token velho: descarta e tenta de novo com um novo login.
      session = null;
    }
  }

  // Inalcançável: o laço ou retorna ou lança. Mantido explícito para o
  // compilador e para deixar claro que não existe terceiro caminho.
  throw new RemoteAccessRequestError('Falha inesperada ao autenticar no Guacamole');
}

async function parseOrThrow(res: Response, what: string): Promise<unknown> {
  if (res.status === 404) return null;
  if (!res.ok) {
    // O corpo do Guacamole traz `message`, útil e sem segredo — mas passa
    // pela redação mesmo assim, porque ele ecoa a requisição em alguns erros.
    const detail = redactToken(await res.text().catch(() => ''));
    throw new RemoteAccessRequestError(
      `${what} falhou com HTTP ${res.status}${detail ? `: ${detail.slice(0, 300)}` : ''}`,
      res.status,
    );
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

async function guacFetch(target: string, what: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(target, init);
  } catch (error) {
    throw new RemoteAccessRequestError(`${what}: ${redactError(error)}`, undefined, error);
  }
}

function toConnection(payload: GuacamoleConnectionPayload, identifier: string): RemoteAccessConnection {
  return {
    identifier,
    name: typeof payload.name === 'string' ? payload.name : identifier,
    protocol: typeof payload.protocol === 'string' ? payload.protocol : 'unknown',
    // `parameters` só vem no GET de uma conexão específica; na listagem o
    // Guacamole omite. `null` distingue "não informado" de "vazio" — a
    // mesma distinção que o módulo de impressoras paga caro para manter.
    hostname:
      payload.parameters && typeof payload.parameters.hostname === 'string'
        ? payload.parameters.hostname
        : null,
    activeConnections: typeof payload.activeConnections === 'number' ? payload.activeConnections : 0,
    adObjectGuid:
      payload.parameters && typeof payload.parameters[AD_OBJECT_GUID_PARAM] === 'string'
        ? payload.parameters[AD_OBJECT_GUID_PARAM]
        : null,
  };
}

async function listConnections(): Promise<RemoteAccessConnection[]> {
  return withToken(async (url) => {
    const res = await guacFetch(url('/connections'), 'Listar conexões do Guacamole');
    const body = (await parseOrThrow(res, 'Listar conexões do Guacamole')) as Record<
      string,
      GuacamoleConnectionPayload
    > | null;
    if (!body) return [];
    // A API devolve um OBJETO indexado por identifier, não um array.
    return Object.entries(body).map(([identifier, payload]) => toConnection(payload, identifier));
  });
}

// Listagem COM os parâmetros de cada conexão — e portanto com a âncora
// `ad-object-guid` preenchida.
//
// Custa 1 + N requisições, porque a listagem do Guacamole não devolve
// parâmetros (só o GET de uma conexão específica devolve). É o preço da
// âncora viver junto do objeto no Guacamole em vez de numa tabela local, e é
// irrelevante na escala deste domínio (~50 computadores). Registrado porque
// numa rede grande deixaria de ser: o plano B, se isso um dia doer, é um
// cache local da correlação — mesmo padrão de SQLite que o projeto já usa.
//
// As leituras são feitas em série de propósito: o Guacamole roda num Tomcat
// pequeno ao lado do backend, e uma rajada de N requisições paralelas contra
// ele não compra nada nesta escala.
async function listConnectionsWithAnchors(): Promise<RemoteAccessConnection[]> {
  const connections = await listConnections();
  const detailed: RemoteAccessConnection[] = [];
  for (const connection of connections) {
    detailed.push(await getConnection(connection.identifier));
  }
  return detailed;
}

async function getConnection(identifier: string): Promise<RemoteAccessConnection> {
  return withToken(async (url) => {
    const path = `/connections/${encodeURIComponent(identifier)}`;
    const res = await guacFetch(url(path), 'Ler conexão do Guacamole');
    const body = (await parseOrThrow(res, 'Ler conexão do Guacamole')) as GuacamoleConnectionPayload | null;
    if (!body) throw new RemoteAccessConnectionNotFoundError(identifier);

    // Os parâmetros (hostname, porta, segurança) vêm de um recurso à parte.
    const paramsRes = await guacFetch(url(`${path}/parameters`), 'Ler parâmetros da conexão');
    const parameters = (await parseOrThrow(paramsRes, 'Ler parâmetros da conexão')) as Record<
      string,
      string
    > | null;

    return toConnection({ ...body, parameters: parameters ?? undefined }, identifier);
  });
}

export interface CreateRdpConnectionInput {
  /** Nome exibido no Guacamole — na subtarefa 4 será o nome do computador no AD. */
  name: string;
  /** Hostname ou IP do PC alvo. */
  hostname: string;
  port?: number;
  /** objectGUID do computador do AD — a âncora do sync (subtarefa 4). */
  adObjectGuid?: string;
}

// Cria uma conexão RDP.
//
// NÃO recebe credencial, e isso é estrutural, não esquecimento — ver a regra
// 2 no topo do arquivo. Os parâmetros abaixo são os mínimos para o guacd
// falar com um Windows de domínio:
//
//   security=nla        — exige autenticação antes de montar a sessão. É o
//                         que a GPO documentada em
//                         docs/remote-access-network-prereqs.md liga do lado
//                         do Windows; sem isso aqui, a conexão negocia para
//                         baixo e a proteção vira decorativa.
//   ignore-cert=true    — os PCs do domínio usam certificado RDP
//                         autoassinado. Sem isto o guacd recusa e a conexão
//                         nunca abre.
//
//                         ⛔ DEPENDÊNCIA MÚTUA, não nota de rodapé: este
//                         parâmetro e a regra de firewall que restringe o
//                         3389 ao host do guacd são um par indivisível — ver
//                         docs/remote-access-network-prereqs.md, item 2.
//                         Sem a regra, o guacd não verifica com quem fala e
//                         um alvo forjado receberia a credencial de domínio
//                         de quem acessa. Quem afrouxar o firewall precisa,
//                         no mesmo momento, tirar este parâmetro. A saída
//                         definitiva (onda futura) é certificado emitido
//                         pela PKI interna e verificação de verdade.
//   resize-method       — ajusta a resolução ao navegador.
function buildRdpParameters(input: CreateRdpConnectionInput, port: number): Record<string, string> {
  const parameters: Record<string, string> = {
    hostname: input.hostname,
    port: String(port),
    security: 'nla',
    'ignore-cert': 'true',
    'resize-method': 'display-update',
  };
  if (input.adObjectGuid) parameters[AD_OBJECT_GUID_PARAM] = input.adObjectGuid;
  return parameters;
}

async function createRdpConnection(input: CreateRdpConnectionInput): Promise<RemoteAccessConnection> {
  const port = input.port ?? 3389;

  return withToken(async (url) => {
    const res = await guacFetch(url('/connections'), 'Criar conexão no Guacamole', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        parentIdentifier: 'ROOT',
        name: input.name,
        protocol: 'rdp',
        parameters: buildRdpParameters(input, port),
        attributes: {},
      }),
    });

    const body = (await parseOrThrow(res, 'Criar conexão no Guacamole')) as GuacamoleConnectionPayload | null;
    if (!body || typeof body.identifier !== 'string') {
      throw new RemoteAccessRequestError('Criação de conexão não devolveu identifier');
    }
    return toConnection({ ...body, parameters: buildRdpParameters(input, port) }, body.identifier);
  });
}

// Atualiza uma conexão existente.
//
// O PUT do Guacamole é FULL-OBJECT: o que não for enviado é perdido. Por
// isso os parâmetros são remontados inteiros por `buildRdpParameters` (a
// MESMA função do create), em vez de um merge sobre o que veio da leitura —
// assim create e update não podem divergir, que é a forma clássica deste bug
// (o sync "atualiza" e apaga em silêncio o `security=nla` ou a âncora).
async function updateRdpConnection(
  identifier: string,
  input: CreateRdpConnectionInput,
): Promise<RemoteAccessConnection> {
  const port = input.port ?? 3389;

  return withToken(async (url) => {
    const res = await guacFetch(
      url(`/connections/${encodeURIComponent(identifier)}`),
      'Atualizar conexão no Guacamole',
      {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          identifier,
          parentIdentifier: 'ROOT',
          name: input.name,
          protocol: 'rdp',
          parameters: buildRdpParameters(input, port),
          attributes: {},
        }),
      },
    );
    if (res.status === 404) throw new RemoteAccessConnectionNotFoundError(identifier);
    await parseOrThrow(res, 'Atualizar conexão no Guacamole');
    return toConnection(
      { identifier, name: input.name, protocol: 'rdp', parameters: buildRdpParameters(input, port) },
      identifier,
    );
  });
}

// Remove uma conexão.
//
// Idempotente por DECISÃO, não por acaso: um 404 aqui significa "a conexão
// não existe", que é exatamente o estado desejado de quem chamou delete.
// Transformar isso em erro faria a sincronização da subtarefa 4 quebrar ao
// reprocessar um computador já removido — e, pior, faria um operador
// concluir que a conexão ainda existe. É o mesmo raciocínio que a revogação
// de grupo do AD custou duas rodadas de revisão para acertar na Onda 3: o
// que importa é o ESTADO FINAL, não o código de retorno da operação.
async function deleteConnection(identifier: string): Promise<{ removed: boolean }> {
  return withToken(async (url) => {
    const res = await guacFetch(
      url(`/connections/${encodeURIComponent(identifier)}`),
      'Remover conexão do Guacamole',
      { method: 'DELETE' },
    );
    if (res.status === 404) return { removed: false };
    await parseOrThrow(res, 'Remover conexão do Guacamole');
    return { removed: true };
  });
}

export const remoteAccessService = {
  isConfigured,
  listConnections,
  listConnectionsWithAnchors,
  getConnection,
  createRdpConnection,
  updateRdpConnection,
  deleteConnection,
};
