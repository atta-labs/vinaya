import { describe, expect, it } from 'bun:test'
import {
  buildSelftestLine,
  LOG_SELFTEST_OPERATION,
  type LogSelftestDeps,
  logSelftestCommand,
  runLogSelftest,
  type SelftestReadPage
} from '../../src/commands/log-selftest.js'

// The self-test is proved against injected seams, not a live server: every
// FAIL reason and the one PASS are a decision over `resolveDestination` /
// `post` / `read`, so each is reproducible on Linux CI with no network. The
// real HTTP wiring (`realLogSelftestDeps`) is a thin `fetch` shell over these
// same seams.

const SECRET = 'super-secret-token-value-abc123'
const NONCE = 'nonce-fixed-1'

/** A page holding one event whose id is `NONCE` — what a healthy read-back returns. */
function pageWithEvent(): SelftestReadPage {
  return {
    kind: 'accepted',
    status: 200,
    nextAfter: 6,
    events: [{ seq: 6, status: 'stored', event: { meta: { event_id: NONCE } } }]
  }
}

function deps(overrides: Partial<LogSelftestDeps> = {}): { deps: LogSelftestDeps; out: string[]; err: string[] } {
  const out: string[] = []
  const err: string[] = []
  const base: LogSelftestDeps = {
    resolveDestination: async () => ({
      kind: 'server',
      url: 'https://logs.example.com/v1/repos/acme/widget/events',
      headers: { authorization: `Bearer ${SECRET}` }
    }),
    resolveServerSetting: async () => ({
      url: 'https://logs.example.com/v1/repos/acme/widget/events',
      headers: { authorization: 'Bearer ${VINAYA_LOG_TOKEN}' }
    }),
    readReadHeaders: () => ({ authorization: 'Bearer ${VINAYA_LOG_READ_TOKEN}' }),
    resolveHeaders: () => ({ authorization: `Bearer ${SECRET}` }),
    // The macOS-Keychain fallback is a no-op by default here (Linux CI has no
    // Keychain); the O2 case below overrides it to prove a token held only in
    // the Keychain is counted as present.
    readKeychain: () => null,
    readLastSeq: async () => ({ kind: 'accepted', status: 200, lastSeq: 5 }),
    post: async () => ({ kind: 'accepted', status: 200 }),
    read: async () => pageWithEvent(),
    buildLine: () => `{"meta":{"event_id":"${NONCE}"}}\n`,
    env: { VINAYA_LOG_TOKEN: SECRET, VINAYA_LOG_READ_TOKEN: SECRET },
    newNonce: () => NONCE,
    maxPages: 20,
    stdout: (t) => out.push(t),
    stderr: (t) => err.push(t)
  }
  return { deps: { ...base, ...overrides }, out, err }
}

describe('vinaya log selftest — the end-to-end round-trip (O1)', () => {
  it('PASS when the marked event is sent and read back by its own id', async () => {
    const { deps: d } = deps()
    const result = await runLogSelftest(d)
    expect(result).toEqual({ pass: true })
  })

  it('exit 0 on PASS, and prints PASS on stdout', async () => {
    const { deps: d, out, err } = deps()
    const code = await logSelftestCommand([], d)
    expect(code).toBe(0)
    expect(out.join('')).toContain('PASS')
    expect(err.join('')).toBe('')
  })

  it('exit 1 on FAIL, and prints one reason on stderr', async () => {
    const {
      deps: d,
      out,
      err
    } = deps({
      resolveDestination: async () => ({ kind: 'none', reason: 'no server destination is configured for CI delivery' })
    })
    const code = await logSelftestCommand([], d)
    expect(code).toBe(1)
    expect(out.join('')).toBe('')
    expect(err.join('')).toContain('FAIL:')
    expect(err.join('')).toContain('no server destination is configured')
  })
})

