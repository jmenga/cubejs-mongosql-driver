import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/integration/**/*.test.ts'],
    environment: 'node',
    testTimeout: 60000,
    hookTimeout: 120000,
    globalSetup: ['./tests/integration/setup.ts'],
    fileParallel: false,
  },
});
