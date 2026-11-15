import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/pricing-svc/test/catalog-token.benchmark.ts'],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    fileParallelism: false,
  },
});
