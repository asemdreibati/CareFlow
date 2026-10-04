import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';
import swc from 'unplugin-swc';

export default defineConfig({
  // SWC emits decorator metadata (esbuild does not), which Nest's DI relies on.
  plugins: [tsconfigPaths(), swc.vite({ module: { type: 'es6' } })],
  test: {
    globals: true,
    root: './',
    include: ['**/*.e2e-spec.ts'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
