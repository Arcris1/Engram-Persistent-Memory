import vue from '@vitejs/plugin-vue';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [vue()],
  test: {
    // One temp root per run, deleted at the end (shared with the core suite).
    globalSetup: ['../test/global-setup.ts'],
    pool: 'forks',
    testTimeout: 20_000,
    projects: [
      { extends: true, test: { name: 'server', include: ['test/*.test.ts'], environment: 'node' } },
      { extends: true, test: { name: 'web', include: ['test/web/**/*.test.ts'], environment: 'jsdom' } },
    ],
  },
});
