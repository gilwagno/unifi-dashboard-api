import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./tests/setup.ts'],
    // Os specs de e2e/ são do Playwright (browser real + stack completa) e
    // batem no padrão default de *.spec.ts do Vitest — sem esta exclusão,
    // `npm test` tentaria rodá-los como teste unitário e quebraria.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
});
