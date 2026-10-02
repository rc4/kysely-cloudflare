# kysely-cloudflare

A [Kysely](https://kysely.dev) dialect for [Cloudflare D1](https://developers.cloudflare.com/d1/) and [SQLite-backed Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/). Pass either binding to `CloudflareDialect`.

## Why another package?

I use both D1 and Durable Objects, and didn't want to maintain two nearly identical packages. Writing this one was faster than auditing the community alternatives. See [XKCD 927](https://xkcd.com/927/).

## Install

```sh
pnpm add kysely kysely-cloudflare
```

Requires Kysely `^0.29.6`. It runs in Workers without `nodejs_compat`, and in Node 22.12 or newer.

## D1

```ts
import { Kysely, type Generated } from 'kysely';
import { CloudflareDialect } from 'kysely-cloudflare';

interface Database {
  cat: { id: Generated<number>; name: string };
}

const db = new Kysely<Database>({
  dialect: new CloudflareDialect({ database: env.DB }),
});

const cat = await db
  .insertInto('cat')
  .values({ name: 'Kibby' })
  .returningAll()
  .executeTakeFirstOrThrow();
```

You can also pass a D1 session, such as `env.DB.withSession('first-primary')`. The dialect doesn't track session bookmarks for you.

## Durable Objects

```ts
import { DurableObject } from 'cloudflare:workers';
import { Kysely, type Generated } from 'kysely';
import { DurableObjectDialect } from 'kysely-cloudflare';

interface Database {
  cat: { id: Generated<number>; name: string };
}

export class Cats extends DurableObject {
  readonly db = new Kysely<Database>({
    dialect: new DurableObjectDialect({ database: this.ctx.storage }),
  });

  async addCat(name: string) {
    return this.db.insertInto('cat').values({ name }).returningAll().executeTakeFirstOrThrow();
  }
}
```

Pass `this.ctx.storage` if you need transactions or `batch()`. Passing `this.ctx.storage.sql` also works, just without those two.

If you want TypeScript to catch a mixed-up binding, use `D1Dialect` or `DurableObjectDialect`. They work like `CloudflareDialect`, but each accepts only its own kind of binding.

## Functionality

Queries compile with Kysely's SQLite compiler. Other features depend on the binding:

| Feature                                             | D1 or D1 session | `ctx.storage` | `ctx.storage.sql` |
| --------------------------------------------------- | ---------------- | ------------- | ----------------- |
| Queries, schema, plugins, introspection, migrations | Yes              | Yes           | Yes               |
| Atomic `batch()`                                    | Yes              | Yes           | No                |
| `transaction()` and `startTransaction()`            | No               | Yes           | No                |
| Transactional migrations                            | No               | Yes           | No                |

Neither binding can stream results, so `stream()` loads the whole result and then yields it in chunks. Aborting a query stops Kysely from waiting for it, but the query still finishes on the binding.

### Results and parameters

For queries built with Kysely, affected-row counts don't include rows written by triggers. The bindings' own counts (D1's `meta.changes` and Durable Objects' `rowsWritten`) do, so the dialect asks SQLite's `changes()` instead. On D1, that means each insert, update, or delete runs in a batch with one extra statement. Raw SQL on D1 gets D1's own count.

`insertId` is only set for queries built with `insertInto()`, not for raw SQL.

Parameters can be strings, numbers, `null`, booleans (stored as `0` or `1`), bigints within the safe integer range, or binary data (`ArrayBuffer`, `Uint8Array`, `DataView`, or Node `Buffer`). Anything else throws, including dates, `undefined`, `NaN`, and `Infinity`. Results come back exactly as the binding returns them.

### Transactions

With `ctx.storage`, you can use both `db.transaction()` and `db.startTransaction()`:

```ts
await db.transaction().execute(async (trx) => {
  await trx.insertInto('cat').values({ name: 'Eleanor' }).execute();
  await trx.insertInto('cat').values({ name: 'Jane' }).execute();
});
```

Create one Kysely instance per Durable Object. The dialect makes its own queries wait for an open transaction to finish, but queries from another instance, or direct calls on `ctx.storage`, don't wait: they run inside the transaction.

You can leave the isolation level unset or set it to `serializable`. Other isolation levels, access modes, and savepoints aren't supported.

If a transaction fails to start inside `db.connection()`, you can keep using that connection.

### Atomic batches

```ts
import { batch } from 'kysely-cloudflare';

const [inserted, selected] = await batch(db, [
  db.insertInto('cat').values({ name: 'Kibby' }).returning('id').compile(),
  db.selectFrom('cat').selectAll().compile(),
] as const);
```

Build the queries from the same `db` you pass to `batch()` so its plugins apply, and compile raw SQL with `.compile(db)`. You get back one `QueryResult` per query, in order.

Result plugins run after the batch commits, so a plugin that throws can't undo the batch unless it ran inside a transaction. The batch's statements also don't appear in Kysely's query log.

### Migrations

Kysely's `Migrator` (from `kysely/migration`) works as usual. It holds a lock in the database while it runs, so a second migrator started at the same time fails instead of waiting.

With `ctx.storage`, each run happens in one transaction. D1 and `ctx.storage.sql` don't have transactions, so a migration that fails partway through can leave some of its schema changes behind. If a migrator crashes while holding the lock, check the migration state before setting `kysely_migration_lock.is_locked` back to `0`.

## Connection setup and Node usage

```ts
import { CompiledQuery } from 'kysely';

const dialect = new CloudflareDialect({
  database: async () => databaseBinding,
  onCreateConnection: async (connection) => {
    await connection.executeQuery(CompiledQuery.raw('PRAGMA foreign_keys = ON'));
  },
});
```

`database` can also be a function, which runs before the first query. If it or `onCreateConnection` throws, the next query tries again. Inside the hook, run queries through `connection`: querying `db` there deadlocks.

`db.destroy()` rolls back any open transaction. There's nothing else to close.

To use the dialect in Node, get a binding from Miniflare, such as `await mf.getD1Database('DB')`.

## Development

```sh
pnpm install
pnpm check # typecheck, lint, format check, tests, build
```

You don't need a Cloudflare account to run the tests. They run against D1 and Durable Object storage in `workerd`, and in Node against Miniflare's D1 and a `node:sqlite` stand-in for Durable Object storage.

## License

Released under the [Artistic License 2.0](LICENSE).
