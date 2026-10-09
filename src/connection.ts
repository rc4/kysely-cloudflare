import {
  DeleteQueryNode,
  InsertQueryNode,
  UpdateQueryNode,
  type CompiledQuery,
  type DatabaseConnection,
  type QueryResult,
  type UnknownRow,
} from 'kysely';
import type {
  CloudflareDatabase,
  D1DatabaseLike,
  D1ResultLike,
  DurableObjectStorageLike,
  SqlStorageLike,
  SqlValue,
} from './types';

// D1's meta.changes and Durable Objects' rowsWritten include trigger writes;
// SQLite's changes() counts only the statement's own rows.
const CHANGES_SQL = 'select changes() as changes, last_insert_rowid() as insert_id';

export function isD1(database: CloudflareDatabase): database is D1DatabaseLike {
  return (
    typeof (database as D1DatabaseLike).prepare === 'function'
    && typeof (database as D1DatabaseLike).batch === 'function'
  );
}

export function isStorage(database: CloudflareDatabase): database is DurableObjectStorageLike {
  return typeof (database as DurableObjectStorageLike).sql?.exec === 'function';
}

export function validateDatabase(database: CloudflareDatabase): void {
  if (
    !database
    || (!isD1(database)
      && !isStorage(database)
      && typeof (database as SqlStorageLike).exec !== 'function')
  ) {
    throw new TypeError('Expected a D1 binding, Durable Object storage, or SqlStorage');
  }
}

function isMutation(query: CompiledQuery): boolean {
  return (
    InsertQueryNode.is(query.query)
    || UpdateQueryNode.is(query.query)
    || DeleteQueryNode.is(query.query)
  );
}

function d1Result<R>(query: CompiledQuery, result: D1ResultLike<R>): QueryResult<R> {
  // Match the Durable Object path: reads don't report affected rows.
  if (!isMutation(query) && result.meta.changes === 0) return { rows: result.results };
  return {
    rows: result.results,
    numAffectedRows: BigInt(result.meta.changes),
    insertId:
      InsertQueryNode.is(query.query) && result.meta.changes > 0
        ? BigInt(result.meta.last_row_id)
        : undefined,
  };
}

function normalizeParameter(value: unknown): SqlValue {
  if (value === null || typeof value === 'string') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  // SQLite would silently store NaN as NULL.
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'bigint') {
    const number = Number(value);
    if (Number.isSafeInteger(number)) return number;
    throw new TypeError(`Bigint parameter ${value} is outside the safe integer range`);
  }
  if (value instanceof ArrayBuffer) return value;
  if (ArrayBuffer.isView(value)) {
    // Copy only the view's bytes; its buffer may be larger.
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength).slice().buffer;
  }
  throw new TypeError(
    'Parameters must be null, strings, finite numbers, booleans, safe bigints, or binary data',
  );
}

export class CloudflareConnection implements DatabaseConnection {
  readonly database: CloudflareDatabase;
  readonly #reserve?: () => Promise<void>;

  /**
   * @param reserve - Waits for exclusive use of the binding. Called before each
   *   query because Kysely can keep using a connection after the driver
   *   releases it (when a transaction fails to start inside
   *   `db.connection()`).
   */
  constructor(database: CloudflareDatabase, reserve?: () => Promise<void>) {
    this.database = database;
    this.#reserve = reserve;
  }

  async executeQuery<R>(query: CompiledQuery): Promise<QueryResult<R>> {
    await this.#reserve?.();
    if (isD1(this.database)) {
      if (isMutation(query)) return (await this.executeBatch([query]))[0]! as QueryResult<R>;
      return d1Result(query, await this.#prepare(this.database, query).all<R>());
    }
    return this.#executeSql<R>(query);
  }

  async executeBatch(queries: readonly CompiledQuery[]): Promise<QueryResult<UnknownRow>[]> {
    if (queries.length === 0) return [];
    await this.#reserve?.();
    const database = this.database;
    if (isD1(database)) {
      // Read changes() in the same batch so no other statement runs in between.
      const statements = queries.flatMap((query) => {
        const statement = this.#prepare(database, query);
        return isMutation(query) ? [statement, database.prepare(CHANGES_SQL)] : [statement];
      });
      const results = await database.batch<UnknownRow>(statements);
      let index = 0;
      return queries.map((query) => {
        let result = results[index++]!;
        if (isMutation(query)) {
          const row = results[index++]!.results[0] as { changes: number; insert_id: number };
          result = { ...result, meta: { changes: row.changes, last_row_id: row.insert_id } };
        }
        return d1Result(query, result);
      });
    }
    if (!isStorage(database)) {
      throw new Error('batch() requires ctx.storage, not ctx.storage.sql');
    }
    return database.transactionSync(() =>
      queries.map((query) => this.#executeSql<UnknownRow>(query)),
    );
  }

  async *streamQuery<R>(
    query: CompiledQuery,
    chunkSize: number,
  ): AsyncIterableIterator<QueryResult<R>> {
    // A chunk size below 1 would loop forever.
    if (!Number.isSafeInteger(chunkSize) || chunkSize < 1) {
      throw new RangeError('Stream chunk size must be a positive integer');
    }
    // Neither binding has a streaming cursor, so chunk the full result.
    const result = await this.executeQuery<R>(query);
    for (let offset = 0; offset < result.rows.length; offset += chunkSize) {
      yield { rows: result.rows.slice(offset, offset + chunkSize) };
    }
  }

  #prepare(database: D1DatabaseLike, query: CompiledQuery) {
    const statement = database.prepare(query.sql);
    return query.parameters.length
      ? statement.bind(...query.parameters.map(normalizeParameter))
      : statement;
  }

  #executeSql<R>(query: CompiledQuery): QueryResult<R> {
    const sql = isStorage(this.database) ? this.database.sql : (this.database as SqlStorageLike);
    const cursor = sql.exec(query.sql, ...query.parameters.map(normalizeParameter));
    // The cursor runs lazily; rowsWritten is final only once it's consumed.
    const rows = cursor.toArray() as R[];
    if (!isMutation(query) && cursor.rowsWritten === 0) return { rows };
    const [meta] = sql.exec(CHANGES_SQL).toArray();
    const changes = BigInt(meta!.changes as number);
    return {
      rows,
      numAffectedRows: changes,
      insertId:
        InsertQueryNode.is(query.query) && changes > 0n
          ? BigInt(meta!.insert_id as number)
          : undefined,
    };
  }
}
