import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    globalSetup: ['./test/globalSetup.ts'],
    setupFiles: ['./test/setup.ts'],
    include: ['test/**/*.test.ts'],
    testTimeout: 10000,
    hookTimeout: 10000,
    fileParallelism: false,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/db/create.ts', 'src/peaks.ts', 'src/db/index.ts', 'src/db/schema.ts'],
      thresholds: {
        lines: 90,
        branches: 70,
      },
    },
    env: {
      NODE_ENV: 'test',
      REDIS_URL: 'redis://127.0.0.1:6379/15',
      JWT_SECRET: 'test_secret_for_vitest_runner_sonare',
      PORT: '3099',
    },
  },
});
