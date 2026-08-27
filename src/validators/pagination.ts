import { z } from 'zod';

export const paginationQuery = z.object({
  page: z.coerce.number().int().positive().default(1),
  pageSize: z.coerce.number().int().positive().max(200).default(50),
});

export interface PaginationMeta {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

// Pagina em memória depois de já ter a lista completa — a API de
// Integração do UniFi não garante paginação/ordenação server-side
// confiável entre versões de controller.
export function paginate<T>(items: T[], page: number, pageSize: number): { data: T[]; pagination: PaginationMeta } {
  const total = items.length;
  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const start = (page - 1) * pageSize;

  return {
    data: items.slice(start, start + pageSize),
    pagination: { page, pageSize, total, totalPages },
  };
}
