/**
 * The Worker's own half of the wire contract: path validation, method,
 * and which token each route accepts (`apps/log-server/specs/server.md` § 5).
 *
 * Every request here goes through `SELF`, the real Worker running in the real
 * Workers runtime with the real Durable Object binding behind it — the
 * refusals below are the ones a deployed copy gives, not a stand-in's.
 */

import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const INGEST = 'ingest-token-for-tests'
const BASE = 'https://log.example.com'

function ingestUrl(repo = 'atta-labs/vinaya'): string {
  return `${BASE}/v1/repos/${repo}/events`
}

describe('the Workers runtime harness', () => {
  it('runs the Worker with a live SQLite-backed Durable Object behind it', async () => {
    const response = await SELF.fetch(ingestUrl(), {
      method: 'POST',
      headers: { authorization: `Bearer ${INGEST}`, 'content-type': 'application/x-ndjson' },
      body: ''
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ accepted: 0, duplicates: 0, rejected: 0, last_seq: 0 })
  })
})
