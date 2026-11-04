import { defineConfig } from 'vitest/config';
import tsconfigPaths from 'vite-tsconfig-paths';

export default defineConfig({
  plugins: [tsconfigPaths()],
  test: {
    globals: true,
    root: process.cwd(),
    include: ['apps/api-gateway/test/taxonomy-postgres.gateway.integration.ts'],
  },
});
