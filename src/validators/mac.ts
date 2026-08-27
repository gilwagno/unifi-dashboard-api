import { z } from 'zod';

export const macAddressSchema = z
  .string()
  .regex(/^([0-9a-f]{2}:){5}[0-9a-f]{2}$/i, 'MAC inválido');

export const macParamSchema = z.object({ mac: macAddressSchema });
