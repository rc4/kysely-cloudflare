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
import { isStorage } from './connection';
import { CloudflareDriver } from './driver';
import { CloudflareIntrospector } from './introspector';
import type {
  CloudflareDatabase,
  CloudflareDialectConfig,
  D1DatabaseLike,
  DurableObjectStorageLike,
  SqlStorageLike,
} from './types';

class CloudflareAdapter extends SqliteAdapter {
  readonly #locks = new WeakSet<Kysely<any>>();
  readonly #transactionalDdl: () => boolean;

  constructor(transactionalDdl: () => boolean) {
    super();
    this.#transactionalDdl = transactionalDdl;
  }

  override get supportsTransactionalDdl(): boolean {
    return this.#transactionalDdl();
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
    const result = await db
      .updateTable(options.lockTable)
      .set({ is_locked: 1 })
      .where('id', '=', options.lockRowId)
      .where('is_locked', '=', 0)
      .executeTakeFirst();
    if (result.numUpdatedRows !== 1n) {
      throw new Error('Migration lock is already held by another migrator');
    }
    this.#locks.add(db);
  }

  override async releaseMigrationLock(
    db: Kysely<any>,
    options: MigrationLockOptions,
  ): Promise<void> {
    // Kysely also calls this when acquiring failed; don't clear another
    // migrator's lock.
    if (!this.#locks.has(db)) return;
    await db
      .updateTable(options.lockTable)
      .set({ is_locked: 0 })
      .where('id', '=', options.lockRowId)
      .execute();
    this.#locks.delete(db);
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
    // Kysely reads this after the driver initializes.
    return new CloudflareAdapter(() => this.#database !== undefined && isStorage(this.#database));
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
