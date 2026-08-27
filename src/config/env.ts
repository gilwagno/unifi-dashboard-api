import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  CONTROLLER_HOST: z.string().min(1, 'CONTROLLER_HOST é obrigatório'),
  UNIFI_API_KEY: z.string().min(1, 'UNIFI_API_KEY é obrigatório'),
  SITE_ID: z.string().default('default'),
  UNIFI_ALLOW_SELF_SIGNED: z
    .string()
    .default('true')
    .transform((v) => v === 'true'),
  JWT_SECRET: z.string().min(16, 'JWT_SECRET deve ter pelo menos 16 caracteres'),
  ADMIN_USER: z.string().min(1),
  ADMIN_PASSWORD_HASH: z.string().min(1, 'Gere com bcryptjs.hashSync'),
  PORT: z.coerce.number().default(3000),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Variáveis de ambiente inválidas:');
  console.error(parsed.error.flatten().fieldErrors);
  process.exit(1);
}

export const env = parsed.data;
