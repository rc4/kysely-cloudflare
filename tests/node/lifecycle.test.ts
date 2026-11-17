import { CompiledQuery, Kysely, SqliteDialect, sql, type DatabaseConnection } from 'kysely';
import { Migrator } from 'kysely/migration';
import { expect, test, vi } from 'vitest';
import { batch, CloudflareDialect, type CloudflareDatabase } from '../../src';
import { createSchema, type TestDatabase } from '../shared/suite';
import { SQLiteStorage } from './sqlite-storage';

test('binding factories initialize lazily, retry failures, and reuse successful connections', async () => {
  const storage = new SQLiteStorage();
  let available = false;
  const factory = vi.fn<() => Promise<CloudflareDatabase>>(async () => {
    if (!available) throw new Error('binding unavailable');
    return storage;
  });
  const db = new Kysely<TestDatabase>({
    dialect: new CloudflareDialect({ database: factory }),
  });
  try {
    db.selectFrom('cats').selectAll().compile();
    expect(factory).not.toHaveBeenCalled();
    await expect(sql`select 1`.execute(db)).rejects.toThrow('binding unavailable');
    available = true;
    expect((await sql`select 42 as n`.execute(db)).rows).toEqual([{ n: 42 }]);
    available = false;
    expect((await sql`select 84 as n`.execute(db)).rows).toEqual([{ n: 84 }]);
  } finally {
    await db.destroy();
    storage.database.close();
  }
});

test('connection setup retries failures and preserves later configuration changes', async () => {
  const storage = new SQLiteStorage();
  const hook = vi
    .fn<(connection: DatabaseConnection) => Promise<void>>(async (connection) => {
      await connection.executeQuery(CompiledQuery.raw('pragma foreign_keys = off'));
    })
    .mockRejectedValueOnce(new Error('setup failed'));
  const db = new Kysely({
    dialect: new CloudflareDialect({ database: storage, onCreateConnection: hook }),
  });
  try {
    await expect(sql`select 1`.execute(db)).rejects.toThrow('setup failed');
    expect((await sql`pragma foreign_keys`.execute(db)).rows).toEqual([{ foreign_keys: 0 }]);
    await sql`pragma foreign_keys = on`.execute(db);
    expect((await sql`pragma foreign_keys`.execute(db)).rows).toEqual([{ foreign_keys: 1 }]);
  } finally {
    await db.destroy();
    storage.database.close();
  }
});

test('a missing binding fails on the first query', async () => {
  const db = new Kysely({
    dialect: new CloudflareDialect({ database: undefined as unknown as CloudflareDatabase }),
  });
  await expect(sql`select 1`.execute(db)).rejects.toThrow('Expected a D1 binding');
});

test('concurrent Durable Object migrators wait for each other instead of failing', async () => {
  const storage = new SQLiteStorage();
  const databases = [
    new Kysely({ dialect: new CloudflareDialect({ database: storage }) }),
    new Kysely({ dialect: new CloudflareDialect({ database: storage.sql }) }),
  ];
  const provider = {
    getMigrations: async () => ({
      '001': {
        up: async (migrationDb: Kysely<any>) => {
          await migrationDb.schema.createTable('example').addColumn('id', 'integer').execute();
        },
      },
    }),
  };
  try {
    const results = await Promise.all(
      databases.map((db) => new Migrator({ db, provider }).migrateToLatest()),
    );
    expect(results.map((result) => result.error)).toEqual([undefined, undefined]);
    expect(
      results.flatMap((result) => result.results ?? []).map((result) => result.status),
    ).toEqual(['Success']);
  } finally {
    await Promise.all(databases.map((db) => db.destroy()));
    storage.database.close();
  }
});

test('a failed native transaction start allows a later transaction to commit', async () => {
  const storage = new SQLiteStorage();
  vi.spyOn(storage, 'transaction').mockRejectedValueOnce(new Error('storage unavailable'));
  const db = new Kysely<TestDatabase>({ dialect: new CloudflareDialect({ database: storage }) });
  try {
    await createSchema(db);
    await expect(db.startTransaction().execute()).rejects.toThrow('storage unavailable');
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('cats').values({ name: 'King Kibby', age: 1, active: 1 }).execute();
    });
    expect(await db.selectFrom('cats').select('name').execute()).toEqual([{ name: 'King Kibby' }]);
  } finally {
    await db.destroy();
    storage.database.close();
  }
});

test('destroy rolls back an open controlled transaction without disposing the binding', async () => {
  const storage = new SQLiteStorage();
  const db = new Kysely<TestDatabase>({ dialect: new CloudflareDialect({ database: storage }) });
  try {
    await createSchema(db);
    const trx = await db.startTransaction().execute();
    await trx.insertInto('cats').values({ name: 'King Kibby', age: 1, active: 1 }).execute();
    await db.destroy();
    expect(storage.database.prepare('select * from cats').all()).toEqual([]);
  } finally {
    storage.database.close();
  }
});

test('a reserved connection stays usable after a failed start while another transaction rolls back', async () => {
  const storage = new SQLiteStorage();
  const db = new Kysely<TestDatabase>({ dialect: new CloudflareDialect({ database: storage }) });
  const entered = Promise.withResolvers<void>();
  const resume = Promise.withResolvers<void>();
  let outside: Promise<unknown> | undefined;
  try {
    await createSchema(db);
    await db.connection().execute(async (reserved) => {
      outside = db
        .transaction()
        .execute(async (trx) => {
          await trx.insertInto('cats').values({ name: 'rolled back', age: 1, active: 1 }).execute();
          entered.resolve();
          await resume.promise;
          throw new Error('outside rollback');
        })
        .catch((error: unknown) => error);
      await expect(
        reserved
          .transaction()
          .setAccessMode('read only')
          .execute(async () => {}),
      ).rejects.toThrow(/access mode/);
      await entered.promise;
      const write = reserved
        .insertInto('cats')
        .values({ name: 'retained', age: 1, active: 1 })
        .execute();
      resume.resolve();
      await write;
    });
    expect(await outside).toEqual(new Error('outside rollback'));
    expect(await db.selectFrom('cats').select('name').execute()).toEqual([{ name: 'retained' }]);
  } finally {
    resume.resolve();
    await db.destroy();
    storage.database.close();
  }
});

test('unsupported parameters reject without persisting a write', async () => {
  const storage = new SQLiteStorage();
  const db = new Kysely({ dialect: new CloudflareDialect({ database: storage }) });
  try {
    await sql`create table parameters (value)`.execute(db);
    for (const value of [undefined, new Date(), {}, 9007199254740992n, Infinity, NaN]) {
      // oxlint-disable-next-line no-await-in-loop
      await expect(sql`insert into parameters values (${value})`.execute(db)).rejects.toThrow(
        /parameter/i,
      );
    }
    expect((await sql`select * from parameters`.execute(db)).rows).toEqual([]);
  } finally {
    await db.destroy();
    storage.database.close();
  }
});

test('batch rejects other dialects', async () => {
  const db = new Kysely({
    dialect: new SqliteDialect({
      database: {
        prepare: () => {
          throw new Error('should not execute');
        },
        close() {},
      },
    }),
  });
  try {
    await expect(batch(db, [CompiledQuery.raw('select 1')])).rejects.toThrow(
      'requires a kysely-cloudflare dialect',
    );
  } finally {
    await db.destroy();
  }
});
