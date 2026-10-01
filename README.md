# kysely-cloudflare

kysely-cloudflare implements [Kysely](https://kysely.dev) dialects for both
[CloudFlare Durable Objects](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/)
and [CloudFlare D1](https://developers.cloudflare.com/d1/sql-api/sql-statements/), and selects the
correct dialect automatically for you, depending on what you pass in.

## Why another package?

Because I have projects that use both D1 and Durable Objects and I didn't like the idea of needing
to keep track of multiple community-built dependencies that _mostly_ did the same thing. See
[XKCD 927](https://xkcd.com/927/).

I also know that the only way I will ever get a package to my standards is to write it myself ;-)
Specifically, I wanted to ensure satisfactory Vitest test coverage, a release workflow with
provenance, and excellent JSDoc documentation for a good IDE experience, and writing this was fairly
easy, about as easy as just reading through the extant packages in this space.

## License

kysely-cloudflare is released under the terms of the
[Artistic License 2.0](https://perlfoundation.org/artistic-license-20.html).
