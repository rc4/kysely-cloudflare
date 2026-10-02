import type { DatabaseConnection, Driver, TransactionSettings } from 'kysely';
import { CloudflareConnection, isD1, isStorage, validateDatabase } from './connection';
import type { CloudflareDatabase, CloudflareDialectConfig } from './types';

/**
 * Gives one connection at a time exclusive use of the binding, so queries from
 * outside a Durable Object transaction can't run inside it.
 */
export class CloudflareDriver implements Driver {
  readonly #config: CloudflareDialectConfig;
  readonly #onInitialized: (database: CloudflareDatabase) => void;
  #database?: CloudflareDatabase;
  #available: Promise<void> = Promise.resolve();
  readonly #leases = new WeakMap<DatabaseConnection, () => void>();
  #transaction?: { commit: PromiseWithResolvers<boolean>; done: Promise<void> };
  readonly #rollback = new Error('Rolled back');

  constructor(
    config: CloudflareDialectConfig,
    onInitialized: (database: CloudflareDatabase) => void,
  ) {
    this.#config = config;
    this.#onInitialized = onInitialized;
  }

  async init(): Promise<void> {
    const { database: binding } = this.#config;
    const database = typeof binding === 'function' ? await binding() : binding;
    validateDatabase(database);
    await this.#config.onCreateConnection?.(new CloudflareConnection(database));
    this.#database = database;
    this.#onInitialized(database);
  }

  async acquireConnection(): Promise<DatabaseConnection> {
    const connection = new CloudflareConnection(this.#database!, () => this.#reserve(connection));
    await this.#reserve(connection);
    return connection;
  }

  async #reserve(connection: DatabaseConnection): Promise<void> {
    if (this.#leases.has(connection)) return;
    const available = this.#available;
    const released = Promise.withResolvers<void>();
    this.#available = released.promise;
    await available;
    this.#leases.set(connection, released.resolve);
  }

  async beginTransaction(
    connection: DatabaseConnection,
    settings: TransactionSettings,
  ): Promise<void> {
    try {
      await this.#reserve(connection);
      const database = this.#database!;
      if (isD1(database)) {
        throw new Error("D1 doesn't support transactions; use batch() for atomic writes");
      }
      if (!isStorage(database)) {
        throw new Error('Transactions require ctx.storage, not ctx.storage.sql');
      }
      if (
        settings.accessMode
        || (settings.isolationLevel && settings.isolationLevel !== 'serializable')
      ) {
        throw new Error(
          "Durable Object transactions don't support access modes or isolation levels other than serializable",
        );
      }
      // Hold the native transaction open until Kysely commits or rolls back.
      const started = Promise.withResolvers<void>();
      const commit = Promise.withResolvers<boolean>();
      const done = database
        .transaction(async () => {
          started.resolve();
          if (!(await commit.promise)) throw this.#rollback;
        })
        .catch((error: unknown) => {
          started.reject(error);
          if (error !== this.#rollback) throw error;
        });
      // finishTransaction() surfaces this error; don't report it as unhandled first.
      done.catch(() => {});
      this.#transaction = { commit, done };
      await started.promise;
    } catch (error) {
      this.#transaction = undefined;
      await this.releaseConnection(connection);
      throw error;
    }
  }

  async commitTransaction(): Promise<void> {
    await this.#finishTransaction(true);
  }

  async rollbackTransaction(): Promise<void> {
    await this.#finishTransaction(false);
  }

  async #finishTransaction(commit: boolean): Promise<void> {
    const transaction = this.#transaction;
    if (!transaction) return;
    transaction.commit.resolve(commit);
    try {
      await transaction.done;
    } finally {
      this.#transaction = undefined;
    }
  }

  async releaseConnection(connection: DatabaseConnection): Promise<void> {
    this.#leases.get(connection)?.();
    this.#leases.delete(connection);
  }

  async destroy(): Promise<void> {
    await this.#finishTransaction(false);
  }
}
