import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as kysely from 'kysely';
import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-plugin';

// kysely <0.29 has no 'kysely/migration' subpath, so point the specifier at
// the installed package's migrator module (same layout in both versions).
const kyselyEntry = fileURLToPath(String(import.meta.resolve('kysely')));
const kyselyMigrator = path.join(path.dirname(kyselyEntry), 'migration/migrator.js');

// Main-entry Migrator means <0.29, whose migrator can't run inside an
// existing transaction (see suite.ts).
const migratorRunsInExistingTransaction = (kysely as { Migrator?: unknown }).Migrator === undefined;

export default defineConfig({
  resolve: {
    alias: [{ find: /^kysely\/migration$/, replacement: kyselyMigrator }],
  },
  define: {
    KYESELY_MIGRATOR_RUNS_IN_EXISTING_TRANSACTIONS: JSON.stringify(
      migratorRunsInExistingTransaction,
    ),
  },
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
