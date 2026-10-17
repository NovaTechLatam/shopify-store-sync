import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration tests share one Postgres database; run files sequentially.
    fileParallelism: false,
  },
});
