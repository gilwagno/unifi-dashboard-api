import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  CONTROLLER_HOST: z.string().min(1, 'CONTROLLER_HOST é obrigatório'),
  UNIFI_API_KEY: z.string().min(1, 'UNIFI_API_KEY é obrigatório'),
  // Precisa ser o UUID do site (campo "id" de GET /sites), não o
  // internalReference "default" — a API de Integração rejeita esse valor
  // como siteId.
  SITE_ID: z.string().min(1, 'SITE_ID é obrigatório (o UUID de GET /sites, não "default")'),
  UNIFI_ALLOW_SELF_SIGNED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),

  // Credenciais do PAINEL do controller (não confundir com
  // ADMIN_USER/ADMIN_PASSWORD_HASH, que são o login deste dashboard).
  // Opcionais: sem elas, a API clássica (usada só para bloquear/desbloquear
  // clientes de verdade) fica indisponível, mas o resto do app funciona
  // normalmente — ver ClassicApiNotConfiguredError em
  // src/services/unifi-classic.service.ts.
  UNIFI_CONTROLLER_USER: z.string().min(1).optional(),
  UNIFI_CONTROLLER_PASSWORD: z.string().min(1).optional(),
  // internalReference do site pra API clássica (ex: "default") — DIFERENTE
  // do SITE_ID (UUID) usado pela Integration API.
  UNIFI_CONTROLLER_SITE: z.string().min(1).default('default'),

  JWT_SECRET: z.string().min(16, 'JWT_SECRET deve ter pelo menos 16 caracteres'),
  ADMIN_USER: z.string().min(1),
  ADMIN_PASSWORD_HASH: z.string().min(1, 'Gere com bcryptjs.hashSync'),
  PORT: z.coerce.number().default(3000),

  // Janela compartilhada por todos os limites abaixo (formato aceito pelo
  // @fastify/rate-limit, ex: "1 minute", "30 seconds").
  RATE_LIMIT_WINDOW: z.string().default('1 minute'),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  RATE_LIMIT_CLIENT_ACTION_MAX: z.coerce.number().int().positive().default(10),
  RATE_LIMIT_DEVICE_RESTART_MAX: z.coerce.number().int().positive().default(5),

  // Arquivo do banco SQLite do módulo de manutenção de impressoras (ver
  // src/db/printers.db.ts) — primeira persistência em disco do projeto
  // (o resto do backend é tudo estado em memória). Caminho relativo ao
  // diretório de onde o processo é iniciado.
  PRINTERS_DB_FILE: z.string().min(1).default('./printers.db'),

  // Arquivo do banco SQLite do histórico de banda de longo prazo (amostras
  // finas de 48h + rollup horário de 30 dias — ver
  // src/db/bandwidth-history.db.ts). Banco PRÓPRIO, separado de
  // PRINTERS_DB_FILE (domínios diferentes, sem relação um com o outro).
  BANDWIDTH_HISTORY_DB_FILE: z.string().min(1).default('./bandwidth-history.db'),

  // Arquivo onde o log de auditoria de ações do dashboard (quem bloqueou
  // um cliente, reiniciou um device, rotacionou a senha SSH, etc.) é
  // persistido (append-only, uma linha JSON por entrada). Ver
  // src/services/audit-log.service.ts.
  AUDIT_LOG_FILE: z.string().min(1).default('./audit.log'),

  // Onda 3 (módulo de Active Directory + ponte 802.1X, ver
  // docs/ad-module-plan.md) — todas opcionais, mesmo tratamento de
  // UNIFI_CONTROLLER_USER/PASSWORD: sem elas, ad.service.ts lança
  // AdNotConfiguredError e o módulo fica indisponível de forma clara, sem
  // derrubar o resto do app. AD_URL precisa ser `ldaps://` (LDAPS) — o
  // client (`unicodePwd`, a forma padrão do AD de setar senha) só é aceito
  // por LDAP criptografado; o AD recusa a operação em LDAP puro.
  AD_URL: z.string().min(1).optional(),
  // DN base do domínio (ex.: "DC=evokaudio,DC=local") — raiz de onde
  // buscas/gravações partem quando um DN mais específico não é dado.
  AD_BASE_DN: z.string().min(1).optional(),
  // DN da conta de serviço usada pro bind (ex.:
  // "CN=svc-dashboard,CN=Users,DC=evokaudio,DC=local") — precisa de
  // permissão de escrita nos objetos que este módulo gerencia.
  AD_BIND_DN: z.string().min(1).optional(),
  AD_BIND_PASSWORD: z.string().min(1).optional(),
  // OU (organizational unit) onde usuários novos são criados e onde a
  // busca de usuários procura por padrão (ex.:
  // "OU=Funcionarios,DC=evokaudio,DC=local").
  AD_USERS_OU: z.string().min(1).optional(),
  // DN do grupo que a ponte 802.1X usa como "tem acesso à rede" — NPS no
  // Windows Server valida contra membership neste grupo. Só é exigido por
  // POST/DELETE /ad/users/:username/network-access, não pelo resto do
  // módulo (CRUD de usuário/grupo/computador funciona sem ele).
  AD_NETWORK_ACCESS_GROUP_DN: z.string().min(1).optional(),
  // Controla a verificação de certificado TLS APENAS da conexão LDAPS deste
  // módulo (`tlsOptions.rejectUnauthorized` passado por conexão ao `Client`
  // do `ldapts`) — nunca um `NODE_TLS_REJECT_UNAUTHORIZED` global de
  // processo (o padrão que `UNIFI_ALLOW_SELF_SIGNED`/unifi.service.ts usa
  // e que o plano da Onda 3, subtarefa 6, pediu explicitamente para NÃO
  // repetir aqui: afetaria TODA conexão TLS do processo, não só o AD).
  // Default `true` (verifica de verdade, como qualquer LDAPS de produção
  // contra um DC real) — só existe pra permitir os testes de integração
  // (`tests/integration/ad-fake-ldap.test.ts`) apontarem pro
  // `e2e/fake-ldap-server`, que serve um certificado autoassinado.
  AD_TLS_REJECT_UNAUTHORIZED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false'),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Variáveis de ambiente inválidas:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

// Um `.env` de produção com esta flag desligada aceita QUALQUER certificado
// na conexão LDAPS que carrega AD_BIND_DN/AD_BIND_PASSWORD — o valor existe
// só para os testes de integração contra o e2e/fake-ldap-server. Nunca deve
// passar despercebido num boot real.
if (parsed.data.AD_TLS_REJECT_UNAUTHORIZED === false) {
  console.warn(
    '⚠️  AD_TLS_REJECT_UNAUTHORIZED=false — a verificação de certificado TLS da conexão LDAPS ' +
      'está DESLIGADA. Use isto apenas nos testes de integração (e2e/fake-ldap-server), nunca ' +
      'contra um Active Directory real.',
  );
}

export const env = parsed.data;
