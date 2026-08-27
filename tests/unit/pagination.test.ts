import { describe, expect, it } from 'vitest';
import { paginate } from '../../src/validators/pagination.js';

describe('paginate', () => {
  const items = [1, 2, 3, 4, 5];

  it('fatia a primeira página', () => {
    expect(paginate(items, 1, 2)).toEqual({
      data: [1, 2],
      pagination: { page: 1, pageSize: 2, total: 5, totalPages: 3 },
    });
  });

  it('fatia a última página parcial', () => {
    expect(paginate(items, 3, 2)).toEqual({
      data: [5],
      pagination: { page: 3, pageSize: 2, total: 5, totalPages: 3 },
    });
  });

  it('retorna lista vazia para uma página além do total', () => {
    expect(paginate(items, 10, 2)).toEqual({
      data: [],
      pagination: { page: 10, pageSize: 2, total: 5, totalPages: 3 },
    });
  });

  it('totalPages é no mínimo 1 mesmo com lista vazia', () => {
    expect(paginate([], 1, 10)).toEqual({
      data: [],
      pagination: { page: 1, pageSize: 10, total: 0, totalPages: 1 },
    });
  });
});
