import { CompiledQuery, Kysely, SqliteDialect, sql, type DatabaseConnection } from 'kysely';
import { Migrator } from 'kysely/migration';
import { expect, test, vi } from 'vitest';
import { batch, CloudflareDialect, type CloudflareDatabase } from '../../src';
import { createSchema, type TestDatabase } from '../shared/suite';
import { SQLiteStorage } from './sqlite-storage';

test('lazy initialization retries failures and calls the hook once after success', async () => {
  const storage = new SQLiteStorage();
  const factory = vi
    .fn<() => Promise<CloudflareDatabase>>()
    .mockRejectedValueOnce(new Error('binding unavailable'))
    .mockResolvedValue(storage);
  const hook = vi.fn<(connection: DatabaseConnection) => Promise<void>>(async (connection) => {
    await connection.executeQuery(CompiledQuery.raw('pragma foreign_keys = on'));
  });
  const db = new Kysely<TestDatabase>({
    dialect: new CloudflareDialect({ database: factory, onCreateConnection: hook }),
  });
  try {
    db.selectFrom('cats').selectAll().compile();
    expect(factory).not.toHaveBeenCalled();
    await expect(sql`select 1`.execute(db)).rejects.toThrow('binding unavailable');
    await sql`select 1`.execute(db);
    await sql`select 2`.execute(db);
    expect(factory).toHaveBeenCalledTimes(2);
    expect(hook).toHaveBeenCalledTimes(1);
    await db.destroy();
    await expect(sql`select 1`.execute(db)).rejects.toThrow('destroyed');
    expect(storage.database.prepare('select 1').get()).toEqual({ '1': 1 });
  } finally {
    await db.destroy();
    storage.database.close();
  }
});

test('failed connection setup can be retried', async () => {
  const storage = new SQLiteStorage();
  const hook = vi
    .fn<(connection: DatabaseConnection) => Promise<void>>()
    .mockRejectedValueOnce(new Error('setup failed'))
    .mockResolvedValue(undefined);
  const db = new Kysely({
    dialect: new CloudflareDialect({ database: storage, onCreateConnection: hook }),
  });
  try {
    await expect(sql`select 1`.execute(db)).rejects.toThrow('setup failed');
    expect((await sql`select 1`.execute(db)).rows).toEqual([{ '1': 1 }]);
    expect(hook).toHaveBeenCalledTimes(2);
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

test('custom migration table names route history and lock writes to the requested tables', async () => {
  const storage = new SQLiteStorage();
  const db = new Kysely({ dialect: new CloudflareDialect({ database: storage }) });
  try {
    const migrator = new Migrator({
      db,
      migrationTableName: 'history',
      migrationLockTableName: 'history_lock',
      provider: {
        getMigrations: async () => ({
          '001': {
            up: async (migrationDb: Kysely<any>) => {
              await migrationDb.schema.createTable('example').addColumn('id', 'integer').execute();
            },
          },
        }),
      },
    });
    expect((await migrator.migrateToLatest()).error).toBeUndefined();
    expect((await sql`select name from history`.execute(db)).rows).toEqual([{ name: '001' }]);
    expect((await sql`select is_locked from history_lock`.execute(db)).rows).toEqual([
      { is_locked: 0 },
    ]);
    expect((await db.introspection.getTables()).map((table) => table.name)).toEqual([
      'example',
      'history',
      'history_lock',
    ]);
  } finally {
    await db.destroy();
    storage.database.close();
  }
});

test('concurrent Durable Object migrators wait for each other instead of failing', async () => {
  const storage = new SQLiteStorage();
  const databases = [
    new Kysely({ dialect: new CloudflareDialect({ database: storage }) }),
    new Kysely({ dialect: new CloudflareDialect({ database: storage.sql }) }),
  ];
  const up = vi.fn<(db: Kysely<any>) => Promise<void>>(async (migrationDb) => {
    await migrationDb.schema.createTable('example').addColumn('id', 'integer').execute();
  });
  try {
    const results = await Promise.all(
      databases.map((db) =>
        new Migrator({
          db,
          provider: { getMigrations: async () => ({ '001': { up } }) },
        }).migrateToLatest(),
      ),
    );
    expect(results.map((result) => result.error)).toEqual([undefined, undefined]);
    expect(up).toHaveBeenCalledOnce();
    expect(
      results.flatMap((result) => result.results ?? []).map((result) => result.status),
    ).toEqual(['Success']);
  } finally {
    await Promise.all(databases.map((db) => db.destroy()));
    storage.database.close();
  }
});

test('native controlled transaction start failure releases its lease and allows retry', async () => {
  const storage = new SQLiteStorage();
  const transaction = vi
    .spyOn(storage, 'transaction')
    .mockRejectedValueOnce(new Error('storage unavailable'));
  const db = new Kysely<TestDatabase>({ dialect: new CloudflareDialect({ database: storage }) });
  try {
    await createSchema(db);
    await expect(db.startTransaction().execute()).rejects.toThrow('storage unavailable');
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('cats').values({ name: 'King Kibby', age: 1, active: 1 }).execute();
    });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(await db.selectFrom('cats').selectAll().execute()).toHaveLength(1);
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

test('unsupported parameters reject before reaching SQLite', async () => {
  const storage = new SQLiteStorage();
  const db = new Kysely({ dialect: new CloudflareDialect({ database: storage }) });
  try {
    const exec = vi.spyOn(storage.sql, 'exec');
    for (const value of [undefined, new Date(), {}, 9007199254740992n, Infinity, NaN]) {
      // oxlint-disable-next-line no-await-in-loop
      await expect(sql`select ${value}`.execute(db)).rejects.toThrow(/parameter|bigint/);
    }
    expect(exec).not.toHaveBeenCalled();
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
