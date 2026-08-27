import { describe, expect, it } from 'vitest';
import { macAddressSchema } from '../../src/validators/mac.js';

describe('macAddressSchema', () => {
  it('aceita um MAC válido em minúsculas', () => {
    expect(macAddressSchema.safeParse('aa:bb:cc:dd:ee:ff').success).toBe(true);
  });

  it('aceita um MAC válido em maiúsculas', () => {
    expect(macAddressSchema.safeParse('AA:BB:CC:DD:EE:FF').success).toBe(true);
  });

  it('rejeita um MAC sem os dois-pontos', () => {
    expect(macAddressSchema.safeParse('aabbccddeeff').success).toBe(false);
  });

  it('rejeita string vazia', () => {
    expect(macAddressSchema.safeParse('').success).toBe(false);
  });
});
