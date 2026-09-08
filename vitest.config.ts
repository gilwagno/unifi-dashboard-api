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
    // `.claude/**` cobre o mesmo problema quando um worktree de agente (ver
    // Agent tool, isolation: 'worktree') fica órfão em disco: é um checkout
    // completo do repo, então sem esta exclusão `vitest run` na raiz varre
    // (e duplica) a suíte de lá também, incluindo os specs de frontend/e2e
    // que o worktree nem exclui do jeito certo. Achado real em 2026-09-08.
    exclude: [...configDefaults.exclude, 'frontend/**', 'e2e/**', '.claude/**'],
  },
});
