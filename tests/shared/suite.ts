/* oxlint-disable vitest/no-conditional-expect, vitest/no-conditional-tests */
import {
  CamelCasePlugin,
  CompiledQuery,
  Kysely,
  ParseJSONResultsPlugin,
  sql,
  type Generated,
  type QueryResult,
} from 'kysely';
import { Migrator } from 'kysely/migration';
import { jsonArrayFrom } from 'kysely/helpers/sqlite';
import { describe, expect, test } from 'vitest';
import { batch } from '../../src';

export interface TestDatabase {
  cats: {
    id: Generated<number>;
    name: string;
    age: number | null;
    active: number;
    payload: Uint8Array | ArrayBuffer | null;
  };
  // owner_id references cats.id. We all know who really rules the roost.
  humans: { id: Generated<number>; owner_id: number; name: string };
}

export type RunDatabase = (callback: (db: Kysely<TestDatabase>) => Promise<void>) => Promise<void>;

export async function createSchema(db: Kysely<TestDatabase>) {
  await db.schema.dropView('cats_view').ifExists().execute();
  for (const name of [
    'humans',
    'cats',
    'audit',
    'extra',
    'kysely_migration',
    'kysely_migration_lock',
  ]) {
    // Drop humans first because humans.owner_id references cats.id.
    // oxlint-disable-next-line no-await-in-loop
    await db.schema.dropTable(name).ifExists().execute();
  }
  await db.schema
    .createTable('cats')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('name', 'text', (col) => col.notNull().unique())
    .addColumn('age', 'integer')
    .addColumn('active', 'integer', (col) => col.notNull().defaultTo(1))
    .addColumn('payload', 'blob')
    .execute();
  await db.schema
    .createTable('humans')
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('owner_id', 'integer', (col) => col.references('cats.id').notNull())
    .addColumn('name', 'text', (col) => col.notNull())
    .execute();
}

