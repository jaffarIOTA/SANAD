import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const dir = (p: string) => fileURLToPath(new URL(p, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@core': dir('./core'),
      '@config': dir('./config'),
      // Mirrors the `paths` in tsconfig.json. Kept in step by
      // `test/ui/aliases.test.ts`, because two copies of a mapping drift.
      '@sanad/core': dir('./core'),
      '@sanad/design': dir('./packages/design'),
      '@sanad/i18n': dir('./packages/i18n'),
    },
  },
  /*
   * No explicit JSX setting.
   *
   * Vitest 5 transforms with oxc rather than esbuild, and oxc compiles `.tsx`
   * for the automatic runtime by default. An `esbuild: { jsx }` block here is
   * silently ignored and warns on every run. The `.tsx` tests in `test/ui/`
   * are what prove this is actually working.
   *
   * The root tsconfig deliberately has no `jsx` setting either — see
   * `tsconfig.web-test.json` for why.
   */
  test: {
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    /*
     * Node, not jsdom, and deliberately.
     *
     * These components are server-rendered: they run in Node in production
     * and produce HTML. `renderToStaticMarkup` exercises exactly that path,
     * so a test asserts the bytes a user's browser actually receives. A jsdom
     * environment would instead simulate a browser these components never
     * reach, add a heavy dependency for a bank's supply-chain review to
     * account for (SDD §6.12), and test a rendering mode we do not ship.
     *
     * If a genuinely client-side component appears later — one with state or
     * an event handler — it will need jsdom or a real browser, and that is
     * the point at which to add one, for that component only.
     */
    environment: 'node',
  },
});
