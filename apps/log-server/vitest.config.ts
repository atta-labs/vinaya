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