describe('vinaya log selftest — each FAIL names the one reason that stopped it (O1)', () => {
  it("'none' destination reports its own reason", async () => {
    const { deps: d } = deps({
      resolveDestination: async () => ({ kind: 'none', reason: 'this job holds no delivery credential' })
    })
    expect(await runLogSelftest(d)).toEqual({ pass: false, reason: 'this job holds no delivery credential' })
  })

  it('a folder with no fallback reason means no server is configured', async () => {
    const { deps: d } = deps({ resolveDestination: async () => ({ kind: 'folder', folder: '/tmp/logs' }) })
    const result = await runLogSelftest(d)
    expect(result.pass).toBe(false)
    if (!result.pass) expect(result.reason).toContain('no log server is configured')
  })

  it('an anchor-unreadable fallback reports the default branch could not be read', async () => {
    const { deps: d } = deps({
      resolveDestination: async () => ({
        kind: 'folder',
        folder: '/tmp/logs',
        fallbackReason: { kind: 'anchor-unreadable', intendedUrl: 'https://logs.example.com/x' }
      })
    })
    const result = await runLogSelftest(d)
    expect(result.pass).toBe(false)
    if (!result.pass) {
      expect(result.reason).toContain("default branch's")
      expect(result.reason).toContain('could not be read')
    }
  })

  it('an anchor-mismatch fallback reports the working-tree url is not declared', async () => {
    const { deps: d } = deps({
      resolveDestination: async () => ({
        kind: 'folder',
        folder: '/tmp/logs',
        fallbackReason: { kind: 'anchor-mismatch', intendedUrl: 'https://logs.example.com/x' }
      })
    })
    const result = await runLogSelftest(d)
    expect(result.pass).toBe(false)
    if (!result.pass) expect(result.reason).toContain('does not declare it')
  })

  it('a missing ingest credential is named before any send, by variable, never by value', async () => {
    const { deps: d } = deps({ env: { VINAYA_LOG_READ_TOKEN: SECRET } }) // VINAYA_LOG_TOKEN unset
    const result = await runLogSelftest(d)
    expect(result.pass).toBe(false)
    if (!result.pass) {
      expect(result.reason).toContain('no ingest credential')
      expect(result.reason).toContain('VINAYA_LOG_TOKEN')
      expect(result.reason).not.toContain(SECRET)
    }
  })

  it('O2: the ingest credential check passes when the token is absent from the environment but held in the Keychain', async () => {
    // The exact shape of the Principal's macOS box: `vinaya log set-credential
    // VINAYA_LOG_TOKEN` stored the ingest token in the login Keychain, and the
    // variable is unset in the environment. Before #880 this failed the check;
    // now the fallback reader supplies it, so the self-test proceeds to a real
    // send and round-trips to PASS.
    const { deps: d } = deps({
      env: { VINAYA_LOG_READ_TOKEN: SECRET }, // VINAYA_LOG_TOKEN unset in the environment
      readKeychain: (name) => (name === 'VINAYA_LOG_TOKEN' ? SECRET : null)
    })
    expect(await runLogSelftest(d)).toEqual({ pass: true })
  })

  it('O2: still FAILs, naming the variable, when the token is in neither the environment nor the Keychain', async () => {
    const { deps: d } = deps({
      env: { VINAYA_LOG_READ_TOKEN: SECRET }, // VINAYA_LOG_TOKEN unset
      readKeychain: () => null // and the Keychain holds nothing either
    })
    const result = await runLogSelftest(d)
    expect(result.pass).toBe(false)
    if (!result.pass) {
      expect(result.reason).toContain('no ingest credential')
      expect(result.reason).toContain('VINAYA_LOG_TOKEN')
    }
  })

  it('a missing readHeaders config is a distinct reason', async () => {
    const { deps: d } = deps({ readReadHeaders: () => undefined })
    const result = await runLogSelftest(d)
    expect(result.pass).toBe(false)
    if (!result.pass) expect(result.reason).toContain('no read credential is configured')
  })

  it('a configured-but-unset read credential is named by variable', async () => {
    const { deps: d } = deps({ env: { VINAYA_LOG_TOKEN: SECRET } }) // read token unset
    const result = await runLogSelftest(d)
    expect(result.pass).toBe(false)
    if (!result.pass) {
      expect(result.reason).toContain('VINAYA_LOG_READ_TOKEN')
      expect(result.reason).not.toContain(SECRET)
    }
  })

  it('a server refusing the send is reported with its status', async () => {
    const { deps: d } = deps({ post: async () => ({ kind: 'status', status: 401 }) })
    const result = await runLogSelftest(d)
    expect(result.pass).toBe(false)
    if (!result.pass) {
      expect(result.reason).toContain('refused the test event')
      expect(result.reason).toContain('401')
    }
  })

  it('a server refusing the read credential is reported with its status', async () => {
    const { deps: d } = deps({ read: async () => ({ kind: 'status', status: 403 }) })
    const result = await runLogSelftest(d)
    expect(result.pass).toBe(false)
    if (!result.pass) {
      expect(result.reason).toContain('read route')
      expect(result.reason).toContain('403')
    }
  })

  it('the event delivered but not read back is its own reason', async () => {
    // The read is caught up (no new cursor) and the event is not on the page.
    const { deps: d } = deps({
      read: async (_url, _headers, after) => ({ kind: 'accepted', status: 200, nextAfter: after, events: [] })
    })
    const result = await runLogSelftest(d)
    expect(result.pass).toBe(false)
    if (!result.pass) expect(result.reason).toContain('could not be read back')
  })

  it('an unreachable server on the stats route is reported, not treated as found', async () => {
    const { deps: d } = deps({ readLastSeq: async () => ({ kind: 'network', detail: 'ECONNREFUSED' }) })
    const result = await runLogSelftest(d)
    expect(result.pass).toBe(false)
    if (!result.pass) expect(result.reason).toContain('could not be reached')
  })
})