/** `storage` is `ctx.storage`; `sql` is `ctx.storage.sql`. */
export function databaseSuite(
  suiteName: string,
  run: RunDatabase,
  binding: 'd1' | 'storage' | 'sql',
) {
  const transactions = binding === 'storage';
  // oxlint-disable-next-line vitest/valid-title
  describe(suiteName, () => {
    test('reads omit affected-row counts and raw writes report them', async () =>
      run(async (db) => {
        const select = await db.executeQuery(db.selectFrom('cats').selectAll().compile());
        expect(select).toEqual({ rows: [] });
        const write = await sql`insert into cats (name, active) values ('King Kibby', 1)`.execute(
          db,
        );
        expect(write.numAffectedRows).toBe(1n);
        expect((await sql`select name from cats`.execute(db)).numAffectedRows).toBeUndefined();
      }));

    if (binding === 'sql') {
      test('ctx.storage.sql executes bound queries and exposes table metadata', async () =>
        run(async (db) => {
          await db.insertInto('cats').values({ name: 'King Kibby', age: 12, active: 1 }).execute();
          expect(
            await db.selectFrom('cats').select('name').where('age', '=', 12).execute(),
          ).toEqual([{ name: 'King Kibby' }]);
          const tables = await db.introspection.getTables();
          expect(
            tables.find((table) => table.name === 'cats')?.columns.map((column) => column.name),
          ).toEqual(['id', 'name', 'age', 'active', 'payload']);
        }));

      test('ctx.storage.sql rejects transactions and nonempty atomic batches before writes', async () =>
        run(async (db) => {
          let invoked = false;
          await expect(
            db.transaction().execute(async () => {
              invoked = true;
            }),
          ).rejects.toThrow('ctx.storage, not ctx.storage.sql');
          expect(invoked).toBe(false);
          await expect(db.startTransaction().execute()).rejects.toThrow(
            'ctx.storage, not ctx.storage.sql',
          );
          await expect(
            batch(db, [
              db.insertInto('cats').values({ name: 'King Kibby', age: 12, active: 1 }).compile(),
            ]),
          ).rejects.toThrow('ctx.storage, not ctx.storage.sql');
          expect(await db.selectFrom('cats').select('name').execute()).toEqual([]);
        }));
      return;
    }
    test('insert IDs, update/delete counts, zero matches, and SELECT after writes', async () =>
      run(async (db) => {
        const inserted = await db
          .insertInto('cats')
          .values({ name: 'King Kibby', age: 12, active: 1 })
          .executeTakeFirstOrThrow();
        expect(inserted.insertId).toBe(1n);
        expect(inserted.numInsertedOrUpdatedRows).toBe(1n);
        expect(await db.selectFrom('cats').selectAll().execute()).toEqual([
          { id: 1, name: 'King Kibby', age: 12, active: 1, payload: null },
        ]);
        const update = await db
          .updateTable('cats')
          .set({ age: 13 })
          .where('id', '=', 1)
          .executeTakeFirstOrThrow();
        expect(update.numUpdatedRows).toBe(1n);
        expect(
          (
            await db
              .updateTable('cats')
              .set({ age: 14 })
              .where('id', '=', 999)
              .executeTakeFirstOrThrow()
          ).numUpdatedRows,
        ).toBe(0n);
        expect(
          (await db.deleteFrom('cats').where('id', '=', 1).executeTakeFirstOrThrow())
            .numDeletedRows,
        ).toBe(1n);
        expect((await db.deleteFrom('cats').executeTakeFirstOrThrow()).numDeletedRows).toBe(0n);
        expect(await db.selectFrom('cats').selectAll().execute()).toEqual([]);
      }));

    test('multi-row mutations, RETURNING, upserts, and conflict-ignore', async () =>
      run(async (db) => {
        expect(
          await db
            .insertInto('cats')
            .values([
              { name: 'King Kibby', age: 12, active: 1 },
              { name: 'Queen Eleanor', age: 9, active: 1 },
            ])
            .returning(['id', 'name'])
            .execute(),
        ).toEqual([
          { id: 1, name: 'King Kibby' },
          { id: 2, name: 'Queen Eleanor' },
        ]);
        const ignored = await db
          .insertInto('cats')
          .values({ name: 'King Kibby', age: 99, active: 1 })
          .onConflict((conflict) => conflict.column('name').doNothing())
          .executeTakeFirstOrThrow();
        expect(ignored.numInsertedOrUpdatedRows).toBe(0n);
        expect(ignored.insertId).toBeUndefined();
        expect(
          await db
            .insertInto('cats')
            .values({ name: 'King Kibby', age: 13, active: 0 })
            .onConflict((conflict) => conflict.column('name').doUpdateSet({ age: 13 }))
            .returning(['name', 'age'])
            .execute(),
        ).toEqual([{ name: 'King Kibby', age: 13 }]);
        expect(await db.updateTable('cats').set({ active: 0 }).returning('id').execute()).toEqual([
          { id: 1 },
          { id: 2 },
        ]);
        expect(
          await db
            .deleteFrom('cats')
            .where('name', '=', 'Queen Eleanor')
            .returning('name')
            .execute(),
        ).toEqual([{ name: 'Queen Eleanor' }]);
      }));

    test('changes count excludes trigger writes and index billing', async () =>
      run(async (db) => {
        await db.schema.createTable('audit').addColumn('name', 'text').execute();
        await db.schema.createIndex('cats_age_idx').on('cats').column('age').execute();
        await sql`create trigger cats_audit after insert on cats begin insert into audit values (new.name); end`.execute(
          db,
        );
        const inserted = await db
          .insertInto('cats')
          .values([
            { name: 'King Kibby', age: 12, active: 1 },
            { name: 'Queen Eleanor', age: 9, active: 1 },
          ])
          .executeTakeFirstOrThrow();
        expect(inserted.numInsertedOrUpdatedRows).toBe(2n);
        expect(inserted.insertId).toBe(2n);
        expect(
          (await sql<{ n: number }>`select count(*) as n from audit`.execute(db)).rows,
        ).toEqual([{ n: 2 }]);
      }));

    test('joins and aggregate results execute through the SQLite bindings', async () =>
      run(async (db) => {
        await db
          .insertInto('cats')
          .values([
            { name: 'King Kibby', age: 12, active: 1 },
            { name: 'Queen Eleanor', age: 9, active: 0 },
          ])
          .execute();
        await db
          .insertInto('humans')
          .values([
            { owner_id: 1, name: 'Ada' },
            { owner_id: 1, name: 'Grace' },
          ])
          .execute();
        const joined = await db
          .selectFrom('cats')
          .leftJoin('humans', 'humans.owner_id', 'cats.id')
          .select(['cats.name', (eb) => eb.fn.count<number>('humans.id').as('count')])
          .groupBy('cats.name')
          .having((eb) => eb.fn.count('humans.id'), '>', 0)
          .orderBy('cats.name')
          .execute();
        expect(joined).toEqual([{ name: 'King Kibby', count: 2 }]);
      }));

    test('parameters preserve quotes, nulls, booleans, safe bigints and binary subviews', async () =>
      run(async (db) => {
        const name = "O'Reilly; DROP TABLE cats; --";
        const bytes = new Uint8Array([9, 1, 2, 9]).subarray(1, 3);
        await db
          .insertInto('cats')
          .values({ name, age: null, active: sql`${true}`, payload: bytes })
          .execute();
        const row = await db
          .selectFrom('cats')
          .selectAll()
          .where('name', '=', name)
          .executeTakeFirstOrThrow();
        expect(row.name).toBe(name);
        expect(row.age).toBeNull();
        expect(row.active).toBe(1);
        const binary = row.payload as ArrayBuffer | number[] | Uint8Array;
        expect(Array.from(binary instanceof ArrayBuffer ? new Uint8Array(binary) : binary)).toEqual(
          [1, 2],
        );
        for (const input of [
          new Uint8Array([1, 2]).buffer,
          new DataView(new Uint8Array([9, 1, 2, 9]).buffer, 1, 2),
        ]) {
          // oxlint-disable-next-line no-await-in-loop
          const result = await sql<{
            bytes: ArrayBuffer | number[] | Uint8Array;
          }>`select ${input} as bytes`.execute(db);
          const value = result.rows[0]!.bytes;
          expect(Array.from(value instanceof ArrayBuffer ? new Uint8Array(value) : value)).toEqual([
            1, 2,
          ]);
        }
        expect((await sql`select ${-12n} as n, ${false} as active`.execute(db)).rows).toEqual([
          { n: -12, active: 0 },
        ]);
      }));

    test('raw compiled SQL binds parameters', async () =>
      run(async (db) => {
        expect((await db.executeQuery(CompiledQuery.raw('select ? as n', [42]))).rows).toEqual([
          { n: 42 },
        ]);
      }));

    test('plugins transform queries and results (including introspection)', async () =>
      run(async (db) => {
        const pluginDb = db.withPlugin(new CamelCasePlugin()) as unknown as Kysely<{
          humans: { id: Generated<number>; ownerId: number; name: string };
        }>;
        await db.insertInto('cats').values({ name: 'King Kibby', age: 12, active: 1 }).execute();
        await pluginDb.insertInto('humans').values({ ownerId: 1, name: 'Ada' }).execute();
        expect(await pluginDb.selectFrom('humans').selectAll().execute()).toEqual([
          { id: 1, ownerId: 1, name: 'Ada' },
        ]);
        expect(
          (await pluginDb.introspection.getTables())
            .find((table) => table.name === 'humans')
            ?.columns.map((column) => column.name),
        ).toContain('owner_id');
      }));

    test('SQLite JSON helpers, subqueries and insert-from-select', async () =>
      run(async (db) => {
        await db.insertInto('cats').values({ name: 'King Kibby', age: 12, active: 1 }).execute();
        await db
          .insertInto('humans')
          .columns(['owner_id', 'name'])
          .expression(db.selectFrom('cats').select(['id', sql<string>`'Ada'`.as('name')]))
          .execute();
        const rows = await db
          .withPlugin(new ParseJSONResultsPlugin())
          .selectFrom('cats')
          .select([
            'name',
            (eb) =>
              jsonArrayFrom(
                eb.selectFrom('humans').select('name').whereRef('owner_id', '=', 'cats.id'),
              ).as('humans'),
          ])
          .execute();
        expect(rows).toEqual([{ name: 'King Kibby', humans: [{ name: 'Ada' }] }]);
      }));

    test('introspection handles generated columns, quoted names and WITHOUT ROWID', async () =>
      run(async (db) => {
        await sql`create table extra (id integer primary key, value integer generated always as (id * 2) virtual) without rowid`.execute(
          db,
        );
        const extra = (await db.introspection.getTables()).find((table) => table.name === 'extra')!;
        expect(extra.columns.map((column) => column.name)).toEqual(['id', 'value']);
        expect(extra.columns[0]!.isAutoIncrementing).toBe(false);
        expect(extra.columns[1]!.hasDefaultValue).toBe(true);
        await db.schema.dropTable('extra').execute();
        await sql`create table extra (id integer primary key desc)`.execute(db);
        expect(
          (await db.introspection.getTables()).find((table) => table.name === 'extra')!.columns[0]!
            .isAutoIncrementing,
        ).toBe(false);
        await db.schema.dropTable('extra').execute();
        await sql`create table extra (id integer primary key, note text default 'without rowid')`.execute(
          db,
        );
        const rowid = (await db.introspection.getTables()).find((table) => table.name === 'extra')!;
        expect(rowid.columns[0]!.isAutoIncrementing).toBe(true);
        expect(rowid.columns[0]!.isNullable).toBe(false);
        const name = "quoted'table";
        await db.schema
          .createTable(name)
          .addColumn('id', 'integer', (col) => col.primaryKey())
          .execute();
        try {
          const quoted = (await db.introspection.getTables()).find((table) => table.name === name)!;
          expect(quoted.columns[0]!.isAutoIncrementing).toBe(true);
        } finally {
          await db.schema.dropTable(name).execute();
        }
      }));

    test('failed migrations release their lock and roll back DDL when supported', async () =>
      run(async (db) => {
        let fail = true;
        const migrator = new Migrator({
          db,
          provider: {
            getMigrations: async () => ({
              '001': {
                up: async (migrationDb: Kysely<any>) => {
                  await migrationDb.schema
                    .createTable('extra')
                    .ifNotExists()
                    .addColumn('id', 'integer')
                    .execute();
                  if (fail) throw new Error('migration failed');
                },
              },
            }),
          },
        });
        expect((await migrator.migrateToLatest()).error).toEqual(new Error('migration failed'));
        expect((await db.introspection.getTables()).some((table) => table.name === 'extra')).toBe(
          !transactions,
        );
        fail = false;
        expect((await migrator.migrateToLatest()).error).toBeUndefined();
      }));

    if (binding === 'd1') {
      test("a rejected migrator preserves another migrator's lock", async () =>
        run(async (db) => {
          const migrator = new Migrator({ db, provider: { getMigrations: async () => ({}) } });
          expect((await migrator.migrateToLatest()).error).toBeUndefined();
          await sql`update kysely_migration_lock set is_locked = 1`.execute(db);
          expect(String((await migrator.migrateToLatest()).error)).toContain(
            'Migration lock is already held by another migrator',
          );
          expect(
            (
              await sql<{ is_locked: number }>`select is_locked from kysely_migration_lock`.execute(
                db,
              )
            ).rows,
          ).toEqual([{ is_locked: 1 }]);
          await sql`update kysely_migration_lock set is_locked = 0`.execute(db);
          expect((await migrator.migrateToLatest()).error).toBeUndefined();
        }));
    } else {
      test('a lock row left by a crashed migrator does not block Durable Objects', async () =>
        run(async (db) => {
          const migrator = new Migrator({ db, provider: { getMigrations: async () => ({}) } });
          expect((await migrator.migrateToLatest()).error).toBeUndefined();
          await sql`update kysely_migration_lock set is_locked = 1`.execute(db);
          expect((await migrator.migrateToLatest()).error).toBeUndefined();
        }));
    }

    if (transactions) {
      test('batch joins an outer transaction and rolls back with it', async () =>
        run(async (db) => {
          await expect(
            db.transaction().execute(async (trx) => {
              await batch(trx, [
                trx.insertInto('cats').values({ name: 'King Kibby', age: 12, active: 1 }).compile(),
              ]);
              throw new Error('outer rollback');
            }),
          ).rejects.toThrow('outer rollback');
          expect(await db.selectFrom('cats').selectAll().execute()).toEqual([]);
        }));

      test('migrations can participate in an existing Durable Object transaction', async () =>
        run(async (db) => {
          await expect(
            db.transaction().execute(async (trx) => {
              const migrator = new Migrator({
                db: trx,
                provider: {
                  getMigrations: async () => ({
                    '001': {
                      up: async (migrationDb: Kysely<any>) => {
                        await migrationDb.schema
                          .createTable('extra')
                          .addColumn('id', 'integer')
                          .execute();
                      },
                    },
                  }),
                },
              });
              expect((await migrator.migrateToLatest()).error).toBeUndefined();
              throw new Error('outer rollback');
            }),
          ).rejects.toThrow('outer rollback');
          expect((await db.introspection.getTables()).some((table) => table.name === 'extra')).toBe(
            false,
          );
        }));

      test('an outside query waits until a transaction rolls back', async () =>
        run(async (db) => {
          const entered = Promise.withResolvers<void>();
          const resumed = Promise.withResolvers<void>();
          const transaction = db.transaction().execute(async (trx) => {
            await trx
              .insertInto('cats')
              .values({ name: 'rolled back', age: 1, active: 1 })
              .execute();
            entered.resolve();
            await resumed.promise;
            throw new Error('rollback');
          });
          const rejected = transaction.catch((error: unknown) => error);
          await entered.promise;
          const outside = db
            .insertInto('cats')
            .values({ name: 'committed', age: 1, active: 1 })
            .execute();
          resumed.resolve();
          await expect(rejected).resolves.toEqual(new Error('rollback'));
          await outside;
          expect(await db.selectFrom('cats').select('name').execute()).toEqual([
            { name: 'committed' },
          ]);
        }));
    }

    test('stream chunks, empty streams, early return and errors release the connection', async () =>
      run(async (db) => {
        await db
          .insertInto('cats')
          .values(['a', 'b', 'c', 'd', 'e'].map((name) => ({ name, age: 1, active: 1 })))
          .execute();
        const chunks: QueryResult<{ name: string }>[] = [];
        const query = db.selectFrom('cats').select('name').orderBy('name').compile();
        await db.getExecutor().provideConnection(async (connection) => {
          for await (const chunk of connection.streamQuery<{ name: string }>(query, 2))
            chunks.push(chunk);
        });
        expect(chunks.map((chunk) => chunk.rows.map((row) => row.name))).toEqual([
          ['a', 'b'],
          ['c', 'd'],
          ['e'],
        ]);
        const names = [];
        for await (const row of db.selectFrom('cats').select('name').orderBy('name').stream(2)) {
          names.push(row.name);
          break;
        }
        expect(names).toEqual(['a']);
        expect(await db.selectFrom('cats').select('name').execute()).toHaveLength(5);
        const empty = [];
        for await (const row of db.selectFrom('cats').selectAll().where('id', '=', 999).stream())
          empty.push(row);
        expect(empty).toEqual([]);
        await expect(
          (async () => {
            for await (const _ of db.selectFrom('cats').select('name').stream(0)) {
            }
          })(),
        ).rejects.toThrow(/chunk size/);
        expect(await db.selectFrom('cats').select('name').execute()).toHaveLength(5);
      }));

    test('SQL failures leave the connection usable for concurrent writes and reserved queries', async () =>
      run(async (db) => {
        await expect(sql`select * from missing_table`.execute(db)).rejects.toThrow(/missing_table/);
        await Promise.all(
          ['King Kibby', 'Queen Eleanor', 'Princess Jane'].map((name) =>
            db.insertInto('cats').values({ name, age: 1, active: 1 }).execute(),
          ),
        );
        await expect(
          db.insertInto('cats').values({ name: 'King Kibby', age: 1, active: 1 }).execute(),
        ).rejects.toThrow(/UNIQUE/);
        await db.connection().execute(async (connection) => {
          expect(await connection.selectFrom('cats').selectAll().execute()).toHaveLength(3);
        });
      }));

    test('schema changes, indexes, views and introspection', async () =>
      run(async (db) => {
        await db.schema
          .alterTable('cats')
          .addColumn('nickname', 'text', (col) => col.defaultTo('unknown'))
          .execute();
        await db.schema.createIndex('cats_age').on('cats').column('age').execute();
        await db.schema
          .createView('cats_view')
          .as(db.selectFrom('cats').select(['id', 'name']))
          .execute();
        expect(await db.introspection.getSchemas()).toEqual([]);
        const tables = await db.introspection.getTables();
        const cats = tables.find((table) => table.name === 'cats')!;
        expect(cats.isView).toBe(false);
        expect(cats.columns.find((col) => col.name === 'name')?.isNullable).toBe(false);
        expect(cats.columns.find((col) => col.name === 'nickname')?.hasDefaultValue).toBe(true);
        expect(tables.find((table) => table.name === 'cats_view')?.isView).toBe(true);
        await db.schema.dropIndex('cats_age').execute();
      }));

    test('migrations up/down and internal migration table filtering', async () =>
      run(async (db) => {
        const migrator = new Migrator({
          db,
          provider: {
            getMigrations: async () => ({
              '001': {
                up: async (migrationDb: Kysely<any>) => {
                  await migrationDb.schema
                    .createTable('extra')
                    .addColumn('value', 'integer')
                    .execute();
                },
                down: async (migrationDb: Kysely<any>) => {
                  await migrationDb.schema.dropTable('extra').execute();
                },
              },
            }),
          },
        });
        const up = await migrator.migrateToLatest();
        expect(up.error).toBeUndefined();
        expect(up.results?.[0]?.status).toBe('Success');
        expect((await migrator.migrateToLatest()).results).toEqual([]);
        expect((await db.introspection.getTables()).map((t) => t.name)).not.toContain(
          'kysely_migration',
        );
        expect(
          (await db.introspection.getTables({ withInternalKyselyTables: true })).map((t) => t.name),
        ).toContain('kysely_migration');
        expect((await migrator.migrateDown()).error).toBeUndefined();
        expect((await db.introspection.getTables()).map((t) => t.name)).not.toContain('extra');
      }));

    test('batch preserves statement order, rolls back failures, and applies result plugins', async () =>
      run(async (db) => {
        const results = await batch(db, [
          db
            .insertInto('cats')
            .values({ name: 'King Kibby', age: 12, active: 1 })
            .returning('name')
            .compile(),
          db.selectFrom('cats').select('name').compile(),
        ] as const);
        expect(results[0].rows).toEqual([{ name: 'King Kibby' }]);
        expect(results[1].rows).toEqual([{ name: 'King Kibby' }]);
        const failed = [
          db.insertInto('cats').values({ name: 'Queen Eleanor', age: 9, active: 1 }).compile(),
          db.insertInto('cats').values({ name: 'King Kibby', age: 9, active: 1 }).compile(),
        ];
        await expect(batch(db, failed)).rejects.toThrow(/UNIQUE/);
        expect(await db.selectFrom('cats').select('name').execute()).toEqual([
          { name: 'King Kibby' },
        ]);
        const queryIds = new WeakSet<object>();
        const pluginDb = db
          .withPlugin(new CamelCasePlugin())
          .withPlugin({
            transformQuery({ node, queryId }) {
              queryIds.add(queryId);
              return node;
            },
            async transformResult({ result, queryId }) {
              expect(queryIds.delete(queryId)).toBe(true);
              const humans = await db.selectFrom('humans').select('id').execute();
              return {
                ...result,
                rows: result.rows.map((row) => ({ ...row, totalHumans: humans.length })),
              };
            },
          })
          .withPlugin({
            transformQuery: ({ node }) => node,
            async transformResult({ result }) {
              expect(result.rows[0]?.ownerId).toBe(1);
              expect(result.rows[0]?.totalHumans).toBe(1);
              return result;
            },
          }) as unknown as Kysely<{
          humans: { id: Generated<number>; ownerId: number; name: string };
        }>;
        const pluginResults = await batch(pluginDb, [
          pluginDb
            .insertInto('humans')
            .values({ ownerId: 1, name: 'Ada' })
            .returningAll()
            .compile(),
        ] as const);
        expect(pluginResults[0].rows).toEqual([{ id: 1, ownerId: 1, name: 'Ada', totalHumans: 1 }]);
        expect(await batch(db, [])).toEqual([]);
      }));

    test('transactions commit and rollback, or reject before invoking user code', async () =>
      run(async (db) => {
        if (!transactions) {
          let invoked = false;
          await expect(
            db.transaction().execute(async () => {
              invoked = true;
            }),
          ).rejects.toThrow(/transactions/i);
          expect(invoked).toBe(false);
          return;
        }
        await db
          .transaction()
          .setIsolationLevel('serializable')
          .execute(async (trx) => {
            await trx
              .insertInto('cats')
              .values({ name: 'King Kibby', age: 12, active: 1 })
              .execute();
            expect(await trx.selectFrom('cats').selectAll().execute()).toHaveLength(1);
          });
        const error = new Error('rollback callback');
        await expect(
          db.transaction().execute(async (trx) => {
            await trx
              .insertInto('cats')
              .values({ name: 'Queen Eleanor', age: 9, active: 1 })
              .execute();
            throw error;
          }),
        ).rejects.toBe(error);
        expect(await db.selectFrom('cats').select('name').execute()).toEqual([
          { name: 'King Kibby' },
        ]);
        await expect(
          db.transaction().execute(async (trx) => {
            await trx
              .insertInto('cats')
              .values({ name: 'Queen Eleanor', age: 9, active: 1 })
              .execute();
            await trx
              .insertInto('cats')
              .values({ name: 'King Kibby', age: 9, active: 1 })
              .execute();
          }),
        ).rejects.toThrow(/UNIQUE/);
        expect(await db.selectFrom('cats').select('name').execute()).toEqual([
          { name: 'King Kibby' },
        ]);
      }));

    test('controlled transactions and unsupported settings/savepoints', async () =>
      run(async (db) => {
        if (!transactions) {
          await expect(db.startTransaction().execute()).rejects.toThrow(/transactions/i);
          expect(await db.selectFrom('cats').select('name').execute()).toEqual([]);
          return;
        }
        const trx = await db.startTransaction().execute();
        await trx.insertInto('cats').values({ name: 'King Kibby', age: 12, active: 1 }).execute();
        await expect(trx.savepoint('point').execute()).rejects.toThrow(/not supported/);
        await trx.rollback().execute();
        expect(await db.selectFrom('cats').selectAll().execute()).toEqual([]);
        const commit = await db.startTransaction().execute();
        await commit
          .insertInto('cats')
          .values({ name: 'Queen Eleanor', age: 9, active: 1 })
          .execute();
        await commit.commit().execute();
        expect(await db.selectFrom('cats').selectAll().execute()).toHaveLength(1);
        await expect(
          db
            .transaction()
            .setIsolationLevel('read committed')
            .execute(async () => {}),
        ).rejects.toThrow(/isolation/);
        await expect(
          db
            .transaction()
            .setAccessMode('read only')
            .execute(async () => {}),
        ).rejects.toThrow(/access mode/);
        await expect(
          db.startTransaction().setIsolationLevel('read committed').execute(),
        ).rejects.toThrow(/isolation/);
        expect(await db.selectFrom('cats').select('name').execute()).toHaveLength(1);
      }));
  });
}
