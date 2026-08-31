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
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Variáveis de ambiente inválidas:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
