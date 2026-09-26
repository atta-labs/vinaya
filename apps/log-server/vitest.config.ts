/**
 * The tests run inside the real Workers runtime — Cloudflare's Vitest pool
 * boots `workerd` with this package's own `wrangler.jsonc`, so the Durable
 * Object under test is a real SQLite-backed object and not a hand-written
 * imitation of one (`apps/log-server/specs/server.md` § 7).
 *
 * The two secrets are supplied here as bindings: a deployed copy holds them
 * as Worker secrets (`wrangler secret put`), which a test environment has no
 * way to read.
 */

import { defineWorkersConfig } from '@cloudflare/vitest-pool-workers/config'

export default defineWorkersConfig({
  test: {
    include: ['src/**/*.test.ts'],
    poolOptions: {
      workers: {
        // The pool's per-test storage stack cannot pop a SQLite-backed
        // Durable Object's directory — it asserts every file it finds is a
        // `.sqlite`, and SQLite's own `-shm` sidecar file trips it, so the
        // run ends in `Isolated storage failed` whatever the test did. The
        // tests isolate through the product's own boundary instead: one
        // repository is one object, so a test that wants a clean log asks
        // for a repository name no other test used.
        isolatedStorage: false,
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            INGEST_TOKEN: 'ingest-token-for-tests',
            READ_TOKEN: 'read-token-for-tests'
          }
        }
      }
    }
  }
})
