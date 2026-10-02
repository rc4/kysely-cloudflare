import { expectTypeOf } from 'vitest';
import type { Generated, Kysely, QueryResult } from 'kysely';
import { batch } from '../../src';

declare const db: Kysely<{ cat: { id: Generated<number>; name: string } }>;

const results = await batch(db, [
  db.selectFrom('cat').select('name').compile(),
  db.insertInto('cat').values({ name: 'King Kibby' }).returning('id').compile(),
] as const);

expectTypeOf(results).toEqualTypeOf<
  readonly [QueryResult<{ name: string }>, QueryResult<{ id: number }>]
>();
