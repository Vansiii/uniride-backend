import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

/** PB-06: la prueba de carga no corre con `test:e2e` ni en el CI; se pide a propósito con `npm run test:carga`. */
export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: './',
    include: ['test/carga/**/*.carga-spec.ts'],
    setupFiles: ['./test/entorno.ts'],
    fileParallelism: false,
  },
});
