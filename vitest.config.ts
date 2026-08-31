import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // frontend/ tem sua própria suíte (jsdom + Testing Library, ver
    // frontend/vitest.config.ts) — sem isso, rodar `vitest` na raiz varre
    // os .test.tsx de lá também, em ambiente node sem jsdom/setup. Os
    // specs de e2e/ são do Playwright (browser real + stack completa) e
    // batem no padrão default de *.spec.ts do Vitest — sem esta exclusão,
    // `npm test` tentaria rodá-los como teste unitário e quebraria.
    exclude: [...configDefaults.exclude, 'frontend/**', 'e2e/**'],
  },
});
