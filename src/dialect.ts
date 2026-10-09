import {
  SqliteAdapter,
  SqliteQueryCompiler,
  type DatabaseIntrospector,
  type Dialect,
  type DialectAdapter,
  type Driver,
  type Kysely,
  type MigrationLockOptions,
  type QueryCompiler,
} from 'kysely';
import { isD1, isStorage } from './connection';
import { CloudflareDriver } from './driver';
import { CloudflareIntrospector } from './introspector';
import type {
  CloudflareDatabase,
  CloudflareDialectConfig,
  D1DatabaseLike,
  DurableObjectStorageLike,
  SqlStorageLike,
} from './types';

// Keyed by SqlStorage, so Kysely instances on ctx.storage and ctx.storage.sql
// share one lock.
const durableObjectLocks = new WeakMap<SqlStorageLike, Promise<void>>();

class CloudflareAdapter extends SqliteAdapter {
  readonly #held = new WeakMap<Kysely<any>, () => Promise<void>>();
  readonly #database: () => CloudflareDatabase | undefined;

  constructor(database: () => CloudflareDatabase | undefined) {
    super();
    this.#database = database;
  }

  override get supportsTransactionalDdl(): boolean {
    const database = this.#database();
    return database !== undefined && isStorage(database);
  }

  // The driver serializes connections itself. Kysely's single-connection mutex
  // isn't released when a controlled transaction fails to start.
  override get supportsMultipleConnections(): boolean {
    return true;
  }

  // SqliteAdapter's lock is a no-op because a local SQLite file has one
  // connection. D1 and Durable Objects can run migrators concurrently.
  override async acquireMigrationLock(
    db: Kysely<any>,
    options: MigrationLockOptions,
  ): Promise<void> {
    const database = this.#database()!;
    if (!isD1(database)) {
      // A Durable Object has one live instance, so an in-memory lock covers
      // every migrator that can reach its storage. Unlike the lock row, it
      // can't outlive an eviction or crash and block every later run.
      const sql = isStorage(database) ? database.sql : database;
      const previous = durableObjectLocks.get(sql);
      const released = Promise.withResolvers<void>();
      durableObjectLocks.set(sql, released.promise);
      await previous;
      this.#held.set(db, async () => released.resolve());
      return;
    }
    const result = await db
      .updateTable(options.lockTable)
      .set({ is_locked: 1 })
      .where('id', '=', options.lockRowId)
      .where('is_locked', '=', 0)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new Error(
        `Migration lock is already held by another migrator. If none is running, one stopped mid-run: check which migrations were applied, then set ${options.lockTable}.is_locked to 0.`,
      );
    }
    this.#held.set(db, async () => {
      await db
        .updateTable(options.lockTable)
        .set({ is_locked: 0 })
        .where('id', '=', options.lockRowId)
        .execute();
    });
  }

  override async releaseMigrationLock(db: Kysely<any>): Promise<void> {
    // Kysely also calls this when acquiring failed; don't clear another
    // migrator's lock.
    const release = this.#held.get(db);
    this.#held.delete(db);
    await release?.();
  }
}

/**
 * A Kysely dialect for D1 or Durable Object storage. It works out which one you
 * passed.
 *
 * @example
 *
 * ```ts
 * const db = new Kysely<Database>({
 *   dialect: new CloudflareDialect({ database: env.DB }),
 * });
 * ```
 */
export class CloudflareDialect implements Dialect {
  readonly #config: CloudflareDialectConfig;
  #database?: CloudflareDatabase;

  constructor(config: CloudflareDialectConfig) {
    this.#config = config;
  }

  createDriver(): Driver {
    return new CloudflareDriver(this.#config, (database) => {
      this.#database = database;
    });
  }

  createQueryCompiler(): QueryCompiler {
    return new SqliteQueryCompiler();
  }

  createAdapter(): DialectAdapter {
    // Kysely reads the database after the driver initializes.
    return new CloudflareAdapter(() => this.#database);
  }

  createIntrospector(db: Kysely<any>): DatabaseIntrospector {
    return new CloudflareIntrospector(db);
  }
}

/**
 * {@link CloudflareDialect}, typed to accept only a D1 database or session.
 *
 * D1 has no interactive transactions; use `batch()` for atomic writes.
 *
 * @example
 *
 * ```ts
 * new D1Dialect({ database: env.DB.withSession('first-primary') });
 * ```
 */
export class D1Dialect extends CloudflareDialect {
  // oxlint-disable-next-line no-useless-constructor -- narrows the config type
  constructor(config: CloudflareDialectConfig<D1DatabaseLike>) {
    super(config);
  }
}

/**
 * {@link CloudflareDialect}, typed to accept only `ctx.storage` or
 * `ctx.storage.sql`.
 *
 * Pass `ctx.storage` if you need transactions or `batch()`. `ctx.storage.sql`
 * also works, just without those two.
 *
 * @example
 *
 * ```ts
 * new DurableObjectDialect({ database: ctx.storage });
 * ```
 */
export class DurableObjectDialect extends CloudflareDialect {
  // oxlint-disable-next-line no-useless-constructor -- narrows the config type
  constructor(config: CloudflareDialectConfig<DurableObjectStorageLike | SqlStorageLike>) {
    super(config);
  }
}
