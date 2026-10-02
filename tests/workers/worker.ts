import { DurableObject } from 'cloudflare:workers';

export class TestObject extends DurableObject {}

export default {
  fetch() {
    return new Response('kysely-cloudflare tests');
  },
};

declare global {
  namespace Cloudflare {
    interface Env {
      DB: D1Database;
      OBJECTS: DurableObjectNamespace<TestObject>;
    }
  }
}