describe('vinaya log selftest — read-back pages until it finds the event (Traps)', () => {
  it('walks `after=` forward across pages until the event appears', async () => {
    const seen: number[] = []
    const { deps: d } = deps({
      readLastSeq: async () => ({ kind: 'accepted', status: 200, lastSeq: 0 }),
      read: async (_url, _headers, after) => {
        seen.push(after)
        // Two empty-but-advancing pages, then the event on the third.
        if (after < 2) return { kind: 'accepted', status: 200, nextAfter: after + 1, events: [] }
        return pageWithEvent()
      }
    })
    const result = await runLogSelftest(d)
    expect(result).toEqual({ pass: true })
    expect(seen).toEqual([0, 1, 2])
  })

  it('stops at the page bound rather than looping forever', async () => {
    let calls = 0
    const { deps: d } = deps({
      maxPages: 3,
      readLastSeq: async () => ({ kind: 'accepted', status: 200, lastSeq: 0 }),
      read: async (_url, _headers, after) => {
        calls++
        return { kind: 'accepted', status: 200, nextAfter: after + 1, events: [] }
      }
    })
    const result = await runLogSelftest(d)
    expect(result.pass).toBe(false)
    expect(calls).toBe(3)
  })
})

describe('vinaya log selftest — never prints a credential (O2)', () => {
  it('no reason or output carries the token value, on PASS or FAIL', async () => {
    for (const override of [
      {},
      { post: async () => ({ kind: 'status' as const, status: 401 }) },
      { env: { VINAYA_LOG_READ_TOKEN: SECRET } }
    ]) {
      const { deps: d, out, err } = deps(override)
      await logSelftestCommand([], d)
      expect(out.join('')).not.toContain(SECRET)
      expect(err.join('')).not.toContain(SECRET)
    }
  })
})

describe('buildSelftestLine — a schema-valid marked event carrying its own id', () => {
  it('builds a redacted operation/completed line marked log.selftest, with the given event_id', () => {
    const line = buildSelftestLine('my-event-id', 'acme/widget', new Date('2026-01-02T03:04:05.000Z'), 'run-1')
    const parsed = JSON.parse(line) as {
      kind: string
      operation: string
      meta: { event_id: string; schema: number }
    }
    expect(parsed.kind).toBe('operation')
    expect(parsed.operation).toBe(LOG_SELFTEST_OPERATION)
    expect(parsed.meta.event_id).toBe('my-event-id')
    expect(parsed.meta.schema).toBe(3)
    expect(line.endsWith('\n')).toBe(true)
  })
})
