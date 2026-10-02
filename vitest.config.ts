import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'node',
          include: ['tests/node/**/*.test.ts'],
        },
      },
      {
        plugins: [
          cloudflareTest({
            main: './tests/workers/worker.ts',
            miniflare: {
              compatibilityDate: '2026-10-01',
              compatibilityFlags: ['nodejs_compat'],
              d1Databases: ['DB'],
              durableObjects: { OBJECTS: { className: 'TestObject', useSQLite: true } },
            },
          }),
        ],
        test: {
          name: 'workers',
          include: ['tests/workers/**/*.test.ts'],
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      reporter: ['text', 'html', 'lcov', ['text-summary', { file: 'summary.txt' }]],
    },
  },
});
