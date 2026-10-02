import type { CompiledQuery, Kysely, QueryResult } from 'kysely';
import { CloudflareConnection } from './connection';

/** The result of each query passed to {@link batch}, in the same order. */
export type BatchResults<T extends readonly CompiledQuery[]> = {
  [K in keyof T]: T[K] extends CompiledQuery<infer R> ? QueryResult<R> : never;
};

/**
 * Runs compiled queries atomically: in one D1 batch, or in one synchronous
 * Durable Object transaction.
 *
 * Result plugins run after the batch commits, so a plugin that throws can't
 * undo the batch unless it ran inside a transaction. The batch's statements
 * also don't appear in Kysely's query log.
 *
 * @example
 *
 * ```ts
 * const [inserted, cats] = await batch(db, [
 *   db
 *     .insertInto('cat')
 *     .values({ name: 'Kibby' })
 *     .returning('id')
 *     .compile(),
 *   db.selectFrom('cat').selectAll().compile(),
 * ] as const);
 * ```
 *
 * @param db - The Kysely instance that compiled the queries.
 * @param queries - Queries from `.compile()`, or `.compile(db)` for raw SQL.
 */
export async function batch<T extends readonly CompiledQuery[]>(
  db: Kysely<any>,
  queries: T,
): Promise<BatchResults<T>> {
  const executor = db.getExecutor();
  const results = await executor.provideConnection(async (connection) => {
    if (!(connection instanceof CloudflareConnection)) {
      throw new TypeError('batch() requires a kysely-cloudflare dialect');
    }
    return connection.executeBatch(queries);
  });
  // Run plugins after releasing the connection, as Kysely does, so they can
  // query db.
  const transformed = await Promise.all(
    results.map(async (result, index) => {
      for (const plugin of executor.plugins) {
        // oxlint-disable-next-line no-await-in-loop -- plugins run in order
        result = await plugin.transformResult({ queryId: queries[index]!.queryId, result });
      }
      return result;
    }),
  );
  return transformed as BatchResults<T>;
}
