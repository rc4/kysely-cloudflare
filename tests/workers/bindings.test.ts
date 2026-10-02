import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { Kysely } from 'kysely';
import { expect, test } from 'vitest';
import { batch, CloudflareDialect, D1Dialect, DurableObjectDialect } from '../../src';
import { createSchema, databaseSuite, type TestDatabase } from '../shared/suite';

databaseSuite(
  'Workers D1 (detected)',
  async (callback) => {
    const db = new Kysely<TestDatabase>({ dialect: new CloudflareDialect({ database: env.DB }) });
    try {
      await createSchema(db);
      await callback(db);
    } finally {
      await db.destroy();
    }
  },
  'd1',
);

test('D1 sessions support bound reads and atomic mutations with result metadata', async () => {
  const db = new Kysely<TestDatabase>({
    dialect: new D1Dialect({ database: env.DB.withSession('first-primary') }),
  });
  try {
    await createSchema(db);
    const [inserted, selected] = await batch(db, [
      db.insertInto('cats').values({ name: 'King Kibby', age: 12, active: 1 }).compile(),
      db.selectFrom('cats').select('name').compile(),
    ] as const);
    expect(inserted.insertId).toBe(1n);
    expect(inserted.numAffectedRows).toBe(1n);
    expect(selected.rows).toEqual([{ name: 'King Kibby' }]);
    expect(
      await db.selectFrom('cats').select('age').where('name', '=', 'King Kibby').execute(),
    ).toEqual([{ age: 12 }]);
  } finally {
    await db.destroy();
  }
});

for (const bare of [false, true]) {
  databaseSuite(
    `Workers Durable Object (${bare ? 'ctx.storage.sql' : 'ctx.storage'})`,
    async (callback) => {
      const stub = env.OBJECTS.get(env.OBJECTS.newUniqueId());
      await runInDurableObject(stub, async (_instance, state) => {
        const db = new Kysely<TestDatabase>({
          dialect: bare
            ? new DurableObjectDialect({ database: state.storage.sql })
            : new CloudflareDialect({ database: async () => state.storage }),
        });
        try {
          await createSchema(db);
          await callback(db);
        } finally {
          await db.destroy();
        }
      });
    },
    bare ? 'sql' : 'storage',
  );
}
