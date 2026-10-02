import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // One temp root per run, deleted at the end (see test/global-setup.ts).
    globalSetup: ['./test/global-setup.ts'],
    pool: 'forks',
    testTimeout: 20_000,
  },
});
