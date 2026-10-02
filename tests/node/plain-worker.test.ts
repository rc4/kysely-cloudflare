import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { expect, test } from 'vitest';

test('standalone D1 and Durable Object Workers do not require nodejs_compat', async () => {
  const { outputFiles } = await build({
    entryPoints: ['tests/workers/plain-worker.ts'],
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'browser',
    external: ['cloudflare:workers'],
  });
  const mf = new Miniflare({
    workers: [
      {
        config: {
          name: 'plain-worker',
          compatibilityDate: '2026-10-01',
          manifest: {
            mainModule: 'index.js',
            modules: { 'index.js': { type: 'esm', contents: outputFiles[0]!.text } },
          },
          env: {
            DB: { type: 'd1', id: 'plain-db' },
            OBJECTS: { type: 'durable-object', worker: 'plain-worker', exportName: 'PlainObject' },
          },
          exports: { PlainObject: { type: 'durable-object', storage: 'sqlite' } },
        },
      },
    ],
  });
  try {
    const d1 = await mf.dispatchFetch('http://localhost/d1');
    expect(d1.status).toBe(200);
    expect(await d1.json()).toEqual({ rows: [{ name: 'King Kibby' }], tables: ['cats'] });
    const object = await mf.dispatchFetch('http://localhost/object');
    expect(object.status).toBe(200);
    expect(await object.json()).toEqual({
      rows: [{ name: 'King Kibby' }, { name: 'Queen Eleanor' }],
      tables: ['cats'],
    });
  } finally {
    await mf.dispose();
  }
});
