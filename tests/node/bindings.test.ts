import { Miniflare } from 'miniflare';
import { Kysely } from 'kysely';
import { afterAll, beforeAll } from 'vitest';
import { CloudflareDialect, DurableObjectDialect } from '../../src';
import { createSchema, databaseSuite, type TestDatabase } from '../shared/suite';
import { SQLiteStorage } from './sqlite-storage';

let mf: Miniflare;
beforeAll(async () => {
  mf = new Miniflare({
    workers: [
      {
        config: {
          name: 'node-binding-tests',
          compatibilityDate: '2026-10-01',
          manifest: {
            mainModule: 'index.js',
            modules: {
              'index.js': {
                type: 'esm',
                contents: 'export default { fetch() { return new Response("ok") } }',
              },
            },
          },
          env: { DB: { type: 'd1', id: 'test-database' } },
        },
      },
    ],
  });
  await mf.ready;
});
afterAll(async () => {
  await mf?.dispose();
});

databaseSuite(
  'Node D1 via Miniflare binding',
  async (callback) => {
    const database = await mf.getD1Database('DB');
    const db = new Kysely<TestDatabase>({ dialect: new CloudflareDialect({ database }) });
    try {
      await createSchema(db);
      await callback(db);
    } finally {
      await db.destroy();
    }
  },
  'd1',
);

for (const bare of [false, true]) {
  databaseSuite(
    `Node SQLite-compatible storage (${bare ? 'ctx.storage.sql' : 'ctx.storage'})`,
    async (callback) => {
      const storage = new SQLiteStorage();
      const db = new Kysely<TestDatabase>({
        dialect: new DurableObjectDialect({
          database: bare ? storage.sql : async () => storage,
        }),
      });
      try {
        await createSchema(db);
        await callback(db);
      } finally {
        await db.destroy();
        storage.database.close();
      }
    },
    bare ? 'sql' : 'storage',
  );
}
