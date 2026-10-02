import { DurableObject } from 'cloudflare:workers';
import { Kysely, type Generated } from 'kysely';
import { batch, CloudflareDialect } from '../../src';

interface Database {
  cats: { id: Generated<number>; name: string };
}

async function exercise(db: Kysely<Database>, transaction: boolean) {
  await db.schema
    .createTable('cats')
    .ifNotExists()
    .addColumn('id', 'integer', (col) => col.primaryKey().autoIncrement())
    .addColumn('name', 'text')
    .execute();
  await batch(db, [db.insertInto('cats').values({ name: 'King Kibby' }).compile()]);
  if (transaction) {
    await db.transaction().execute(async (trx) => {
      await trx.insertInto('cats').values({ name: 'Queen Eleanor' }).execute();
    });
  }
  const rows = await db.selectFrom('cats').select('name').orderBy('name').execute();
  const tables = await db.introspection.getTables();
  return { rows, tables: tables.map((table) => table.name) };
}

export class PlainObject extends DurableObject {
  readonly db = new Kysely<Database>({
    dialect: new CloudflareDialect({ database: this.ctx.storage }),
  });

  async fetch() {
    return Response.json(await exercise(this.db, true));
  }
}

export default {
  async fetch(request: Request, env: { DB: D1Database; OBJECTS: DurableObjectNamespace }) {
    if (new URL(request.url).pathname === '/object') {
      return env.OBJECTS.get(env.OBJECTS.newUniqueId()).fetch(request);
    }
    const db = new Kysely<Database>({ dialect: new CloudflareDialect({ database: env.DB }) });
    try {
      return Response.json(await exercise(db, false));
    } finally {
      await db.destroy();
    }
  },
};
