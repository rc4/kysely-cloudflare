import {
  sql,
  type DatabaseIntrospector,
  type DatabaseMetadataOptions,
  type Kysely,
  type TableMetadata,
} from 'kysely';
import { DEFAULT_MIGRATION_LOCK_TABLE, DEFAULT_MIGRATION_TABLE } from 'kysely/migration';

interface ColumnInfo {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
  hidden: number;
}

/**
 * Kysely's SqliteIntrospector uses table-valued PRAGMA functions, which D1
 * doesn't support, so this runs the PRAGMA statements per table instead.
 */
export class CloudflareIntrospector implements DatabaseIntrospector {
  readonly #db: Kysely<any>;

  constructor(db: Kysely<any>) {
    this.#db = db.withoutPlugins();
  }

  async getSchemas() {
    return [];
  }

  async getTables(options?: DatabaseMetadataOptions): Promise<TableMetadata[]> {
    // Skip SQLite's internal tables and Cloudflare's `_cf_` tables.
    const { rows } = await sql<{ name: string; type: string }>`
      select name, type from sqlite_master
      where type in ('table', 'view') and substr(name, 1, 7) != 'sqlite_' and substr(name, 1, 4) != '_cf_'
      order by name`.execute(this.#db);
    const tables: TableMetadata[] = [];
    for (const row of rows) {
      if (
        !options?.withInternalKyselyTables
        && (row.name === DEFAULT_MIGRATION_TABLE || row.name === DEFAULT_MIGRATION_LOCK_TABLE)
      ) {
        continue;
      }
      // PRAGMA arguments can't be bound parameters.
      const name = row.name.replaceAll("'", "''");
      // oxlint-disable-next-line no-await-in-loop -- the driver serializes queries anyway
      const { rows: columns } = await sql
        .raw<ColumnInfo>(`pragma table_xinfo('${name}')`)
        .execute(this.#db);
      // Only a single INTEGER primary key aliases the rowid, and so autoincrements.
      const primaryKey = columns.filter((column) => column.pk > 0);
      let rowidAlias =
        row.type === 'table'
        && primaryKey.length === 1
        && primaryKey[0]!.type.toLowerCase() === 'integer';
      if (rowidAlias) {
        // Exceptions (`primary key desc`, WITHOUT ROWID) get a primary-key index.
        // oxlint-disable-next-line no-await-in-loop
        const { rows: indexes } = await sql
          .raw<{ origin: string }>(`pragma index_list('${name}')`)
          .execute(this.#db);
        rowidAlias = !indexes.some((index) => index.origin === 'pk');
      }
      tables.push({
        name: row.name,
        isView: row.type === 'view',
        isForeign: false,
        columns: columns
          .filter((column) => column.hidden !== 1)
          .map((column) => ({
            name: column.name,
            dataType: column.type,
            isNullable: !column.notnull && !(rowidAlias && column.pk > 0),
            isAutoIncrementing: rowidAlias && column.pk > 0,
            // hidden is 2 or 3 for generated columns, which can't be inserted.
            hasDefaultValue: column.dflt_value !== null || column.hidden > 1,
          })),
      });
    }
    return tables;
  }
}
