/**
 * The Worker's own half of the wire contract: path validation, method, and
 * which token each route accepts (`apps/log-server/specs/server.md` § 5).
 *
 * Every request here goes through `SELF`, the real Worker running in the real
 * Workers runtime with the real Durable Object binding behind it — the
 * refusals below are the ones a deployed copy gives, not a stand-in's.
 */

import { SELF } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

const INGEST = 'ingest-token-for-tests'
const READ = 'read-token-for-tests'
const BASE = 'https://log.example.com'
const REPO = 'atta-labs/worker-suite'

function url(path: string, repo = REPO): string {
  return `${BASE}/v1/repos/${repo}/${path}`
}

function bearer(token: string): HeadersInit {
  return { authorization: `Bearer ${token}` }
}

describe('the Workers runtime harness', () => {
  it('runs the Worker with a live SQLite-backed Durable Object behind it', async () => {
    const response = await SELF.fetch(url('events'), {
      method: 'POST',
      headers: { ...bearer(INGEST), 'content-type': 'application/x-ndjson' },
      body: ''
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ accepted: 0, duplicates: 0, rejected: 0, last_seq: 0 })
  })
})

describe('each route accepts its own token and no other', () => {
  const ingest = (headers: HeadersInit = {}) => SELF.fetch(url('events'), { method: 'POST', headers, body: '' })

  it('refuses the ingest route without a token, with the wrong one, or with the read token', async () => {
    expect((await ingest()).status).toBe(401)
    expect((await ingest(bearer('not-the-token'))).status).toBe(401)
    expect((await ingest(bearer(READ))).status).toBe(401)
    expect((await ingest({ authorization: INGEST })).status).toBe(401)
  })

  it('refuses the read route without a token, with the wrong one, or with the ingest token', async () => {
    expect((await SELF.fetch(url('events'))).status).toBe(401)
    expect((await SELF.fetch(url('events'), { headers: bearer('not-the-token') })).status).toBe(401)
    expect((await SELF.fetch(url('events'), { headers: bearer(INGEST) })).status).toBe(401)
    expect((await SELF.fetch(url('events'), { headers: bearer(READ) })).status).toBe(200)
  })

  it('refuses the stats route without a token, with the wrong one, or with the ingest token', async () => {
    expect((await SELF.fetch(url('stats'))).status).toBe(401)
    expect((await SELF.fetch(url('stats'), { headers: bearer('not-the-token') })).status).toBe(401)
    expect((await SELF.fetch(url('stats'), { headers: bearer(INGEST) })).status).toBe(401)
    expect((await SELF.fetch(url('stats'), { headers: bearer(READ) })).status).toBe(200)
  })

  it('never echoes a token back in a refusal', async () => {
    const response = await ingest(bearer(READ))
    const body = await response.text()

    expect(body).not.toContain(READ)
    expect(body).not.toContain(INGEST)
  })
})

describe('the path and method grammar', () => {
  it('refuses a repository segment outside [A-Za-z0-9._-]', async () => {
    expect((await SELF.fetch(url('stats', 'atta labs/vinaya'), { headers: bearer(READ) })).status).toBe(400)
    expect((await SELF.fetch(url('stats', 'atta-labs/vin~aya'), { headers: bearer(READ) })).status).toBe(400)
  })

  it('accepts the dots, dashes and underscores a real repository name uses', async () => {
    const response = await SELF.fetch(url('stats', 'atta_labs.dev/vinaya-2.0'), { headers: bearer(READ) })
    expect(response.status).toBe(200)
  })

  it('answers 404 for an unknown path, including the live route it does not serve yet', async () => {
    expect((await SELF.fetch(url('nonsense'), { headers: bearer(READ) })).status).toBe(404)
    expect((await SELF.fetch(url('live'), { headers: bearer(READ) })).status).toBe(404)
    expect((await SELF.fetch(`${BASE}/`, { headers: bearer(READ) })).status).toBe(404)
    expect((await SELF.fetch(`${BASE}/v1/repos/atta-labs/events`, { headers: bearer(READ) })).status).toBe(404)
  })

  it('answers 405 for a known path with the wrong method', async () => {
    expect((await SELF.fetch(url('events'), { method: 'PUT', headers: bearer(INGEST) })).status).toBe(405)
    expect((await SELF.fetch(url('stats'), { method: 'POST', headers: bearer(READ) })).status).toBe(405)
  })
})
