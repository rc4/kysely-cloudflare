import type { DatabaseConnection } from 'kysely';

/** A query parameter after conversion to a type both bindings accept. */
export type SqlValue = string | number | null | ArrayBuffer;

/** The fields of a D1 result that the dialect reads. */
export interface D1ResultLike<T = unknown> {
  results: T[];
  meta: { changes: number; last_row_id: number };
}

/** The D1 prepared-statement methods the dialect calls. */
export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  all<T = Record<string, unknown>>(): Promise<D1ResultLike<T>>;
}

/**
 * The D1 methods the dialect calls. Matches `D1Database` and
 * `D1DatabaseSession`.
 */
export interface D1DatabaseLike {
  prepare(sql: string): D1PreparedStatementLike;
  batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]>;
}

/** The `SqlStorageCursor` members the dialect reads. */
export interface SqlStorageCursorLike {
  toArray(): Record<string, unknown>[];
  readonly rowsWritten: number;
}

/** Durable Object `SqlStorage` (`ctx.storage.sql`). */
export interface SqlStorageLike {
  exec(sql: string, ...bindings: SqlValue[]): SqlStorageCursorLike;
}

/** Durable Object storage (`ctx.storage`). */
export interface DurableObjectStorageLike {
  readonly sql: SqlStorageLike;
  transaction<T>(callback: () => Promise<T>): Promise<T>;
  transactionSync<T>(callback: () => T): T;
}

/** A D1 database or session, `ctx.storage`, or `ctx.storage.sql`. */
export type CloudflareDatabase = D1DatabaseLike | DurableObjectStorageLike | SqlStorageLike;

export interface CloudflareDialectConfig<T extends CloudflareDatabase = CloudflareDatabase> {
  /** The binding, or a function that returns it. The function runs on first use. */
  database: T | (() => T | Promise<T>);
  /**
   * Runs once before the first query, e.g. to set PRAGMAs.
   *
   * Query through `connection`. Querying `db` here deadlocks, because `db`
   * waits for this hook to finish.
   */
  onCreateConnection?: (connection: DatabaseConnection) => void | Promise<void>;
}
