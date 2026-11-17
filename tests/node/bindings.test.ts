import { Miniflare } from 'miniflare';
import { Kysely, sql } from 'kysely';
import { afterAll, beforeAll, expect, test } from 'vitest';
import { batch, CloudflareDialect } from '../../src';
import { createSchema, type TestDatabase } from '../shared/suite';

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

test('Node Miniflare bindings carry binary parameters and mutation metadata across the proxy', async () => {
  const database = await mf.getD1Database('DB');
  const db = new Kysely<TestDatabase>({ dialect: new CloudflareDialect({ database }) });
  try {
    await createSchema(db);
    const [inserted, selected] = await batch(db, [
      db
        .insertInto('cats')
        .values({
          name: 'King Kibby',
          active: 1,
          payload: new Uint8Array([9, 1, 2, 9]).subarray(1, 3),
        })
        .compile(),
      db
        .selectFrom('cats')
        .select(['name', sql<string>`hex(payload)`.as('payload')])
        .compile(),
    ] as const);
    expect(inserted.insertId).toBe(1n);
    expect(inserted.numAffectedRows).toBe(1n);
    expect(selected.rows).toEqual([{ name: 'King Kibby', payload: '0102' }]);
  } finally {
    await db.destroy();
  }
});
