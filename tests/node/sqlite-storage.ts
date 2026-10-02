import { DatabaseSync } from 'node:sqlite';
import type { DurableObjectStorageLike, SqlStorageLike } from '../../src';

/** SQLite fixture for exercising the dialect in Node. */
export class SQLiteStorage implements DurableObjectStorageLike {
  readonly database = new DatabaseSync(':memory:');
  readonly sql: SqlStorageLike = {
    exec: (query, ...bindings) => {
      const stmt = this.database.prepare(query);
      const parameters = bindings.map((value) =>
        value instanceof ArrayBuffer ? new Uint8Array(value) : value,
      );
      let rows: Record<string, unknown>[] = [];
      let rowsWritten = 0;
      if (stmt.columns().length) {
        rows = stmt.all(...parameters);
      } else {
        rowsWritten = Number(stmt.run(...parameters).changes);
      }
      return { rowsWritten, toArray: () => rows };
    },
  };

  async transaction<T>(callback: () => Promise<T>): Promise<T> {
    this.database.exec('begin');
    try {
      const result = await callback();
      this.database.exec('commit');
      return result;
    } catch (error) {
      this.database.exec('rollback');
      throw error;
    }
  }

  transactionSync<T>(callback: () => T): T {
    this.database.exec('savepoint batch');
    try {
      const result = callback();
      this.database.exec('release batch');
      return result;
    } catch (error) {
      this.database.exec('rollback to batch; release batch');
      throw error;
    }
  }
}
