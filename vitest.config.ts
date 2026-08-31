import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // frontend/ tem sua própria suíte (jsdom + Testing Library, ver
    // frontend/vitest.config.ts) — sem isso, rodar `vitest` na raiz varre
    // os .test.tsx de lá também, em ambiente node sem jsdom/setup.
    exclude: [...configDefaults.exclude, 'frontend/**'],
  },
});
